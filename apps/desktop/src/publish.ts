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

import { ipcMain } from "electron";

import { describeDiff, diffNoteSets, type NoteSet, type TrackKey } from "@exxeed/core";
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
  listVersions,
  LocalContentIndex,
  localRepositories,
  publishVersion,
  saveDraft,
  updateItem,
  withdrawVersion,
} from "@exxeed/repo";

import { accountView, cloudClient } from "./account.js";
import { shareTrack } from "./cloud-sync.js";

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
    title: `${track} · ${noteSet.carClass.toUpperCase()}`.slice(0, 80),
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
      published: null,
    };
  }

  const link = await new LocalContentIndex(dataDir).get(noteSet.id);
  const base = {
    signedIn,
    noteSetId: noteSet.id,
    dirtyCount: noteSet.notes.filter((n) => n.dirty).length,
    noteCount: noteSet.notes.length,
    installed: link?.origin === "installed",
    suggested: await suggestedFields(dataDir, noteSet),
  };
  if (link === null || !signedIn) return { ...base, published: null };

  const client = cloudClient();
  const item = await getItem(client, link.itemId);
  if (item === null) return { ...base, published: null };
  const versions = await listVersions(client, item.id);

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
    },
  };
}

function checkFields(fields: PublishFields): void {
  const title = fields.title.trim();
  if (title.length < 3 || title.length > 80) throw new Error("a title is 3 to 80 characters");
  if (fields.summary.trim().length > 160) throw new Error("the summary is at most 160 characters");
}

async function publish(deps: PublishDeps, fields: PublishFields, changelog: string): Promise<PublishState> {
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
  const mapVersion = await repos.trackMaps.latestVersion(noteSet.trackKey);
  const voices = await repos.audio.listVoices(noteSet.id);

  const published = await publishVersion(client, {
    itemId,
    noteSet: asPublished(noteSet),
    changelog: changelog.trim(),
    diff: previous === null ? null : diffNoteSets(previous, noteSet),
    mapVersion,
    voiceId: voices[0] ?? null,
  });
  await index.put(noteSet.id, { itemId, origin: "mine", version: published.version, versionId: published.id, policy: "auto" });
  // The working copy is now the same as the release; keep the draft row in step.
  await saveDraft(client, itemId, noteSet).catch(() => {});

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
  ipcMain.handle(PUBLISH_CHANNEL, async (_event, request: PublishRequest) => {
    try {
      switch (request.op) {
        case "state":
          return { ok: true, value: await state(deps) };
        case "publish":
          return { ok: true, value: await publish(deps, request.fields, request.changelog) };
        case "withdraw":
          await withdrawVersion(cloudClient(), request.versionId);
          return { ok: true, value: await state(deps) };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
