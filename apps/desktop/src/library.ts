/**
 * Installed and own packs on this machine — TODO.md M8 step 4.
 *
 * Installing turns a published version into an ordinary note set on disk plus
 * its rendered audio, so the runtime needs nothing new: a session loads an
 * installed pack exactly like one written here, offline included. Which local
 * set is which pack is the content index's business (core/content.ts).
 *
 * All of it works signed out except finding your own packs on your account.
 */

import { ipcMain } from "electron";

import { describeDiff, type NoteSet } from "@exxeed/core";
import {
  LIBRARY_CHANNEL,
  type LibraryRequest,
  type LibraryVersion,
  type RemotePack,
  type Settings,
} from "@exxeed/overlays";
import {
  getDraft,
  getItem,
  getItems,
  getVersionPayload,
  listMyItems,
  listVersions,
  LocalContentIndex,
  localRepositories,
  recordDownload,
  type ItemView,
} from "@exxeed/repo";
import { slug } from "@exxeed/telemetry";

import { accountView, cloudClient } from "./account.js";
import { renderImported } from "./auto-render.js";
import { pullForTrack } from "./cloud-sync.js";
import { installSetups, removeSetups } from "./setups.js";

export interface LibraryDeps {
  readonly getSettings: () => Settings;
  readonly resolveDataDir: (settings: Settings) => string;
  /** True while a session runs: updates wait until it ends (§4.5). */
  readonly sessionRunning: () => boolean;
  /** Something changed on disk or on the server; redraw the pack list. */
  readonly changed: () => void;
  /** A long operation began (text) or ended (null). */
  readonly busy: (text: string | null) => void;
  /** Unselect a pack that was removed, if it was the chosen one. */
  readonly unselect: (noteSetId: string) => void;
}

const log = (line: string): void => void process.stdout.write(`${line}\n`);
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The newest published version of each pack this machine knows, from the last check. */
const remote = new Map<string, ItemView>();
/** Own packs on the account and not on this machine. */
let remoteMine: RemotePack[] = [];

export const knownItem = (itemId: string): ItemView | undefined => remote.get(itemId);
export const remoteMinePacks = (): readonly RemotePack[] => remoteMine;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** A pack id from a bare id or any link containing one. */
function parseRef(ref: string): string {
  const match = UUID.exec(ref.trim());
  if (match === null) throw new Error("that is not a pack link or id");
  return match[0].toLowerCase();
}

/** A readable, stable local id for a pack: the same across its versions. */
const localIdFor = (item: ItemView): string =>
  `${slug(item.title).slice(0, 60) || "pack"}-${item.id.slice(0, 8)}`;

/**
 * Put a note set that came from the server onto disk under a local id, render
 * its audio, and point the index at it. The server's copy carries the author's
 * audio paths and durations; the notes are marked stale until this machine has
 * rendered them, which is honest about the state if rendering fails (no Piper,
 * say) and the session then runs on the author's measured durations.
 */
async function placeLocally(
  deps: LibraryDeps,
  noteSet: NoteSet,
  localId: string,
  what: string,
): Promise<{ rendered: boolean; message: string }> {
  const settings = deps.getSettings();
  const dataDir = deps.resolveDataDir(settings);
  const repos = localRepositories(dataDir);

  // The map first, so the editor and overlays have the track to draw.
  await pullForTrack(dataDir, noteSet.trackKey, log);

  const previous = await repos.noteSets.get(localId);
  await repos.noteSets.put({
    ...noteSet,
    id: localId,
    notes: noteSet.notes.map((n) => {
      // A note whose words are unchanged since the copy already here keeps its
      // local audio and stays clean; the renderer's reuse keeps its clip.
      const had = previous?.notes.find((p) => p.id === n.id);
      const same = had !== undefined && had.text === n.text && had.textShort === n.textShort && !had.dirty;
      return same ? { ...n, audio: had.audio, audioShort: had.audioShort, dirty: false } : { ...n, dirty: true };
    }),
  });

  deps.busy(`Rendering ${what}…`);
  // Rendered in this machine's own voice: a session looks its audio up by the
  // voice set in preferences, so a pack in the author's voice would be silent.
  const result = await renderImported(settings, dataDir, localId, (stage, received, total) => {
    if (stage === "render") deps.busy(`Rendering ${what}: ${received} of ${total} clips`);
    else deps.busy(`${stage === "piper" ? "Installing Piper" : "Downloading a voice"} (first time only)…`);
  }, true);

  return result.ok
    ? {
        rendered: true,
        message:
          result.clips === 0
            ? "nothing to render, every callout was already here"
            : `rendered ${result.clips} clip${result.clips === 1 ? "" : "s"}${result.reused > 0 ? `, kept ${result.reused}` : ""}`,
      }
    : { rendered: false, message: `installed, but the audio could not be rendered: ${result.message}` };
}

/** Install someone's pack, or move an installed one to another version. */
async function install(deps: LibraryDeps, ref: string, versionId?: string): Promise<string> {
  const itemId = parseRef(ref);
  const client = cloudClient();
  const item = await getItem(client, itemId);
  if (item === null) throw new Error("no such pack, or it is private");
  if (item.ownerId === accountView().userId) {
    throw new Error("that is your own pack — it is under Mine, with Download if it is not on this machine yet");
  }

  const target = versionId ?? item.latestVersionId;
  if (target === null) throw new Error("that pack has no published version yet");
  const noteSet = await getVersionPayload(client, target);
  if (noteSet === null) throw new Error("that version is not available");
  const version = (await listVersions(client, itemId)).find((v) => v.id === target);

  const settings = deps.getSettings();
  const dataDir = deps.resolveDataDir(settings);
  const index = new LocalContentIndex(dataDir);
  const localId = (await index.findByItem(itemId)) ?? localIdFor(item);
  const existing = await index.get(localId);
  if (existing?.origin === "mine") throw new Error("a pack of your own is already stored under this id");

  deps.busy(`Installing ${item.title}…`);
  try {
    const placed = await placeLocally(deps, noteSet, localId, item.title);
    // Setups into the sim's own folders, where this machine has them (Windows).
    const setups = await installSetups(client, target, item.title).catch((err: unknown) => `setups not installed: ${message(err)}`);
    // Choosing an older version is choosing to stay on it: auto-update would
    // otherwise undo the rollback at the next check.
    const pinned = versionId !== undefined && versionId !== item.latestVersionId;
    await index.put(localId, {
      itemId,
      origin: "installed",
      version: version?.version ?? item.latestVersion,
      versionId: target,
      policy: pinned ? "pinned" : (existing?.policy ?? "auto"),
    });
    remote.set(itemId, item);

    const installationId = settings.installationId;
    if (installationId !== null) {
      await recordDownload(client, target, installationId).catch((err: unknown) => log(`could not count the download: ${message(err)}`));
    }
    const done = `${placed.message}${setups === null ? "" : `; ${setups}`}`;
    log(`installed ${item.title} v${version?.version ?? "?"} as ${localId}: ${done}`);
    return `${item.title} v${version?.version ?? ""} installed — ${done}`;
  } finally {
    deps.busy(null);
    deps.changed();
  }
}

async function uninstall(deps: LibraryDeps, noteSetId: string): Promise<string> {
  const dataDir = deps.resolveDataDir(deps.getSettings());
  const index = new LocalContentIndex(dataDir);
  const link = await index.get(noteSetId);
  // Only installed packs. Deleting your own work is not something a button
  // next to "Publish" should be able to do by accident.
  if (link?.origin !== "installed") throw new Error("only installed packs can be uninstalled");
  const repos = localRepositories(dataDir);
  // The pack's setup folders go with it — by title, which is how they were named.
  const title = remote.get(link.itemId)?.title ?? (await getItem(cloudClient(), link.itemId).catch(() => null))?.title;
  if (title !== undefined) await removeSetups(title).catch(() => {});
  await repos.noteSets.remove(noteSetId);
  await repos.audio.removeAll(noteSetId);
  await index.remove(noteSetId);
  deps.unselect(noteSetId);
  deps.changed();
  return "uninstalled";
}

async function setPolicy(deps: LibraryDeps, noteSetId: string, policy: "auto" | "pinned"): Promise<string> {
  const index = new LocalContentIndex(deps.resolveDataDir(deps.getSettings()));
  const link = await index.get(noteSetId);
  if (link === null || link.origin !== "installed") throw new Error("not an installed pack");
  await index.put(noteSetId, { ...link, policy });
  deps.changed();
  if (policy === "auto") void checkUpdates(deps);
  return policy === "auto" ? "updates automatically" : "stays on this version";
}

/** A pack's versions with what each changed, for the version picker. */
async function versions(itemId: string): Promise<LibraryVersion[]> {
  const client = cloudClient();
  const list = await listVersions(client, itemId);
  return list.map((v) => ({
    id: v.id,
    version: v.version,
    changelog: v.changelog,
    changes: v.diff === null ? [] : describeDiff(v.diff),
    publishedAt: v.publishedAt,
    withdrawn: v.withdrawnAt !== null,
  }));
}

/**
 * One of your own packs from your account onto this machine: the draft if
 * there is one — that is the working copy — otherwise the latest version.
 */
async function downloadMine(deps: LibraryDeps, itemId: string): Promise<string> {
  const view = accountView();
  if (!view.signedIn) throw new Error("sign in to get your own packs");
  const client = cloudClient();
  const item = await getItem(client, itemId);
  if (item === null || item.ownerId !== view.userId) throw new Error("not one of your packs");

  const draft = await getDraft(client, itemId);
  const noteSet =
    draft?.noteSet ?? (item.latestVersionId === null ? null : await getVersionPayload(client, item.latestVersionId));
  if (noteSet === null) throw new Error("that pack has neither a draft nor a published version");

  const dataDir = deps.resolveDataDir(deps.getSettings());
  const repos = localRepositories(dataDir);
  // Keep the id it had where it was written, unless something here has it.
  const taken = new Set((await repos.noteSets.listAll()).map((s) => s.id));
  const localId = taken.has(noteSet.id) ? localIdFor(item) : noteSet.id;

  deps.busy(`Downloading ${item.title}…`);
  try {
    const placed = await placeLocally(deps, noteSet, localId, item.title);
    await new LocalContentIndex(dataDir).put(localId, {
      itemId,
      origin: "mine",
      version: item.latestVersion,
      versionId: item.latestVersionId,
      policy: "auto",
    });
    remoteMine = remoteMine.filter((p) => p.itemId !== itemId);
    return `${item.title} is on this machine — ${placed.message}`;
  } finally {
    deps.busy(null);
    deps.changed();
  }
}

let checking = false;

/**
 * Ask the server what is newer, and take updates for packs set to auto — but
 * never during a session, whose note set was pinned when it started (§4.5).
 * Also refreshes the list of your own packs that are not on this machine.
 */
export async function checkUpdates(deps: LibraryDeps): Promise<string> {
  if (checking) return "already checking";
  checking = true;
  try {
    const dataDir = deps.resolveDataDir(deps.getSettings());
    const entries = Object.entries(await new LocalContentIndex(dataDir).all());
    const client = cloudClient();

    const items = await getItems(client, entries.map(([, link]) => link.itemId));
    for (const item of items) remote.set(item.id, item);

    const view = accountView();
    if (view.signedIn && view.userId !== null) {
      const mine = await listMyItems(client, view.userId);
      for (const item of mine) remote.set(item.id, item);
      const here = new Set(entries.map(([, link]) => link.itemId));
      remoteMine = mine
        .filter((item) => !here.has(item.id))
        .map((item) => ({
          itemId: item.id,
          title: item.title,
          trackLabel: item.trackLabel,
          carClass: item.carClass,
          latestVersion: item.latestVersion,
        }));
    } else {
      remoteMine = [];
    }

    let updated = 0;
    if (!deps.sessionRunning()) {
      for (const [, link] of entries) {
        if (link.origin !== "installed" || link.policy !== "auto") continue;
        const item = remote.get(link.itemId);
        if (item?.latestVersionId == null || item.latestVersionId === link.versionId) continue;
        try {
          await install(deps, item.id);
          updated++;
        } catch (err) {
          log(`could not update ${item.title}: ${message(err)}`);
        }
      }
    }
    return updated === 0 ? "up to date" : `updated ${updated} pack${updated === 1 ? "" : "s"}`;
  } finally {
    checking = false;
    deps.changed();
  }
}

let installedDeps: LibraryDeps | null = null;

/** After a session ends: take the updates that waited for it. */
export function checkUpdatesNow(): void {
  if (installedDeps !== null) void checkUpdates(installedDeps).catch(() => {});
}

export function installLibrary(deps: LibraryDeps): void {
  installedDeps = deps;
  ipcMain.handle(LIBRARY_CHANNEL, async (_event, request: LibraryRequest) => {
    try {
      switch (request.op) {
        case "install":
          return { ok: true, value: await install(deps, request.ref, request.versionId) };
        case "uninstall":
          return { ok: true, value: await uninstall(deps, request.noteSetId) };
        case "setPolicy":
          return { ok: true, value: await setPolicy(deps, request.noteSetId, request.policy) };
        case "versions":
          return { ok: true, value: await versions(request.itemId) };
        case "downloadMine":
          return { ok: true, value: await downloadMine(deps, request.itemId) };
        case "checkUpdates":
          return { ok: true, value: await checkUpdates(deps) };
      }
    } catch (err) {
      deps.busy(null);
      return { ok: false, error: message(err) };
    }
  });

  // Soon after start, then every half hour: cheap (one query for all installed
  // packs), and a pack updated in the evening is there before the next session.
  setTimeout(() => void checkUpdates(deps).catch(() => {}), 10_000);
  setInterval(() => void checkUpdates(deps).catch(() => {}), 30 * 60_000);
}
