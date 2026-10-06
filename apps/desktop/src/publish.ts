/**
 * Publishing a note set as a callout pack — TODO.md M8 steps 3 and 3b.
 *
 * The editor's note set is what gets published, as its next version. The first
 * publish creates the content item; later ones update its page and add a
 * version with a changelog: the author's line, plus the note-by-note diff the
 * app works out itself (core/diff.ts). Which local set belongs to which item is
 * kept in the content index, not in the note set (core/content.ts).
 *
 * The server has the final say on everything that matters — ownership, version
 * numbers, refusing a dirty note — so the checks here are for a clear message
 * before the round trip, not for safety.
 */

import { BrowserWindow, dialog, ipcMain, nativeImage, type WebContents } from "electron";

import { describeDiff, diffNoteSets, isEmptyDiff, type NoteSet, type TrackKey } from "@exxeed/core";
import {
  PUBLISH_CHANNEL,
  type PublishFields,
  type PublishRequest,
  type PublishState,
  type Settings,
} from "@exxeed/overlays";
import {
  createCalloutItem,
  getItem,
  getVersionPayload,
  listMedia,
  listVersions,
  LocalContentIndex,
  MAX_SCREENSHOTS,
  removeMedia,
  uploadMedia,
  localRepositories,
  publishVersion,
  saveDraft,
  updateItem,
  withdrawVersion,
} from "@exxeed/repo";

import { accountView, cloudClient } from "./account.js";
import { shareTrack } from "./cloud-sync.js";
import { checkUpdatesNow } from "./library.js";
import {
  addFiles,
  attachments,
  filesChanged,
  forget,
  hasNewFiles,
  removeFile,
  setFileLabel,
  toView,
  uploadForVersion,
} from "./publish-files.js";

interface PublishDeps {
  readonly getSettings: () => Settings;
  readonly resolveDataDir: (settings: Settings) => string;
}

/** A published pack's words, as sent: `published`, whatever the local status says. */
const asPublished = (noteSet: NoteSet): NoteSet => ({ ...noteSet, status: "published" });

async function suggestedFields(dataDir: string, noteSet: NoteSet): Promise<PublishFields> {
  const repos = localRepositories(dataDir);
  const version = await repos.trackMaps.latestVersion(noteSet.trackKey);
  const map = version === null ? null : await repos.trackMaps.get({ ...noteSet.trackKey, mapVersion: version });
  const track = map === null ? `Track ${noteSet.trackKey.trackId}` : `${map.trackName} ${map.configName}`.trim();
  const source =
    noteSet.source.type === "youtube" && noteSet.source.url !== undefined
      ? `\n\nAdapted from [${noteSet.source.title ?? "a track guide"}](${noteSet.source.url})` +
        (noteSet.source.channel === undefined ? "" : ` by ${noteSet.source.channel}`) +
        ". The callouts are rewritten, not transcribed."
      : "";
  return {
    // The name it was given here, if it was: the driver has already said what to call it.
    title: (noteSet.name ?? `${track} · ${noteSet.carClass.toUpperCase()}`).slice(0, 80),
    summary: `${noteSet.notes.length} callouts for ${track}.`.slice(0, 160),
    readme: `Callouts for ${track} in the ${noteSet.carClass.toUpperCase()}.${source}`,
    visibility: "public",
  };
}

async function state(deps: PublishDeps): Promise<PublishState> {
  const settings = deps.getSettings();
  const dataDir = deps.resolveDataDir(settings);
  const noteSet = settings.noteSetId === null ? null : await localRepositories(dataDir).noteSets.get(settings.noteSetId);
  const signedIn = accountView().signedIn;

  if (noteSet === null) {
    return {
      signedIn,
      noteSetId: null,
      dirtyCount: 0,
      noteCount: 0,
      installed: false,
      suggested: { title: "", summary: "", readme: "", visibility: "public" },
      files: [],
      filesChanged: false,
      published: null,
    };
  }

  const link = await new LocalContentIndex(dataDir).get(noteSet.id);
  const client = cloudClient();
  const item = link === null || !signedIn ? null : await getItem(client, link.itemId);
  const files = signedIn ? await attachments(client, noteSet.id, item?.latestVersionId ?? null) : [];
  const base = {
    signedIn,
    noteSetId: noteSet.id,
    dirtyCount: noteSet.notes.filter((n) => n.dirty).length,
    noteCount: noteSet.notes.length,
    installed: link?.origin === "installed",
    suggested: await suggestedFields(dataDir, noteSet),
    files: toView(files),
    filesChanged: filesChanged(noteSet.id),
  };
  if (link === null || item === null) return { ...base, published: null };
  const [versions, media] = await Promise.all([listVersions(client, item.id), listMedia(client, item.id)]);

  // What an installer of the latest version would get if this were published now.
  let changes: string[] = [];
  if (item.latestVersionId !== null) {
    const latest = await getVersionPayload(client, item.latestVersionId);
    if (latest !== null) changes = describeDiff(diffNoteSets(latest, noteSet));
  }

  return {
    ...base,
    published: {
      itemId: item.id,
      fields: { title: item.title, summary: item.summary, readme: item.readme, visibility: item.visibility },
      latestVersion: item.latestVersion,
      localVersion: link.version,
      starCount: item.starCount,
      downloadCount: item.downloadCount,
      versions: versions.map((v) => ({
        id: v.id,
        version: v.version,
        changelog: v.changelog,
        publishedAt: v.publishedAt,
        withdrawn: v.withdrawnAt !== null,
        downloads: v.downloadCount,
      })),
      changes,
      media: media.map((m) => ({ id: m.id, kind: m.kind, url: m.url })),
    },
  };
}

/** Largest side, in pixels: a screenshot at full HD is plenty; an icon is shown at 72. */
const MAX_SIDE = { icon: 256, screenshot: 1920 } as const;
/** The storage bucket's limit (supabase/migrations/…_buckets.sql). */
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * Let the author pick an image, and upload it re-encoded. Decoding and
 * encoding again here is what drops EXIF — a phone photo of a rig carries
 * where it was taken — and what makes the file a plain PNG or JPEG whatever it
 * started as. That protects the uploader, so doing it on their machine is
 * enough; the bucket's type and size limits are the server's half.
 */
async function addMedia(deps: PublishDeps, sender: WebContents, kind: "icon" | "screenshot"): Promise<PublishState> {
  if (!accountView().signedIn) throw new Error("sign in to add images");
  const settings = deps.getSettings();
  const dataDir = deps.resolveDataDir(settings);
  const link = settings.noteSetId === null ? null : await new LocalContentIndex(dataDir).get(settings.noteSetId);
  if (link === null || link.origin !== "mine") throw new Error("publish the pack first, then add images to its page");

  const client = cloudClient();
  if (kind === "screenshot" && (await listMedia(client, link.itemId)).filter((m) => m.kind === "screenshot").length >= MAX_SCREENSHOTS) {
    throw new Error(`a page has at most ${MAX_SCREENSHOTS} screenshots`);
  }

  const picked = await pickImage(sender, kind);
  if (picked === null) return state(deps);
  await uploadMedia(client, link.itemId, kind, picked.bytes, picked.type);
  checkUpdatesNow();
  return state(deps);
}

/**
 * Ask for an image file and re-encode it for a content page: shrunk to the
 * page's size and stripped of whatever metadata it carried. Null when the
 * dialog was cancelled. Shared by callout packs and themes.
 */
export async function pickImage(
  sender: WebContents,
  kind: "icon" | "screenshot",
): Promise<{ bytes: Uint8Array; type: "image/png" | "image/jpeg" } | null> {
  const window = BrowserWindow.fromWebContents(sender);
  const options = {
    title: kind === "icon" ? "Choose an icon" : "Choose a screenshot",
    properties: ["openFile" as const],
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
  };
  const picked = window === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(window, options);
  const path = picked.filePaths[0];
  if (picked.canceled || path === undefined) return null;

  let image = nativeImage.createFromPath(path);
  if (image.isEmpty()) throw new Error("that file is not an image this app can read");
  const { width, height } = image.getSize();
  const scale = Math.min(1, MAX_SIDE[kind] / Math.max(width, height));
  if (scale < 1) image = image.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: "best" });

  let bytes: Uint8Array = kind === "icon" ? image.toPNG() : image.toJPEG(85);
  let type: "image/png" | "image/jpeg" = kind === "icon" ? "image/png" : "image/jpeg";
  if (bytes.byteLength > MAX_BYTES) {
    bytes = image.toJPEG(70);
    type = "image/jpeg";
  }
  if (bytes.byteLength > MAX_BYTES) throw new Error("that image is too large even after shrinking it");
  return { bytes, type };
}

async function deleteMedia(deps: PublishDeps, mediaId: string): Promise<PublishState> {
  const settings = deps.getSettings();
  const link = settings.noteSetId === null ? null : await new LocalContentIndex(deps.resolveDataDir(settings)).get(settings.noteSetId);
  if (link === null || link.origin !== "mine") throw new Error("not your pack");
  const client = cloudClient();
  const media = (await listMedia(client, link.itemId)).find((m) => m.id === mediaId);
  if (media !== undefined) {
    await removeMedia(client, media);
    // The icon column still names the file; clear it so pages fall back to initials.
    if (media.kind === "icon") await client.from("content_items").update({ icon_path: null }).eq("id", link.itemId);
  }
  return state(deps);
}

function checkFields(fields: PublishFields): void {
  const title = fields.title.trim();
  if (title.length < 3 || title.length > 80) throw new Error("a title is 3 to 80 characters");
  if (fields.summary.trim().length > 160) throw new Error("the summary is at most 160 characters");
}

/** A setup's car: the one car in the pack's class, when there is exactly one (the MX-5 cup). */
async function defaultCarFor(dataDir: string, carClass: string): Promise<string | null> {
  const registry = await localRepositories(dataDir).cars.get("iracing").catch(() => null);
  const inClass = Object.entries(registry?.cars ?? {}).filter(([, car]) => car.class === carClass);
  return inClass.length === 1 ? inClass[0]![0] : null;
}

async function publish(
  deps: PublishDeps,
  fields: PublishFields,
  changelog: string,
  filesConfirmed: boolean,
): Promise<PublishState> {
  if (!accountView().signedIn) throw new Error("sign in from the main window to publish");
  checkFields(fields);

  const settings = deps.getSettings();
  const dataDir = deps.resolveDataDir(settings);
  const repos = localRepositories(dataDir);
  if (settings.noteSetId === null) throw new Error("no note set is open");
  const noteSet = await repos.noteSets.get(settings.noteSetId);
  if (noteSet === null) throw new Error(`no note set "${settings.noteSetId}"`);

  const dirty = noteSet.notes.filter((n) => n.dirty).length;
  if (dirty > 0) {
    throw new Error(
      `render the audio first: ${dirty} callout${dirty === 1 ? " has" : "s have"} changed since it was rendered, ` +
        "so the timing others would hear is wrong",
    );
  }
  if (noteSet.notes.length === 0) throw new Error("there are no callouts to publish yet");

  const index = new LocalContentIndex(dataDir);
  const link = await index.get(noteSet.id);
  if (link?.origin === "installed") throw new Error("this is someone else's pack, installed here — it is not yours to publish");
  // Setup shops sell theirs, and a paid setup re-shared is the likeliest
  // takedown this feature will ever see (TODO M8 step 6).
  if (hasNewFiles(noteSet.id) && !filesConfirmed) {
    throw new Error("confirm the attached files are yours to share — a setup bought from a shop is not");
  }

  // The map and reference laps go first: a pack is filed under its track, and
  // installers need the map to see where each callout sits.
  await shareTrack(dataDir, noteSet.trackKey as TrackKey);

  const client = cloudClient();
  const clean = { ...fields, title: fields.title.trim(), summary: fields.summary.trim() };
  let itemId: string;
  if (link === null) {
    const item = await createCalloutItem(client, clean, noteSet.trackKey, noteSet.carClass);
    itemId = item.id;
    // Recorded before the version is, so a failed publish (say, offline)
    // retries against this item rather than creating a second one.
    await index.put(noteSet.id, { itemId, origin: "mine", version: null, versionId: null, policy: "auto" });
  } else {
    itemId = (await updateItem(client, link.itemId, clean)).id;
  }

  const previous = link?.versionId == null ? null : await getVersionPayload(client, link.versionId);
  const diff = previous === null ? null : diffNoteSets(previous, noteSet);

  // Nothing about the callouts or the files changed: the page fields (title,
  // description, visibility) were saved above, and a new version would be a
  // copy of the last with nothing for installers to update to.
  if (diff !== null && isEmptyDiff(diff) && !filesChanged(noteSet.id)) {
    checkUpdatesNow();
    return state(deps);
  }

  const mapVersion = await repos.trackMaps.latestVersion(noteSet.trackKey);
  const voices = await repos.audio.listVoices(noteSet.id);

  const files = await uploadForVersion(client, noteSet.id, itemId);

  const published = await publishVersion(client, {
    itemId,
    noteSet: asPublished(noteSet),
    changelog: changelog.trim(),
    diff,
    mapVersion,
    voiceId: voices[0] ?? null,
    files,
  });
  forget(noteSet.id);
  await index.put(noteSet.id, { itemId, origin: "mine", version: published.version, versionId: published.id, policy: "auto" });
  // The working copy is now the same as the release; keep the draft row in step.
  await saveDraft(client, itemId, noteSet).catch(() => {});
  // Track Coach shows the new version and counts from the library's cache.
  checkUpdatesNow();

  return state(deps);
}

/**
 * After an editor save: keep the owner's draft in the cloud current, so the
 * same pack can be picked up on another machine. Only for sets already
 * published — an unpublished set has no item to hang a draft on.
 */
export async function pushDraft(dataDir: string, noteSetId: string): Promise<void> {
  if (!accountView().signedIn) return;
  const link = await new LocalContentIndex(dataDir).get(noteSetId);
  if (link === null || link.origin !== "mine") return;
  const noteSet = await localRepositories(dataDir).noteSets.get(noteSetId);
  if (noteSet === null) return;
  try {
    await saveDraft(cloudClient(), link.itemId, noteSet);
  } catch (err) {
    process.stdout.write(`could not sync the draft of ${noteSetId}: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

export function installPublishIpc(deps: PublishDeps): void {
  ipcMain.handle(PUBLISH_CHANNEL, async (event, request: PublishRequest) => {
    try {
      switch (request.op) {
        case "state":
          return { ok: true, value: await state(deps) };
        case "publish":
          return { ok: true, value: await publish(deps, request.fields, request.changelog, request.filesConfirmed === true) };
        case "addFiles": {
          const settings = deps.getSettings();
          const dataDir = deps.resolveDataDir(settings);
          const noteSet = settings.noteSetId === null ? null : await localRepositories(dataDir).noteSets.get(settings.noteSetId);
          if (noteSet === null) throw new Error("no note set is open");
          await addFiles(event.sender, noteSet.id, await defaultCarFor(dataDir, noteSet.carClass));
          return { ok: true, value: await state(deps) };
        }
        case "removeFile": {
          const id = deps.getSettings().noteSetId;
          if (id !== null) removeFile(id, request.key);
          return { ok: true, value: await state(deps) };
        }
        case "setFileLabel": {
          const id = deps.getSettings().noteSetId;
          if (id !== null) setFileLabel(id, request.key, request.label);
          return { ok: true, value: await state(deps) };
        }
        case "withdraw":
          await withdrawVersion(cloudClient(), request.versionId);
          return { ok: true, value: await state(deps) };
        case "addMedia":
          return { ok: true, value: await addMedia(deps, event.sender, request.kind) };
        case "removeMedia":
          return { ok: true, value: await deleteMedia(deps, request.mediaId) };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
