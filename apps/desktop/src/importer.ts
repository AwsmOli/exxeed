/**
 * The YouTube importer — SPEC.md §10 stages 0–3, inside the app.
 *
 * TODO.md (M5) planned these stages as a separate helper that emitted a file
 * for the app to import, so that the app would never talk to YouTube. This
 * reverses that for the authoring side: finding a guide for the race you are
 * about to drive, watching it, and turning its transcript into callouts is one
 * task, and splitting it across two tools made the common case — "this week's
 * track, this car" — the awkward one. The runtime is untouched: no network, no
 * model, nothing on the driving path (§2).
 *
 * The flow, and where each step lives:
 *
 *   iRacing's public schedule PDF, or the live session  →  track + car
 *   yt-dlp search                                      →  candidate videos
 *   yt-dlp captions                                    →  transcript
 *   one prompt, to a model or through the clipboard    →  { turn, text } drafts
 *   resolveProfile (packages/core)                     →  a draft note set
 *
 * The last step needs a track map, because a turn number means nothing without
 * one. A track that has not been driven yet gets its callouts saved under
 * data/imports instead, to be placed once a lap has been recorded there.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, ipcMain, safeStorage, session, shell } from "electron";

import {
  classOf,
  resolveProfile,
  type ImportProfile,
  type NoteSet,
  type TrackKey,
  type TrackMap,
} from "@exxeed/core";
import {
  buildCalloutPrompt,
  complete,
  fetchSchedule,
  fetchTranscript,
  installYtDlp,
  parseCalloutReply,
  raceWeekAt,
  PROVIDERS,
  resolveYtDlp,
  resolveYtDlpSetup,
  searchVideos,
  toImportProfile,
  type DraftCallout,
  type PromptCorner,
  type ProviderId,
  type RaceWeekEntry,
  type ScheduledSeries,
  type Transcript,
} from "@exxeed/importer";
import type { Settings } from "@exxeed/overlays";
import { localRepositories } from "@exxeed/repo";
import type { SessionIdentity } from "@exxeed/telemetry";

import { readSecrets, writeSecrets, type ImporterSecrets } from "./importer-secrets.js";
import { REPO_ROOT } from "./voices.js";

const PAGE = fileURLToPath(new URL("../static/importer.html", import.meta.url));

export const IMPORTER_CHANNEL = "exxeed:importer";
export const IMPORTER_PROGRESS_CHANNEL = "exxeed:importer-progress";

/** Beside data/piper, for the same reason: fetched, not authored, and ignored by git. */
const TOOLS_DIR = `${REPO_ROOT}/data/tools`;

/** A separate session, so the header rewrite below touches nothing else in the app. */
const PARTITION = "persist:importer";

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export interface ImporterDeps {
  readonly getSettings: () => Settings;
  readonly resolveDataDir: (settings: Settings) => string;
  /** What the sim reports right now, or null when no session is running. */
  readonly identity: () => SessionIdentity | null;
  /** Point the app at a freshly imported set and open it in the editor. */
  readonly openImported: (noteSetId: string) => void;
}

// ---------------------------------------------------------------------------
// Race week, cached
// ---------------------------------------------------------------------------

interface ScheduleCache {
  readonly fetchedAt: number;
  readonly lastModified: string | null;
  readonly series: readonly ScheduledSeries[];
}

const schedulePath = (): string => join(app.getPath("userData"), "iracing-schedule.json");

/**
 * Six hours. The PDF changes a few times a season, and the week rolls over by
 * date without a fetch at all — this is only about catching schedule edits.
 */
const SCHEDULE_TTL_MS = 6 * 60 * 60 * 1000;

async function readScheduleCache(): Promise<ScheduleCache | null> {
  try {
    return JSON.parse(await readFile(schedulePath(), "utf8")) as ScheduleCache;
  } catch {
    return null;
  }
}

async function raceWeek(
  refresh: boolean,
): Promise<{ fetchedAt: number; stale: string | null; entries: RaceWeekEntry[] }> {
  const cached = await readScheduleCache();
  const view = (c: ScheduleCache, stale: string | null) => ({
    fetchedAt: c.fetchedAt,
    stale,
    entries: raceWeekAt(c.series, new Date()),
  });

  if (!refresh && cached !== null && Date.now() - cached.fetchedAt < SCHEDULE_TTL_MS) return view(cached, null);

  try {
    const fresh = await fetchSchedule();
    const next: ScheduleCache = { fetchedAt: Date.now(), ...fresh };
    await writeFile(schedulePath(), JSON.stringify(next), "utf8");
    return view(next, null);
  } catch (err) {
    // Offline, or iRacing changed the layout. Last known schedule beats none —
    // the week still rolls over by date — but say that it is old.
    if (cached === null) throw err;
    return view(cached, err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// What the window sees
// ---------------------------------------------------------------------------

function accountsView(secrets: ImporterSecrets): unknown {
  return {
    provider: secrets.ai.provider,
    model: secrets.ai.model,
    baseUrl: secrets.ai.baseUrl,
    hasKey: Object.fromEntries(PROVIDERS.map((p) => [p.id, (secrets.ai.keys[p.id] ?? "") !== ""])),
  };
}

/** Names as iRacing prints them, reduced to what two spellings of one track share. */
const normalise = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Which track this is, as the repository files it.
 *
 * The sim reports a numeric track id and that is used as-is. The schedule PDF
 * has names only, so those are matched against the maps on disk — which is also
 * the only case that matters: a track with no map has nothing to place callouts
 * on whatever its id is.
 */
async function keyOf(dataDir: string, track: { trackId: number | null; trackName: string; configName: string }): Promise<TrackKey | null> {
  if (track.trackId !== null && track.trackId > 0) {
    return { sim: "iracing", trackId: track.trackId, configId: slug(track.configName) };
  }
  const name = normalise(track.trackName);
  const config = normalise(track.configName);
  const found = (await localRepositories(dataDir).trackMaps.listTracks()).find(
    (t) => normalise(t.trackName) === name && normalise(t.configName) === config,
  );
  return found?.key ?? null;
}

async function mapFor(dataDir: string, key: TrackKey | null): Promise<TrackMap | null> {
  if (key === null) return null;
  const repos = localRepositories(dataDir);
  const version = await repos.trackMaps.latestVersion(key);
  if (version === null) return null;
  try {
    return await repos.trackMaps.get({ ...key, mapVersion: version });
  } catch (err) {
    // Usually a map cut before a schema change. Said in one sentence, because
    // the raw validation error is a page of JSON about a field nobody typed.
    const issue = (err as { issues?: { path: (string | number)[]; message: string }[] }).issues?.[0];
    const detail = issue === undefined ? String(err) : `${issue.path.join(".")}: ${issue.message}`;
    throw new Error(
      `the track map for track ${key.trackId}/${key.configId} v${version} could not be read (${detail}) — re-cut it from a recording`,
    );
  }
}

const promptCorners = (map: TrackMap | null): PromptCorner[] | null =>
  map?.corners.map((c) => ({
    turn: c.index,
    names: c.names,
    direction: c.direction,
    severity: c.severity,
  })) ?? null;

interface TrackRequest {
  /** The sim's track id, when it came from a session. Null from the schedule. */
  readonly trackId: number | null;
  readonly configName: string;
  readonly trackName: string;
  readonly carName: string;
  readonly carId: string | null;
}

interface VideoRequest {
  readonly id: string;
  readonly title: string;
  readonly channel: string;
}

/** One transcript at a time is all the window shows; keep the last few so going back is instant. */
const transcripts = new Map<string, Transcript>();

async function transcriptFor(videoId: string): Promise<Transcript> {
  const cached = transcripts.get(videoId);
  if (cached !== undefined) return cached;
  const yt = await resolveYtDlpSetup(TOOLS_DIR);
  if (yt === null) throw new Error("yt-dlp is not installed");
  const fetched = await fetchTranscript(yt, videoId);
  transcripts.set(videoId, fetched);
  if (transcripts.size > 8) transcripts.delete(transcripts.keys().next().value!);
  return fetched;
}

async function promptFor(deps: ImporterDeps, track: TrackRequest, video: VideoRequest): Promise<string> {
  const dataDir = deps.resolveDataDir(deps.getSettings());
  const map = await mapFor(dataDir, await keyOf(dataDir, track));
  return buildCalloutPrompt({
    trackName: track.trackName,
    configName: track.configName,
    carName: track.carName,
    corners: promptCorners(map),
    video: { title: video.title, channel: video.channel },
    transcript: (await transcriptFor(video.id)).lines,
  });
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

interface ImportRequest {
  readonly track: TrackRequest;
  readonly video: VideoRequest;
  readonly carClass: string;
  readonly callouts: readonly DraftCallout[];
}

async function importCallouts(deps: ImporterDeps, request: ImportRequest): Promise<unknown> {
  const dataDir = deps.resolveDataDir(deps.getSettings());
  const key = await keyOf(dataDir, request.track);
  const carClass = slug(request.carClass) || "unknown";
  const profile = toImportProfile(
    request.callouts,
    { videoId: request.video.id, title: request.video.title, channel: request.video.channel },
    carClass,
  );
  const map = await mapFor(dataDir, key);

  if (key === null || map === null) {
    // Nothing to place a turn number against. Keep the work rather than lose
    // it: the profile is exactly what the CLI's `import` reads, and the list
    // below offers it again once the track has been mapped.
    const dir = join(dataDir, "imports");
    await mkdir(dir, { recursive: true });
    const where = `${slug(request.track.trackName)}-${slug(request.track.configName) || "default"}`;
    const file = join(dir, `${where}-${request.video.id}.json`);
    await writeFile(
      file,
      `${JSON.stringify(
        { trackKey: key, trackName: request.track.trackName, configName: request.track.configName, profile },
        null,
        2,
      )}\n`,
      "utf8",
    );
    return {
      ok: true,
      placed: false,
      message:
        `No track map for ${request.track.trackName} yet, so the callouts cannot be placed. ` +
        `Saved them; drive a lap there with Exxeed running, then import them from the saved list.`,
      savedTo: file,
    };
  }

  return placeProfile(deps, dataDir, key, map, profile);
}

async function placeProfile(
  deps: ImporterDeps,
  dataDir: string,
  key: TrackKey,
  map: TrackMap,
  profile: ImportProfile,
): Promise<unknown> {
  const resolved = resolveProfile(profile, map);
  if (resolved.notes.length === 0) {
    return {
      ok: false,
      placed: false,
      message: "none of the callouts landed on a turn in this map",
      unresolved: resolved.unresolved.map((u) => `turn ${u.callout.turn}: ${u.reason}`),
    };
  }

  const videoId = profile.source.videoId ?? "manual";
  const id = slug(`${map.trackName}-${key.configId}-${profile.carClass}-${videoId}`);
  const noteSet: NoteSet = {
    id,
    trackKey: key,
    lengthM: map.lengthM,
    carClass: profile.carClass,
    source: profile.source,
    // Every note unheard and stale until rendered; §7.4 will not publish it
    // before then. Same as the CLI import.
    status: "draft",
    createdAt: new Date().toISOString(),
    notes: [...resolved.notes],
  };
  await localRepositories(dataDir).noteSets.put(noteSet);
  deps.openImported(id);

  return {
    ok: true,
    placed: true,
    noteSetId: id,
    message: `Imported ${resolved.notes.length} callouts as "${id}" — opened in the editor. Render the audio before driving.`,
    warnings: resolved.warnings,
    unresolved: resolved.unresolved.map((u) => `turn ${u.callout.turn}: ${u.reason}`),
  };
}

interface SavedImport {
  readonly trackKey: TrackKey | null;
  readonly trackName: string;
  readonly configName?: string;
  readonly profile: ImportProfile;
}

/** The key it was saved with, or — for a track nobody had mapped — found by name now. */
const savedKey = async (dataDir: string, raw: SavedImport): Promise<TrackKey | null> =>
  raw.trackKey ?? keyOf(dataDir, { trackId: null, trackName: raw.trackName, configName: raw.configName ?? "" });

async function listSaved(dataDir: string): Promise<unknown[]> {
  const dir = join(dataDir, "imports");
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const saved: unknown[] = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(await readFile(join(dir, file), "utf8")) as SavedImport;
      saved.push({
        file,
        trackName: raw.trackName,
        title: raw.profile.source.title ?? file,
        count: raw.profile.callouts.length,
        mapped: (await mapFor(dataDir, await savedKey(dataDir, raw))) !== null,
      });
    } catch {
      // A hand-edited file that no longer parses; skip it rather than hide the rest.
    }
  }
  return saved;
}

async function placeSaved(deps: ImporterDeps, file: string): Promise<unknown> {
  if (!/^[\w.-]+\.json$/.test(file)) throw new Error("not a saved import");
  const dataDir = deps.resolveDataDir(deps.getSettings());
  const raw = JSON.parse(await readFile(join(dataDir, "imports", file), "utf8")) as SavedImport;
  const key = await savedKey(dataDir, raw);
  const map = await mapFor(dataDir, key);
  if (key === null || map === null) return { ok: false, placed: false, message: "still no track map for this track" };
  return placeProfile(deps, dataDir, key, map, raw.profile);
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

type Request =
  | { op: "context" }
  | { op: "saveAccounts"; ai?: { provider: ProviderId; model: string; baseUrl: string; key?: string } }
  | { op: "raceWeek"; refresh: boolean }
  | { op: "installYtDlp" }
  | { op: "search"; query: string }
  | { op: "transcript"; videoId: string }
  | { op: "trackInfo"; track: TrackRequest }
  | { op: "prompt"; track: TrackRequest; video: VideoRequest }
  | { op: "convert"; track: TrackRequest; video: VideoRequest }
  | { op: "parse"; track: TrackRequest; reply: string }
  | { op: "import"; request: ImportRequest }
  | { op: "saved" }
  | { op: "placeSaved"; file: string }
  | { op: "openVideo"; videoId: string; atMs: number };

async function validTurns(deps: ImporterDeps, track: TrackRequest): Promise<number[] | null> {
  const dataDir = deps.resolveDataDir(deps.getSettings());
  const map = await mapFor(dataDir, await keyOf(dataDir, track));
  return map?.corners.map((c) => c.index) ?? null;
}

async function handle(deps: ImporterDeps, request: Request, sender: Electron.WebContents): Promise<unknown> {
  switch (request.op) {
    case "context": {
      const identity = deps.identity();
      return {
        session:
          identity?.trackKey == null
            ? null
            : {
                trackId: identity.trackKey.trackId,
                trackName: identity.trackName,
                configName: identity.trackConfig,
                carName: identity.carName,
                carId: identity.carId,
              },
        accounts: accountsView(readSecrets()),
        providers: PROVIDERS,
        ytdlp: await resolveYtDlp(TOOLS_DIR),
        secureStorage: safeStorage.isEncryptionAvailable(),
      };
    }

    case "saveAccounts": {
      const current = readSecrets();
      const ai = request.ai;
      const next: ImporterSecrets = {
        ai:
          ai === undefined
            ? current.ai
            : {
                provider: ai.provider,
                model: ai.model,
                baseUrl: ai.baseUrl,
                // An empty key field means "leave it", because the window never
                // sees the stored key and so cannot send it back.
                keys:
                  ai.key === undefined || ai.key === ""
                    ? current.ai.keys
                    : { ...current.ai.keys, [ai.provider]: ai.key },
              },
      };
      writeSecrets(next);
      return accountsView(next);
    }

    case "raceWeek":
      return raceWeek(request.refresh);

    case "installYtDlp":
      return installYtDlp(TOOLS_DIR, (received, total) =>
        sender.send(IMPORTER_PROGRESS_CHANNEL, { received, total }),
      );

    case "search": {
      const yt = await resolveYtDlpSetup(TOOLS_DIR);
      if (yt === null) throw new Error("yt-dlp is not installed");
      return searchVideos(yt, request.query);
    }

    case "transcript":
      return transcriptFor(request.videoId);

    case "trackInfo": {
      const dataDir = deps.resolveDataDir(deps.getSettings());
      const key = await keyOf(dataDir, request.track);
      const map = await mapFor(dataDir, key);
      const registry = await localRepositories(dataDir).cars.get("iracing");
      // By the sim's slug when there is one; by name otherwise, which is what a
      // typed-in car has — the registry's "Mazda MX-5 Cup" is inside iRacing's
      // "Global Mazda MX-5 Cup".
      const name = request.track.carName.toLowerCase();
      const byName = Object.values(registry?.cars ?? {}).find(
        (c) => name !== "" && (name.includes(c.name.toLowerCase()) || c.name.toLowerCase().includes(name)),
      );
      const carClass =
        (request.track.carId === null ? null : classOf(registry, request.track.carId)) ??
        byName?.class ??
        slug(request.track.carName);
      return {
        mapped: map !== null,
        turns: map?.corners.map((c) => c.index) ?? [],
        carClass,
        noteSets:
          key === null ? [] : (await localRepositories(dataDir).noteSets.listForTrack(key)).map((s) => s.id),
      };
    }

    case "prompt":
      return promptFor(deps, request.track, request.video);

    case "convert": {
      const secrets = readSecrets();
      const reply = await complete(
        {
          provider: secrets.ai.provider,
          model: secrets.ai.model,
          baseUrl: secrets.ai.baseUrl,
          apiKey: secrets.ai.keys[secrets.ai.provider] ?? "",
        },
        await promptFor(deps, request.track, request.video),
      );
      return { reply, parsed: parseCalloutReply(reply, await validTurns(deps, request.track)) };
    }

    case "parse":
      return parseCalloutReply(request.reply, await validTurns(deps, request.track));

    case "import":
      return importCallouts(deps, request.request);

    case "saved":
      return listSaved(deps.resolveDataDir(deps.getSettings()));

    case "placeSaved":
      return placeSaved(deps, request.file);

    case "openVideo": {
      if (!/^[A-Za-z0-9_-]{11}$/.test(request.videoId)) throw new Error("not a video id");
      const t = Math.max(0, Math.floor(request.atMs / 1000));
      await shell.openExternal(`https://www.youtube.com/watch?v=${request.videoId}&t=${t}s`);
      return null;
    }
  }
}

export function installImporterIpc(deps: ImporterDeps): void {
  // Errors come back as a value rather than a rejected invoke: Electron wraps a
  // rejection in "Error invoking remote method…", which is noise in front of
  // the one sentence that says what went wrong.
  ipcMain.handle(IMPORTER_CHANNEL, async (event, request: Request) => {
    try {
      return { ok: true, value: await handle(deps, request, event.sender) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

let importer: BrowserWindow | null = null;

/**
 * YouTube's embedded player refuses to play without a Referer, and a page
 * loaded from a file has none — the player shows "error 153" instead of the
 * video. Giving embed requests from this window a referrer of YouTube's own
 * no-cookie host is enough, and it is scoped to this window's partition.
 */
function allowEmbeds(): void {
  const s = session.fromPartition(PARTITION);
  s.webRequest.onBeforeSendHeaders(
    { urls: ["https://www.youtube-nocookie.com/*", "https://www.youtube.com/*"] },
    (details, callback) => {
      const headers = { ...details.requestHeaders };
      if (headers["Referer"] === undefined || headers["Referer"] === "") {
        headers["Referer"] = "https://www.youtube-nocookie.com/";
      }
      callback({ requestHeaders: headers });
    },
  );
}

let embedsAllowed = false;

export function openImporter(preload: string): BrowserWindow {
  if (importer !== null && !importer.isDestroyed()) {
    importer.show();
    importer.focus();
    return importer;
  }

  if (!embedsAllowed) {
    allowEmbeds();
    embedsAllowed = true;
  }

  importer = new BrowserWindow({
    width: 1440,
    height: 900,
    title: "Exxeed — Import From YouTube",
    backgroundColor: "#101215",
    webPreferences: {
      preload,
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Links out of the embedded player (the YouTube logo, "watch on YouTube")
  // belong in the browser, not in a new app window.
  importer.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });

  void importer.loadFile(PAGE);
  importer.once("closed", () => {
    importer = null;
  });
  return importer;
}
