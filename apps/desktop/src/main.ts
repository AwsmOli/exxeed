/**
 * Electron main process — SPEC.md §7 and milestones M0/M2.
 *
 * "Timing-critical work runs in the main process, never a renderer. Renderers get
 * throttled when occluded or backgrounded, which will silently destroy callout
 * timing. Main owns the telemetry loop, the note engine and audio, and pushes a
 * compact state frame to renderers over IPC at 60 Hz. Never send raw telemetry
 * across IPC."
 *
 * Main therefore decides WHAT is said and WHEN. The renderer only converts a
 * decision into sound — Node has no audio output, so the actual playback has to
 * happen in a renderer regardless. That window is created with
 * `backgroundThrottling: false` so the output path cannot be throttled either;
 * the decision path never leaves this process.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, ipcMain, Menu, nativeImage, screen, shell, Tray } from "electron";

import { classOf, deltaSeconds, LapTimer, mps, pct, radians } from "@exxeed/core";
import {
  AUDIO_PLAY_CHANNEL,
  AUDIO_PRELOAD_CHANNEL,
  ENGINE_EVENT_CHANNEL,
  MAP_CHANNEL,
  OVERLAY_PROFILE_COMMAND_CHANNEL,
  BUILTIN_THEMES,
  PANEL_PARTS,
  PANEL_SETTINGS_CHANNEL,
  PANEL_SETTINGS_GET_CHANNEL,
  PANEL_STYLES,
  type PanelSettingsMessage,
  THEME_CHANNEL,
  THEME_GET_CHANNEL,
  themeView,
  MIRROR_PAIRS,
  mirrorBounds,
  PANEL_SPECS,
  OVERLAY_EDITOR_CHANNEL,
  OVERLAY_LAYOUT_CHANGED_CHANNEL,
  type OverlayEditorLayout,
  type OverlayEditorRequest,
  type ScreenRect,
  type Theme,
  type ThemeAssets,
  type ThemeView,
  OVERLAY_PROFILES_CHANGED_CHANNEL,
  RACE_CHANNEL,
  REFERENCE_CHANNEL,
  SESSION_COMMAND_CHANNEL,
  SESSION_STATUS_CHANNEL,
  STATE_FRAME_CHANNEL,
  type AudioClip,
  type AudioPlayCommand,
  type EngineEventView,
  type NoteSetPack,
  type OverlayProfileCommand,
  type OverlayProfilesView,
  type SessionCommand,
  type SessionStatus,
  type StateFrame,
  DEFAULT_PANELS,
  isPanelId,
  PANELS,
  type PanelId,
} from "@exxeed/overlays";
import {
  IRacingAdapter,
  isIRacingSupported,
  NdjsonRecorder,
  ReplayAdapter,
  slug,
  toTickInput,
  type DashState,
  type SessionIdentity,
  type TelemetryFrame,
  type TelemetrySource,
} from "@exxeed/telemetry";

import { audioKey, countForCombo, LocalContentIndex, localRepositories, type TrackSummary } from "@exxeed/repo";

import { buildApplicationMenu } from "./menu.js";
import { FULLSCREEN_WARNING, isOverlayWindow, OverlayLayout, placeInProfile, profilePlaces, sendTo, type PlacedBounds } from "./overlay.js";
import { backgroundPath, OverlayProfileStore } from "./overlay-profiles.js";
import { sampleDash, sampleRaceSnapshot, startOverlayPreview, type OverlayPreview } from "./overlay-preview.js";
import { ReferenceLapSource, type TestLap } from "./test-lap.js";
import { installThemeContentIpc } from "./theme-content.js";
import { ThemeStore } from "./theme-store.js";
import { dataPath, REPO_ROOT, RESOURCES_ROOT } from "./paths.js";
import { rememberWindow, windowBounds } from "./window-state.js";
import { createManualNoteSet, installEditorIpc, openEditor, requestRender } from "./editor.js";
import { watchSimFocus, type ForegroundWatcher } from "./foreground.js";
import { cloudClient, installAccount, onAccountChange } from "./account.js";
import { canonicalTrackKey, shareCut, shareOnSignIn, syncBeforeSession } from "./cloud-sync.js";
import { installPublishIpc } from "./publish.js";
import { checkUpdatesNow, installLibrary, isRendering, knownItem, remoteMinePacks } from "./library.js";
import { installContentIpc } from "./content.js";
import { installLapImport } from "./lap-import.js";
import { installImporterIpc, openImporter } from "./importer.js";
import {
  installSettingsIpc,
  openPreferences,
  PREFERENCES_SHORTCUT,
  registerPreferencesShortcut,
} from "./preferences.js";
import { debugEnabled, SettingsStore } from "./settings.js";
import { carWarnings, loadSession, type LoadedSession } from "./session.js";
import { RaceViewBuilder } from "./race-view.js";
import { AutoMapper } from "./auto-map.js";
import { toMapView } from "./map-view.js";
import { toReferenceView } from "./reference-view.js";

/**
 * How often the race panels are refreshed. The field does not move fast enough
 * to need more, and a standings table redrawn at 60 Hz only flickers.
 */
const RACE_INTERVAL_MS = 200;

// Before any getPath call: without it userData lands under "@exxeed", taken from
// the package name, which is where the overlay's remembered position lives.
app.setName("Exxeed");

// Windows groups windows, pins and notifications by this id; without it an
// installed app shows as "Electron" and its pinned shortcut opens a second icon.
if (process.platform === "win32") app.setAppUserModelId("com.blkpixel.exxeed");

// One copy at a time. A second launch — the Start-menu shortcut clicked while
// the app is already in the tray — would otherwise open a second set of
// overlays fighting the first over the sim. It hands over to the first copy,
// which shows its window, and quits.
const firstInstance = app.requestSingleInstanceLock();
if (!firstInstance) app.quit();

// The built-in test lap: the repo's fixture from source, a copy in the app's
// resources when installed (electron-builder.mjs puts it there).
const FIXTURE = app.isPackaged
  ? join(RESOURCES_ROOT, "fixtures", "synthetic-3laps.ndjson")
  : `${REPO_ROOT}/packages/telemetry/test/fixtures/synthetic-3laps.ndjson`;

/**
 * The one recordings folder. Deliberately not under the chosen data folder:
 * a recording is what this machine drove, not part of a note set's data, and
 * pointing the data folder at data/demo must not hide the laps.
 */
const RECORDINGS_DIR = dataPath("recordings");

/**
 * A replay setting names a file inside the recordings folder. An absolute path
 * still works and is used as-is — that is what EXXEED_REPLAY and the replay
 * harness pass, and neither of them goes through the picker.
 */
const resolveReplayPath = (value: string): string =>
  isAbsolute(value) ? value : join(RECORDINGS_DIR, value);

const env = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
};

/**
 * The settings store, available only once Electron is ready — `app.getPath`
 * needs that. An accessor rather than a definite-assignment assertion so a
 * mistake shows up as a clear error instead of a null dereference.
 */
let store: SettingsStore | null = null;

const settings = (): SettingsStore => {
  if (store === null) throw new Error("settings read before app was ready");
  return store;
};

/** Same reasoning as `settings` above: `app.getPath` needs the app to be ready. */
let profiles: OverlayProfileStore | null = null;

const profileStore = (): OverlayProfileStore => {
  if (profiles === null) throw new Error("overlay profiles read before app was ready");
  return profiles;
};

/**
 * Bumped whenever the session has to be rebuilt. A running telemetry loop
 * carries the token it started with and stops as soon as it stops matching,
 * which is how a settings change replaces a session without two loops ever
 * writing to the same recorder.
 */
let loopToken = 0;

/**
 * The data folder: the repo's own `data/` unless one is chosen.
 *
 * It used to default to `data/demo`, the committed Spa fixture. That made the
 * fixture the thing a real session read from — so a map cut from a real lap
 * would have landed among the fixtures, and note sets under `data/` were
 * invisible until someone went looking for the setting. The demo is still one
 * choice away, and the replay scripts name it explicitly.
 */
/**
 * Where artefacts live. In development, the repo's `data/`, which doubles as
 * the fixture set. Packaged, the user's own app-data folder: installed packs,
 * fetched maps and rendered audio belong to the person, not to the install
 * directory, which an update replaces.
 */
const resolveDataDir = (s: { dataDir: string | null }): string =>
  s.dataDir ?? (app.isPackaged ? join(app.getPath("userData"), "data") : `${REPO_ROOT}/data`);

/**
 * Test mode: replay a lap through the whole app — overlays, callouts, the lot —
 * without the sim. Only ever by choice (the Test mode button, or EXXEED_REPLAY
 * from a script). Starting the app never does it by itself: a window full of
 * overlays talking about Daytona while you read email is not a feature.
 */
let testMode = process.env["EXXEED_REPLAY"] !== undefined && process.env["EXXEED_REPLAY"] !== "";

/**
 * Pick a source: the sim, or in test mode a replay — the recording chosen in
 * the debug settings, or the built-in lap. Outside test mode, a platform with
 * no iRacing has nothing to connect to, and says so rather than replaying.
 */
function createSource(): TelemetrySource {
  const { debug } = settings().get();

  if (testMode) {
    const chosen = debugEnabled() ? debug.replayPath : null;
    if (chosen !== null) {
      return new ReplayAdapter(resolveReplayPath(chosen), { speed: debug.replaySpeed, loop: debug.loopReplay });
    }
    // A pack's own reference lap round its own track, so the callouts, the map
    // and the delta all agree (test-lap.ts). The built-in lap only when there
    // is no pack with a reference lap to drive.
    return new ReferenceLapSource(
      loadTestLap,
      () => new ReplayAdapter(FIXTURE, { speed: debug.replaySpeed, loop: true }),
    );
  }
  if (isIRacingSupported()) return new IRacingAdapter({ hz: 60 });
  throw new Error("iRacing runs on Windows only — use Test mode to replay a lap here");
}

/**
 * What test mode drives: the pinned pack's reference lap, or failing that the
 * first pack that has a map and a reference lap. Null when no pack has both.
 */
async function loadTestLap(): Promise<TestLap | null> {
  const current = settings().get();
  const repos = localRepositories(resolveDataDir(current));
  const ids = current.noteSetId !== null ? [current.noteSetId] : [];
  for (const summary of await repos.noteSets.listAll()) if (!ids.includes(summary.id)) ids.push(summary.id);

  for (const id of ids) {
    const noteSet = await repos.noteSets.get(id);
    if (noteSet === null) continue;
    const version = await repos.trackMaps.latestVersion(noteSet.trackKey);
    if (version === null) continue;
    const map = await repos.trackMaps.get({ ...noteSet.trackKey, mapVersion: version });
    const carId = current.carId ?? (await repos.referenceLaps.listCars(noteSet.trackKey))[0];
    if (map === null || carId === undefined) continue;
    const reference = await repos.referenceLaps.get(noteSet.trackKey, carId);
    if (reference === null) continue;
    return {
      reference,
      lengthM: noteSet.lengthM,
      identity: {
        trackKey: noteSet.trackKey,
        trackId: slug(map.trackName),
        trackName: map.trackName,
        trackConfig: map.configName ?? "",
        carId,
        carName: carId,
      },
    };
  }
  return null;
}

/** `sim:trackId:configId` — the key `noteSetByTrack` remembers a choice under. */
const trackKeyId = (k: { sim: string; trackId: number; configId: string }): string =>
  `${k.sim}:${k.trackId}:${k.configId}`;

/**
 * Which note set to load for the track the sim just reported.
 *
 * The sim knows what it loaded, so asking a driver to pick a note set that
 * matches is asking them to restate something already known. Preference order:
 * the set used here last, then the only candidate, then the first of several.
 *
 * Returns null when the track has no note sets at all — which is not a failure,
 * it is a track nobody has written notes for yet. The overlays still run.
 */
async function noteSetForTrack(
  identity: SessionIdentity | null,
  dataDir: string,
): Promise<{ id: string | null; detail: string | null }> {
  // A hand-picked pack wins. Someone who chose one meant it — including the
  // case of choosing a pack for a track they are not on, which is how you audit
  // a set without driving to it.
  const pinned = settings().get().noteSetId;
  if (pinned !== null) {
    return { id: pinned, detail: `using ${pinned} — picked by hand` };
  }

  if (identity?.trackKey == null) {
    return { id: null, detail: "the sim did not report which track this is" };
  }

  const key = identity.trackKey;
  const repos = localRepositories(dataDir);
  const all = await repos.noteSets.listForTrack(key);
  if (all.length === 0) {
    return { id: null, detail: `no note set for ${identity.trackName}` };
  }

  // Your own, installed ones and imports alike, but for the car being driven
  // first: an MX-5 set timed in a GT3 brakes everywhere too early. Any set for
  // the track is still better than silence, and carWarnings says so.
  const carClass = classOf(await repos.cars.get(key.sim).catch(() => null), identity.carId);
  const forThisCar = carClass === null ? [] : all.filter((c) => c.carClass === carClass);
  const candidates = forThisCar.length > 0 ? forThisCar : all;

  const remembered = settings().get().noteSetByTrack[trackKeyId(key)];
  const chosen =
    remembered !== undefined && candidates.some((c) => c.id === remembered)
      ? remembered
      : candidates[0]!.id;

  return {
    id: chosen,
    detail:
      candidates.length === 1
        ? null
        : `${candidates.length} note sets here; using ${chosen}`,
  };
}

/** The "N packs in Content" banner for a combo with no callouts (M8 step 5). */
async function hintContent(identity: SessionIdentity | null): Promise<void> {
  const key = identity?.trackKey;
  if (identity === null || key == null) return;
  const registry = await localRepositories(resolveDataDir(settings().get())).cars.get(key.sim).catch(() => null);
  const carClass = classOf(registry, identity.carId);
  const count = await countForCombo(cloudClient(), key, carClass).catch(() => null);
  if (count === null || sessionStatus.phase !== "running") return;
  broadcastStatus({
    contentHint: {
      trackKey: key,
      carClass,
      label: `${identity.trackName}${identity.trackConfig === "" ? "" : ` ${identity.trackConfig}`} in the ${identity.carName}`,
      count,
    },
  });
}

/** Persist which note set was used here, so a track with several keeps its choice. */
function rememberNoteSet(identity: SessionIdentity | null, noteSetId: string | null): void {
  if (noteSetId === null || identity?.trackKey == null) return;
  const key = trackKeyId(identity.trackKey);
  const current = settings().get().noteSetByTrack;
  if (current[key] === noteSetId) return;
  settings().updateQuietly({ noteSetByTrack: { ...current, [key]: noteSetId } });
}

/**
 * Whether this track has already been mapped, and so has nothing left to record.
 *
 * Deliberately asks the repository rather than a setting: the point of §9's
 * always-on recording is that nobody has to remember to switch it on before the
 * lap that turned out to matter. "Do I already have this?" is a question the
 * data can answer on its own.
 */
async function haveTrackData(identity: SessionIdentity | null, dataDir: string): Promise<boolean> {
  if (identity?.trackKey == null) return false;
  const version = await localRepositories(dataDir).trackMaps.latestVersion(identity.trackKey);
  return version !== null;
}

async function createSession(noteSetId: string | null): Promise<LoadedSession | null> {
  const current = settings().get();
  if (noteSetId === null) return null;

  // §6.4 requires a completed lap before anything arms, and §6.2 starts every
  // note SPENT. Together they cost more than the spec intends: not just the
  // out-lap, but most of the first flying lap too, because a note only re-arms
  // once its point is more than half a lap away. Measured on Daytona that is one
  // callout out of six on the first flying lap, and a full set only on the
  // second.
  //
  // The gate exists so a callout never fires while the driver is still coming
  // out of the pits. That is worth having by default and it stays the default —
  // but it is a preference, not a law, and someone who joins a session already
  // on track is being made to wait two laps for nothing.
  const skipOutLap = current.debug.skipOutLap;
  if (skipOutLap) {
    process.stdout.write(
      "out-lap gate off — every note starts ARMED, so callouts begin on the first corner (§6.4)\n",
    );
  }

  return loadSession({
    assumeLapComplete: skipOutLap,
    dataDir: resolveDataDir(current),
    noteSetId,
    ...(current.carId === null ? {} : { carId: current.carId }),
    voiceId: current.voiceId,
    profile: { leadAdjustS: current.leadAdjustS },
  });
}

const toStateFrame = (
  f: TelemetryFrame,
  sourceName: string,
  session: LoadedSession | null,
  suppressedBy: StateFrame["suppressedBy"],
  lapElapsedS: StateFrame["lapElapsedS"],
  dash: DashState | null,
): StateFrame => ({
  tMs: f.tMs,
  lap: f.lap,
  lapDistPct: f.lapDistPct,
  speedMps: f.speedMps,
  throttle: f.throttle,
  brake: f.brake,
  gear: f.gear,
  steerRad: f.steerRad,
  lat: f.lat,
  lon: f.lon,
  rpm: dash?.rpm ?? null,
  clutch: dash?.clutch ?? null,
  ffb: dash?.ffb ?? null,
  lapElapsedS,
  deltaS:
    session?.reference == null
      ? null
      : deltaSeconds({
          lapElapsedS,
          lapDistPct: f.lapDistPct,
          referenceElapsedS: session.reference.elapsedS,
          gridSize: session.reference.gridSize,
        }),
  connected: true,
  sourceName,
  suppressedBy,
  queuedNoteIds: session?.engine.queued() ?? [],
  armedNoteIds:
    session === null
      ? []
      : [...session.engine.states()]
          .filter(([, state]) => state === "ARMED")
          .map(([id]) => id),
});

const emptyFrame: StateFrame = {
  tMs: 0,
  lap: 0,
  lapDistPct: pct(0),
  speedMps: mps(0),
  throttle: 0,
  brake: 0,
  gear: 0,
  steerRad: radians(0),
  lat: 0,
  lon: 0,
  rpm: null,
  clutch: null,
  ffb: null,
  lapElapsedS: null,
  deltaS: null,
  connected: false,
  sourceName: "—",
  suppressedBy: null,
  queuedNoteIds: [],
  armedNoteIds: [],
};

/**
 * Where a session's recording lands — SPEC.md §9.
 *
 * Grouped by track then car, so `data/recordings/` stays navigable once there
 * are hundreds of laps in it and you want "the MX-5 laps at Daytona". Sessions
 * the sim would not identify go in `unknown/` rather than being dropped.
 */
function recordingPath(identity: SessionIdentity | null): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir =
    identity === null ? "unknown" : `${identity.trackId}/${identity.carId}`;
  return `${RECORDINGS_DIR}/${dir}/${stamp}.ndjson`;
}

const describeIdentity = (identity: SessionIdentity | null): string =>
  identity === null
    ? "unidentified session"
    : `${identity.carName} at ${identity.trackName}` +
      (identity.trackConfig === "" ? "" : ` (${identity.trackConfig})`);

/**
 * Where main sends things, whether that is one desktop window or five overlays.
 *
 * `audio` is deliberately not `broadcast`: exactly one window decodes and plays
 * the clips. Sending them everywhere would have every overlay hold its own copy
 * of the same 660 KiB and every callout come out four times over.
 */
interface Surfaces {
  readonly broadcast: (channel: string, payload: unknown) => void;
  readonly audio: (channel: string, payload: unknown) => void;
  readonly alive: () => boolean;
  readonly onClosed: (callback: () => void) => void;
}

/** What the control window is showing. Kept here so a new window can be told. */
let sessionStatus: SessionStatus = {
  phase: "stopped",
  autoStart: true,
  runAtLogin: false,
  startMinimized: false,
  trackName: null,
  carName: null,
  noteSetId: null,
  detail: null,
  recordingTo: null,
  packs: [],
  pinnedNoteSetId: null,
  remoteMine: [],
  libraryBusy: null,
  contentHint: null,
  testMode: false,
  showWelcome: false,
};

/** A long library operation in progress (library.ts), shown in Track Coach. */
let libraryBusy: string | null = null;
/** Who was signed in at the last account change; undefined before the first. */
let lastAccountUser: string | null | undefined;

/**
 * Every pack on disk, refreshed rather than re-read on every status broadcast.
 *
 * The list changes when someone adds or renders a note set, which is rare; the
 * status broadcasts on every phase change, which is not.
 */
let packs: NoteSetPack[] = [];
/** The mapped tracks behind `packs`, for commands that name one by key. */
let listedTracks: TrackSummary[] = [];

/**
 * How many of a set's callouts have no audio in this voice, or audio of words
 * that have changed since: what a render would redo. A set nobody has
 * rendered counts every callout.
 */
async function staleCallouts(repos: ReturnType<typeof localRepositories>, noteSetId: string, voiceId: string): Promise<number> {
  try {
    const [set, pack] = await Promise.all([repos.noteSets.get(noteSetId), repos.audio.getPack(noteSetId, voiceId)]);
    if (set === null) return 0;
    return set.notes.filter(
      (n) =>
        n.dirty ||
        pack?.files[audioKey(n.id, "full")]?.text !== n.text ||
        pack?.files[audioKey(n.id, "short")]?.text !== n.textShort,
    ).length;
  } catch {
    return 0;
  }
}

async function refreshPacks(): Promise<void> {
  try {
    const dataDir = resolveDataDir(settings().get());
    const repos = localRepositories(dataDir);
    const [summaries, tracks, links] = await Promise.all([
      repos.noteSets.listAll(),
      repos.trackMaps.listTracks(),
      new LocalContentIndex(dataDir).all(),
    ]);
    listedTracks = tracks;

    const voiceId = settings().get().voiceId;
    const stale = new Map(await Promise.all(summaries.map(async (p) => [p.id, await staleCallouts(repos, p.id, voiceId)] as const)));

    const written = summaries.map((p) => {
      const link = links[p.id];
      const item = link === undefined ? undefined : knownItem(link.itemId);
      return {
        id: p.id,
        trackName: trackNameFor(tracks, p.trackKey.trackId, p.trackKey.configId),
        carClass: p.carClass,
        noteCount: p.noteCount,
        status: p.status,
        trackId: p.trackKey.trackId,
        configId: p.trackKey.configId,
        active: false,
        audio: { stale: stale.get(p.id) ?? 0, rendering: isRendering(p.id) },
        content:
          link === undefined
            ? null
            : {
                itemId: link.itemId,
                origin: link.origin,
                version: link.version,
                latestVersion: item?.latestVersion ?? null,
                policy: link.policy,
                stars: item?.starCount ?? null,
                downloads: item?.downloadCount ?? null,
              },
      };
    });

    // Tracks that have been mapped but have nothing to say yet. Listing them
    // beside the real packs is the point: "I have driven here and there are no
    // notes" is the moment authoring starts, and it is otherwise invisible —
    // you would have to know the track was missing to go looking for it.
    const authored = new Set(written.map((p) => `${p.trackId}:${p.configId}`));
    const empty = tracks
      .filter((t) => !authored.has(`${t.key.trackId}:${t.key.configId}`))
      .map((t) => ({
        id: "",
        trackName: `${t.trackName}${t.configName === "" ? "" : ` — ${t.configName}`}`,
        carClass: "",
        noteCount: 0,
        status: "no notes yet",
        trackId: t.key.trackId,
        configId: t.key.configId,
        active: false,
        audio: null,
        content: null,
      }));

    packs = [...written, ...empty];
  } catch (err) {
    process.stderr.write(`could not list note sets: ${String(err)}
`);
    packs = [];
  }
  broadcastStatus({});
}

const trackNameFor = (
  tracks: readonly { key: { trackId: number; configId: string }; trackName: string; configName: string }[],
  trackId: number,
  configId: string,
): string => {
  const found = tracks.find((t) => t.key.trackId === trackId && t.key.configId === configId);
  if (found === undefined) return `track ${trackId}`;
  return `${found.trackName}${found.configName === "" ? "" : ` — ${found.configName}`}`;
};

function broadcastStatus(patch: Partial<SessionStatus>): void {
  const current = settings().get();
  const next = { ...sessionStatus, ...patch };
  sessionStatus = {
    ...next,
    autoStart: current.autoStart,
    runAtLogin: current.runAtLogin,
    startMinimized: current.startMinimized,
    pinnedNoteSetId: current.noteSetId,
    packs: packs.map((p) => ({ ...p, active: p.id === next.noteSetId })),
    remoteMine: remoteMinePacks(),
    libraryBusy,
    testMode,
    showWelcome: !current.welcomed,
  };
  currentSurfaces?.broadcast(SESSION_STATUS_CHANNEL, sessionStatus);
  controlWindow?.webContents.send(SESSION_STATUS_CHANNEL, sessionStatus);
  refreshTrayMenu();
}

/**
 * What the sim last reported, for the importer to fill in track and car from.
 * Null whenever no session is connected — a stale track would be worse than none.
 */
let liveIdentity: SessionIdentity | null = null;

/**
 * The map and reference lap for the track being driven, straight from the
 * repository, for when no note set brought them along.
 */
async function broadcastTrackViews(
  surfaces: Surfaces,
  identity: SessionIdentity | null,
  withReference: boolean,
): Promise<void> {
  if (identity?.trackKey == null) return;
  const repos = localRepositories(resolveDataDir(settings().get()));
  try {
    const version = await repos.trackMaps.latestVersion(identity.trackKey);
    const map = version === null ? null : await repos.trackMaps.get({ ...identity.trackKey, mapVersion: version });
    if (map !== null) surfaces.broadcast(MAP_CHANNEL, toMapView(map, []));
    if (!withReference) return;
    const cars = await repos.referenceLaps.listCars(identity.trackKey);
    const carId = cars.includes(identity.carId) ? identity.carId : cars[0];
    const lap = carId === undefined ? null : await repos.referenceLaps.get(identity.trackKey, carId);
    if (lap !== null) surfaces.broadcast(REFERENCE_CHANNEL, toReferenceView(lap, map));
  } catch (err) {
    process.stderr.write(`could not load the map for ${identity.trackName}: ${String(err)}
`);
  }
}

async function runTelemetryLoop(surfaces: Surfaces): Promise<void> {
  const token = ++loopToken;
  const source = createSource();

  // Connect FIRST. The sim knows which track and car it loaded, and that is what
  // decides the note set — asking a driver to pick one that matches is asking
  // them to restate something the sim has already said. It also makes a failed
  // connect cheap: nothing has been loaded yet to throw away.
  await source.connect();

  // Superseded while connecting — settings changed, or Stop was pressed. Let go
  // of the SDK before the next loop takes it.
  if (token !== loopToken) {
    await source.close();
    return;
  }

  // The sim's key, resolved to the layout id this app already files that track
  // id under — the same layout, whatever another source named it.
  const reported = source.identity;
  const identity =
    reported?.trackKey == null
      ? reported
      : { ...reported, trackKey: await canonicalTrackKey(resolveDataDir(settings().get()), reported.trackKey) };
  liveIdentity = identity;

  // Before anything reads the track from disk: fetch its map if someone has
  // already shared one, so this session has a map from the first lap and the
  // auto-mapper does not cut a competing one.
  // Not in test mode: nothing was driven, so there is nothing to report or fetch for.
  if (!testMode) {
    await syncBeforeSession(resolveDataDir(settings().get()), identity, (line) => process.stdout.write(line));
  }
  if (token !== loopToken) {
    await source.close();
    return;
  }

  const chosen = await noteSetForTrack(identity, resolveDataDir(settings().get()));
  if (chosen.detail !== null) process.stdout.write(`${chosen.detail}\n`);
  rememberNoteSet(identity, chosen.id);

  let session: LoadedSession | null = null;
  try {
    session = await createSession(chosen.id);
  } catch (err) {
    process.stderr.write(`could not load note set: ${String(err)}\n`);
  }

  for (const warning of session?.warnings ?? []) {
    process.stderr.write(`warning: ${warning}\n`);
  }

  if (session?.mapView != null) {
    surfaces.broadcast(MAP_CHANNEL, session.mapView);
  } else {
    // No note set, or one without a map — but the track may well be mapped,
    // and the map and the delta bar are worth having without any callouts.
    await broadcastTrackViews(surfaces, identity, session?.reference == null);
  }

  if (session?.reference != null) {
    surfaces.broadcast(REFERENCE_CHANNEL, session.reference);
    process.stdout.write(
      `reference lap: car ${session.reference.carId}, ` +
        `${session.reference.lapTimeS.toFixed(3)}s, ` +
        `${session.reference.corners.length} corners\n`,
    );
  }

  // Ship every clip to the renderer once, up front, so the trigger path is a
  // lookup rather than a read (§4.5).
  if (session?.audio != null) {
    const clips: AudioClip[] = [...session.audio.clips].map(([key, wav]) => ({ key, wav }));
    surfaces.audio(AUDIO_PRELOAD_CHANNEL, clips);
    process.stdout.write(
      `preloaded ${clips.length} clips, ${(session.audio.totalBytes / 1024).toFixed(0)} KiB\n`,
    );
  }

  // §9 asks for always-on recording, and the reason is good: "the moment this
  // becomes opt-in, the interesting lap is the one you didn't record." But that
  // argument is about laps you might want to *cut a map from*, and once a track
  // has a map there is nothing left to cut — every further session writes a
  // couple of megabytes a minute to answer a question already answered.
  //
  // So it stays always-on for a track nobody has mapped yet, and stops for one
  // that is done. The condition is deliberately "is there a map", not a setting:
  // a driver should never have to know to switch it on before the lap that
  // mattered.
  const mapped = await haveTrackData(identity, resolveDataDir(settings().get()));
  // Test mode replays a lap rather than driving one: nothing new to keep.
  const recorder = mapped || testMode
    ? null
    : new NdjsonRecorder(recordingPath(identity), {
        startedAt: new Date().toISOString(),
        source: source.name,
        ...(identity ?? {}),
      });

  process.stdout.write(
    recorder === null
      ? testMode
        ? "not recording — test mode replays a lap\n"
        : `not recording — ${describeIdentity(identity)} is already mapped\n`
      : `recording ${describeIdentity(identity)} -> ${recorder.path}\n`,
  );

  // Only now is the car known (§13 Q2). Loading pinned a note set and a
  // reference lap without one, so this is the first moment either can be checked
  // against what is actually being driven.
  if (session !== null) {
    for (const warning of await carWarnings(
      resolveDataDir(settings().get()),
      session.noteSet,
      session.reference,
      source.identity,
    )) {
      process.stderr.write(`warning: ${warning}\n`);
    }
  }

  // An unmapped track gets its map from the first clean lap (auto-map.ts).
  const autoMapper = await AutoMapper.forSession(
    resolveDataDir(settings().get()),
    identity,
    (event) => {
      // Shared whether or not any overlay is open to show it.
      void shareCut(event, (line) => process.stdout.write(line));
      if (!surfaces.alive()) return;
      if (session?.mapView == null) {
        surfaces.broadcast(MAP_CHANNEL, toMapView(event.map, session?.noteSet.notes ?? []));
      }
      surfaces.broadcast(REFERENCE_CHANNEL, toReferenceView(event.reference, event.map));
      if (event.kind === "mapped") {
        broadcastStatus({ detail: `mapped ${event.map.trackName} from lap ${event.lap.lap}` });
        void refreshPacks();
      }
    },
    (line) => process.stdout.write(line),
  );

  setSessionLive(true, source instanceof IRacingAdapter);
  broadcastStatus({
    phase: "running",
    trackName: identity?.trackName ?? null,
    carName: identity?.carName ?? null,
    noteSetId: chosen.id,
    detail: chosen.detail,
    recordingTo: recorder?.path ?? null,
    contentHint: null,
  });
  // No callouts for this combo: say how many packs Content has for it, rather
  // than starting silent. After the session is up, so a slow network never
  // delays it.
  if (chosen.id === null) void hintContent(identity);

  const lapTimer = new LapTimer();
  const raceView = new RaceViewBuilder();
  let raceSentAt = 0;
  let raceShown = false;

  // `isDestroyed()` alone is not enough: a render frame is disposed before its
  // BrowserWindow reports itself destroyed, so a loop checking only that races
  // teardown and floods the log with "Render frame was disposed".
  let stopped = false;
  surfaces.onClosed(() => {
    stopped = true;
    void source.close();
  });

  try {
    for await (const frame of source) {
      if (stopped || token !== loopToken || !surfaces.alive()) break;

      // Always-on recording (§9). Every lap anyone drives must be replayable —
      // the moment this becomes opt-in, the interesting lap is the unrecorded one.
      recorder?.write(frame);
      autoMapper?.push(frame);

      const lapElapsedS = lapTimer.update(frame.sessionTimeS, frame.lapDistPct);
      let suppressedBy: StateFrame["suppressedBy"] = null;

      if (session !== null) {
        const result = session.engine.tick(toTickInput(frame));
        suppressedBy = result.suppressedBy;

        for (const event of result.events) {
          const view: EngineEventView = {
            kind: event.kind,
            noteId: event.noteId,
            detail: event.kind === "play" ? event.variant : event.reason,
            leadM: event.kind === "play" ? event.leadM : null,
            dAheadM: event.dAheadM,
            atPct: event.atPct,
          };
          surfaces.broadcast(ENGINE_EVENT_CHANNEL, view);

          if (event.kind === "drop") {
            process.stdout.write(`DROP ${event.noteId} (${event.reason})\n`);
            continue;
          }

          const key = audioKey(event.noteId, event.variant);
          process.stdout.write(`PLAY ${key} (${event.durationMs}ms)\n`);

          // Silent while the sim is not the window in front, like the overlays:
          // a callout about T1 is noise over a browser.
          if (session.audio?.clips.has(key) === true && !mutedForFocus()) {
            const command: AudioPlayCommand = {
              key,
              noteId: event.noteId,
              durationMs: event.durationMs,
            };
            surfaces.audio(AUDIO_PLAY_CHANNEL, command);
          }
        }
      }

      if (!surfaces.alive()) break;
      surfaces.broadcast(
        STATE_FRAME_CHANNEL,
        toStateFrame(
          frame,
          source.name,
          session,
          suppressedBy,
          lapElapsedS,
          // A recording has no revs or force feedback; test mode makes them up
          // so the shift lights and FFB bar are not dead.
          source.dash?.() ?? (testMode ? sampleDash(frame.speedMps, frame.brake) : null),
        ),
      );

      // The race around the car, on its own slower clock.
      if (frame.tMs - raceSentAt >= RACE_INTERVAL_MS || frame.tMs < raceSentAt) {
        raceSentAt = frame.tMs;
        // A recording holds one car. In test mode a made-up field is put
        // around it, so Standings, Relatives, Radar, Fuel, Tyres and Weather
        // have something to show — the point of test mode is seeing everything.
        const snapshot =
          source.race?.() ??
          (testMode
            ? sampleRaceSnapshot({
                elapsedS: frame.tMs / 1000,
                lapS: session?.reference?.lapTimeS ?? 100,
                trackLengthM: session?.noteSet.lengthM ?? session?.mapView?.lengthM ?? 4000,
                playerDistance: frame.lap + frame.lapDistPct,
              })
            : null);
        if (snapshot !== null) {
          surfaces.broadcast(RACE_CHANNEL, raceView.build(snapshot));
          raceShown = true;
        } else if (raceShown) {
          surfaces.broadcast(RACE_CHANNEL, null);
          raceShown = false;
        }
      }
    }
  } finally {
    await source.close();
    await recorder?.close();
    // A lap that ended just before the sim closed still gets its map.
    await autoMapper?.settled();
    // Only if no newer loop has taken over — a settings change starts the next
    // one before this one has finished closing, and it may already be live.
    if (token === loopToken) setSessionLive(false);
    // Leave nothing behind: the last race on screen after the sim has gone
    // reads as a live one.
    if (raceShown && surfaces.alive()) surfaces.broadcast(RACE_CHANNEL, null);
  }
}

// ESM preload scripts must carry the .mjs extension, which is why the source is
// preload.mts — tsc emits .mjs from .mts and .js from .ts.
const PRELOAD = fileURLToPath(new URL("./preload.mjs", import.meta.url));
const PAGE = fileURLToPath(new URL("../static/index.html", import.meta.url));
/** The built-in themes' stylesheets and templates: static/themes/<id>/. */
const BUILTIN_THEME_DIR = fileURLToPath(new URL("../static/themes/", import.meta.url));

/**
 * A built-in theme's files. Read on every apply rather than once, so editing
 * them in development restyles the overlays on the next theme change.
 */
const builtinThemeAssets: ThemeAssets = (id) => {
  const root = join(BUILTIN_THEME_DIR, id);
  const read = (path: string): string | undefined => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  };
  const templates: Record<string, string> = {};
  try {
    for (const file of readdirSync(join(root, "templates"))) {
      if (file.endsWith(".html")) templates[file.slice(0, -".html".length)] = read(join(root, "templates", file)) ?? "";
    }
  } catch {
    // A built-in with no templates of its own.
  }
  const css = read(join(root, "theme.css"));
  return { ...(css !== undefined ? { css } : {}), templates };
};

/** What the overlays are sent for a theme: tokens as variables, plus stylesheets and templates. */
const overlayTheme = (theme: Theme): ThemeView => themeView(theme, builtinThemeAssets);

/**
 * Which panels to open. `EXXEED_PANELS=map,delta` for a subset; the active
 * overlay profile's panels otherwise. Unknown names are called out rather than
 * ignored — a typo that silently opens nothing is a bad afternoon.
 */
function chosenPanels(): PanelId[] {
  const raw = env("EXXEED_PANELS");
  if (raw !== undefined) {
    const wanted = raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
    for (const name of wanted.filter((s) => !isPanelId(s))) {
      process.stderr.write(`unknown panel "${name}" — known: ${PANELS.join(", ")}\n`);
    }
  }

  // `settings().get().panels` already carries EXXEED_PANELS (SettingsStore runs
  // it through `withEnvOverrides`), so an override reads from there; otherwise
  // it is whichever profile the Overlays section has active.
  const chosen = raw !== undefined ? [...settings().get().panels] : [...profileStore().active.panels];

  // The telemetry panel is the raw channel dump — lapDistPct to five places,
  // gear, the suppression flags. That is a debugging instrument, not something
  // to read at 200 km/h, and it is the one panel that tells a driver nothing
  // they cannot see on the car's own dash. Keep it for development, hide it
  // otherwise, and leave it selectable so nobody's saved profile loses its place.
  return debugEnabled() ? chosen : chosen.filter((p) => p !== "telemetry");
}

/**
 * Renderer console output to the terminal.
 *
 * Without this a drawing error is completely silent: the canvas simply stays
 * blank, the process keeps running, and the log looks healthy. Anything running
 * headless — which is how this gets checked most of the time — has no devtools
 * to look in.
 */
function forwardRendererConsole(window: BrowserWindow): void {
  window.webContents.on("console-message", (_event, level, message, line, source) => {
    if (level < 2) return; // warnings and errors only
    const where = source === "" ? "" : ` (${source.split("/").pop() ?? source}:${String(line)})`;
    process.stderr.write(`renderer: ${message}${where}\n`);
  });
}

/** Several windows: everything goes everywhere except the audio. */
function overlaySurfaces(layout: OverlayLayout): Surfaces {
  // The decoded clips live in whichever window plays the audio. Kept, so that
  // when that overlay is closed the next one can be given them at once.
  let preload: unknown = null;
  let preloadedTo: BrowserWindow | null = null;
  layout.onWindowsChanged(() => {
    const host = layout.windows[0];
    if (host !== undefined && host !== preloadedTo && preload !== null) {
      sendTo(host, AUDIO_PRELOAD_CHANNEL, preload);
      preloadedTo = host;
    }
  });
  return {
    broadcast: (channel, payload) => layout.broadcast(channel, payload),
    // The first panel opened hosts the audio. Which one it is does not matter —
    // nothing about it is visible — but it has to be exactly one.
    audio: (channel, payload) => {
      const host = layout.windows[0];
      if (host === undefined) return;
      if (channel === AUDIO_PRELOAD_CHANNEL) {
        preload = payload;
        preloadedTo = host;
      }
      sendTo(host, channel, payload);
    },
    alive: () => layout.windows.some((w) => !w.isDestroyed()),
    onClosed: (callback) => {
      // Only when the LAST one goes: closing the delta bar should not stop the
      // engine for everything else.
      for (const window of layout.windows) {
        window.once("closed", () => {
          if (layout.windows.length === 0) callback();
        });
      }
    },
  };
}

/** The surfaces the running loop is talking to, so a reload can reuse them. */
let currentSurfaces: Surfaces | null = null;

/** The open overlays, so the menu can unlock them. Null outside overlay mode. */
let overlayLayout: OverlayLayout | null = null;

/**
 * Whether the Overlays section has an explicit "Edit" in progress.
 *
 * Deliberately not the same thing as `OverlayLayout#editing` (grabbable vs
 * click-through): overlays are grabbable BY DEFAULT (§7) whether or not anyone
 * is arranging them from this window, so that flag is true almost all the
 * time and would make the Overlays section show "editing" the moment the app
 * opens. This is only true between an explicit "Edit" and the matching "Done".
 */
let overlayEditingActive = false;

/**
 * The synthetic lap fed to the overlays while arranging them with nothing
 * real to show — see `overlay-preview.ts`. Null whenever it should not be
 * running.
 */
let overlayPreview: OverlayPreview | null = null;

/**
 * Start or stop the preview feed to match what is currently true, rather than
 * each caller deciding for itself.
 *
 * Runs only while someone is arranging overlays AND no real session is
 * running — a running session already has real telemetry, which answers "what
 * will this look like" better than a fabricated lap ever could.
 */
function syncOverlayPreview(): void {
  // !sessionLive rather than !wantRunning: while the app is only waiting for
  // the sim there is no real telemetry either, so arranging still gets the
  // sample lap to look at.
  const shouldRun = overlayEditingActive && !sessionLive && overlayLayout !== null;
  if (shouldRun && overlayPreview === null) {
    // Reads `overlayLayout` at send time, not at start time, so the preview
    // keeps following it across a profile switch mid-edit instead of needing
    // to be restarted for one.
    overlayPreview = startOverlayPreview((channel, payload) => overlayLayout?.broadcast(channel, payload));
  } else if (!shouldRun && overlayPreview !== null) {
    overlayPreview.stop();
    overlayPreview = null;
  }
}

/** The theme a profile wears: its own, else the one set before themes were per profile. */
const profileThemeId = (profileId: string): string =>
  themes().find(profileStore().profiles.find((p) => p.id === profileId)?.theme ?? settings().get().overlayTheme).id;
/** The theme the open overlays wear: the active profile's. */
const activeThemeId = (): string => profileThemeId(profileStore().activeId);

let themeStore: ThemeStore | null = null;
/**
 * The custom themes, read on first use and watched from then on: a save from
 * any editor restyles the open overlays and refreshes the picker.
 */
function themes(): ThemeStore {
  themeStore ??= new ThemeStore(() => {
    {
      const view = overlayTheme(themes().find(activeThemeId()));
      overlayLayout?.broadcast(THEME_CHANNEL, view);
      overlayLayout?.setDesignSizes(view.sizes);
    }
    broadcastProfiles();
  });
  return themeStore;
}

/**
 * Give a profile a theme (the active one's when none is named): remembered,
 * and if that profile is on screen, sent to its overlays (never a restart).
 */
function applyTheme(id: string, profileId: string = profileStore().activeId): void {
  const theme = themes().find(id);
  profileStore().setTheme(profileId, theme.id);
  if (profileId === profileStore().activeId) {
    // Kept in step for anything still reading the old global setting.
    settings().updateQuietly({ overlayTheme: theme.id });
    const view = overlayTheme(theme);
    overlayLayout?.broadcast(THEME_CHANNEL, view);
    overlayLayout?.setDesignSizes(view.sizes);
  }
  broadcastProfiles();
}

/**
 * The main display: what the profile editor's screen stands for. Positions
 * are kept in its DIPs; the editor works in the profile's resolution, scaled
 * onto it.
 */
function editorDisplay(): { bounds: Electron.Rectangle; pixels: { width: number; height: number } } {
  const display = screen.getPrimaryDisplay();
  return {
    bounds: display.bounds,
    pixels: {
      width: Math.round(display.bounds.width * display.scaleFactor),
      height: Math.round(display.bounds.height * display.scaleFactor),
    },
  };
}

/** A profile's resolution: its own, else the main display's. */
function profileScreen(profileId: string): { width: number; height: number } {
  return profileStore().profiles.find((p) => p.id === profileId)?.screen ?? editorDisplay().pixels;
}

/** Screen pixels in a profile's resolution to desktop DIPs on the main display. */
function toDesktop(profileId: string, r: ScreenRect): PlacedBounds {
  const { bounds } = editorDisplay();
  const res = profileScreen(profileId);
  const fx = bounds.width / res.width;
  const fy = bounds.height / res.height;
  return { x: bounds.x + r.x * fx, y: bounds.y + r.y * fy, width: r.width * fx, height: r.height * fy };
}

/** Desktop DIPs to screen pixels in a profile's resolution. */
function toScreen(profileId: string, b: PlacedBounds): ScreenRect {
  const { bounds } = editorDisplay();
  const res = profileScreen(profileId);
  const fx = res.width / bounds.width;
  const fy = res.height / bounds.height;
  return {
    x: Math.round((b.x - bounds.x) * fx),
    y: Math.round((b.y - bounds.y) * fy),
    width: Math.round(b.width * fx),
    height: Math.round(b.height * fy),
  };
}

/** Every overlay a profile could show, enabled or not, for the editor to place. */
const editablePanels = (): PanelId[] => PANELS.filter((p) => p !== "telemetry" || debugEnabled());

/** Where a profile's overlays are, on its screen. */
function editorLayout(profileId: string): OverlayEditorLayout {
  const view = overlayTheme(themes().find(profileThemeId(profileId)));
  const designOf = (p: PanelId): readonly [number, number] => view.sizes[p] ?? [PANEL_SPECS[p].width, PANEL_SPECS[p].height];
  const profile = profileStore().profiles.find((p) => p.id === profileId);
  // Enabled first, in their order, so default places stack the way the windows would open.
  const enabled = profile?.panels ?? [];
  const panels = [...enabled, ...editablePanels().filter((p) => !enabled.includes(p))];
  const places =
    profileId === profileStore().activeId && overlayLayout !== null
      ? overlayLayout.places(panels)
      : profilePlaces(profileId, panels, designOf);
  const rects: Partial<Record<PanelId, ScreenRect>> = {};
  const designs: Record<string, readonly [number, number]> = {};
  for (const panel of panels) {
    const b = places[panel];
    if (b !== undefined) rects[panel] = toScreen(profileId, b);
    designs[panel] = designOf(panel);
  }
  return {
    profileId,
    screen: profileScreen(profileId),
    display: editorDisplay().pixels,
    rects,
    designs,
    background: profile?.hasBackground === true ? readBackground(profileId) : null,
  };
}

/** A profile's editor screenshot as a data: URL, typed by its first bytes. */
function readBackground(profileId: string): string | null {
  const path = backgroundPath(profileId);
  if (!existsSync(path)) return null;
  try {
    const bytes = readFileSync(path);
    const type =
      bytes[0] === 0x89 && bytes[1] === 0x50
        ? "image/png"
        : bytes[0] === 0xff && bytes[1] === 0xd8
          ? "image/jpeg"
          : bytes.subarray(8, 12).toString("ascii") === "WEBP"
            ? "image/webp"
            : null;
    return type === null ? null : `data:${type};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

/** A data: URL from the editor's file picker to image bytes, if it is a PNG, JPEG or WebP under 25 MB. */
function decodeImage(dataUrl: string): Buffer | null {
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (match === null) return null;
  const bytes = Buffer.from(match[2]!, "base64");
  return bytes.byteLength > 0 && bytes.byteLength <= 25 * 1024 * 1024 ? bytes : null;
}

/**
 * Place an overlay of a profile from the editor, and its mirrored partner
 * with it, as dragging the window itself would.
 */
function placePanel(profileId: string, panel: PanelId, rect: ScreenRect | null): void {
  const live = profileId === profileStore().activeId ? overlayLayout : null;
  const put = (p: PanelId, b: PlacedBounds | null): void => {
    if (live !== null) live.place(p, b);
    else placeInProfile(profileId, p, b);
  };
  const bounds = rect === null ? null : toDesktop(profileId, rect);
  put(panel, bounds);
  const partner = MIRROR_PAIRS[panel];
  const mirrored = (p: PanelId): boolean => profileStore().settingsOf(profileId, p).style !== "free";
  // An open window's partner follows by itself (OverlayLayout#mirrorFrom).
  if (live === null && partner !== undefined && bounds !== null && mirrored(panel) && mirrored(partner)) {
    put(partner, mirrorBounds(bounds, editorDisplay().bounds));
  }
}

/** The control window's size before the profile editor made it bigger, to go back to. */
let beforeEditor: Electron.Rectangle | null = null;
/** The sample lap the profile editor previews with: to the control window only. */
let editorPreview: OverlayPreview | null = null;

function setEditorOpen(open: boolean): void {
  const window = controlWindow;
  if (open && editorPreview === null && window !== null) {
    editorPreview = startOverlayPreview((channel, payload) => {
      if (!window.isDestroyed()) window.webContents.send(channel, payload);
    });
  } else if (!open && editorPreview !== null) {
    editorPreview.stop();
    editorPreview = null;
  }
  if (window === null || window.isDestroyed()) return;
  // Three columns and a screen between them need room; the editor asks for it.
  const want = { width: 1360, height: 860 };
  if (open && !window.isMaximized()) {
    const now = window.getBounds();
    const area = screen.getDisplayMatching(now).workArea;
    if (now.width < want.width || now.height < want.height) {
      beforeEditor ??= now;
      const width = Math.min(area.width, Math.max(now.width, want.width));
      const height = Math.min(area.height, Math.max(now.height, want.height));
      window.setBounds({
        x: Math.round(area.x + (area.width - width) / 2),
        y: Math.round(area.y + (area.height - height) / 2),
        width,
        height,
      });
    }
  } else if (!open && beforeEditor !== null) {
    if (!window.isMaximized()) window.setBounds(beforeEditor);
    beforeEditor = null;
  }
}

/** What the Overlays section of the control window shows. */
function overlayProfilesView(): OverlayProfilesView {
  return {
    profiles: profileStore().profiles,
    activeProfileId: profileStore().activeId,
    editing: overlayEditingActive,
    debugEnabled: debugEnabled(),
    hideWhenSimUnfocused: settings().get().hideOverlaysWhenSimUnfocused,
    themes: [
      ...BUILTIN_THEMES.map(({ id, name, description }) => ({ id, name, description, custom: false, problems: [] })),
      ...themes().list().map(({ theme, problems }) => ({
        id: theme.id,
        name: theme.name,
        description: theme.description,
        custom: true,
        problems,
      })),
    ],
    themeId: activeThemeId(),
    panelParts: PANEL_PARTS,
    panelStyles: PANEL_STYLES,
  };
}

function broadcastProfiles(): void {
  if (controlWindow !== null && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send(OVERLAY_PROFILES_CHANGED_CHANNEL, overlayProfilesView());
  }
}

/**
 * Open the active profile's overlay windows.
 *
 * `enterEditing` is for the moment a profile switch was itself requested in
 * order to arrange it — Overlays section "Edit" on a profile that was not
 * already active. Without it, switching profiles would open the new windows
 * locked and hidden, and arranging them would need a second click most people
 * would not think to make.
 */
function startOverlays(enterEditing = false): void {
  process.stdout.write(FULLSCREEN_WARNING);

  const layout = new OverlayLayout(profileStore().activeId, () => showControlWindow());
  overlayLayout = layout;
  // What an overlay added during a session needs to be caught up with.
  layout.setSticky([MAP_CHANNEL, REFERENCE_CHANNEL, RACE_CHANNEL, SESSION_STATUS_CHANNEL]);
  // A left/right pair moves together unless the driver set it free.
  layout.setMirrorTest((panel) => profileStore().settingsOf(profileStore().activeId, panel).style !== "free");
  // Before any window opens: each takes its overlay's shape from the theme.
  layout.setDesignSizes(overlayTheme(themes().find(activeThemeId())).sizes);
  // An overlay dragged or sized on screen: the profile editor redraws its place.
  const profileId = profileStore().activeId;
  layout.onLayoutSaved(() => {
    if (controlWindow !== null && !controlWindow.isDestroyed()) {
      controlWindow.webContents.send(OVERLAY_LAYOUT_CHANGED_CHANNEL, { profileId });
    }
  });

  const panels = chosenPanels();

  panels.forEach((panel, index) => {
    const window = layout.create(panel, index, panels, PRELOAD, PAGE);
    forwardRendererConsole(window);
  });

  process.stdout.write(`  ${panels.length} overlays: ${panels.join(", ")}\n`);

  // Wait for the renderers before sending anything, or the map, the reference
  // and the clips all land in pages that are not listening yet.
  const last = layout.windows[layout.windows.length - 1];
  if (last === undefined) {
    broadcastProfiles();
    return;
  }
  last.webContents.once("did-finish-load", () => {
    // Only publish the surfaces. Whether a session should be running is the
    // supervisor's business, not a window's: a window finishing load says
    // nothing about whether the sim is up.
    currentSurfaces = overlaySurfaces(layout);
    overlayEditingActive = enterEditing;
    if (enterEditing) layout.setEditing(true);
    // Read the session state NOW rather than when the windows were created:
    // the sim can connect between those two moments.
    syncOverlayVisibility();
    // A supervisor that gave up earlier for lack of surfaces — or was never
    // started, which autostart can race — picks back up here. One that is
    // already running just keeps going; `supervising` guards against a second.
    if (wantRunning) void supervise();
    syncOverlayPreview();
    broadcastStatus({});
    broadcastProfiles();
  });
}

/**
 * Close the active profile's windows and open the (possibly new) active
 * profile's instead — a profile switch, a panel-set edit, or the active
 * profile being deleted out from under itself all land here.
 *
 * Async because `OverlayLayout#destroy` waits for every window to actually
 * close before this returns — see its doc comment for why starting the new
 * layout any earlier is a race on the global arrange-overlays shortcut.
 */
async function restartOverlaysForActiveProfile(enterEditing: boolean): Promise<void> {
  const old = overlayLayout;
  overlayLayout = null;
  if (old !== null) await old.destroy();
  startOverlays(enterEditing);
}

/**
 * Serialises calls to `restartOverlaysForActiveProfile`.
 *
 * A person can click "Edit" on a second profile before the first restart's
 * `destroy()` has resolved — two profile commands arriving before either has
 * finished tearing down its windows. Without this, the second restart would
 * read `overlayLayout` while it is still the first restart's, race it to
 * `null`, and the two could each create a fresh set of windows the other
 * never knew to destroy. Chaining onto whatever is already in flight makes
 * every restart wait for the one before it, however it was requested.
 */
let overlayTransition: Promise<void> = Promise.resolve();

function queueOverlayRestart(enterEditing: boolean): void {
  overlayTransition = overlayTransition.then(
    () => restartOverlaysForActiveProfile(enterEditing),
    () => restartOverlaysForActiveProfile(enterEditing),
  );
}

/**
 * The active profile's overlays changed: open the ones added and close the
 * ones removed, leaving every other overlay exactly as it was — no flicker,
 * nothing reloaded, the session carrying on. Only going to or from no
 * overlays at all rebuilds, because a session needs a window to run in.
 */
function queueOverlayChange(): void {
  overlayTransition = overlayTransition.then(
    () => changeOverlaysInPlace(),
    () => changeOverlaysInPlace(),
  );
}

async function changeOverlaysInPlace(): Promise<void> {
  const layout = overlayLayout;
  const panels = chosenPanels();
  if (layout === null || layout.panels.length === 0 || panels.length === 0) {
    await restartOverlaysForActiveProfile(overlayEditingActive);
    return;
  }
  for (const window of layout.sync(panels, PRELOAD, PAGE)) forwardRendererConsole(window);
  process.stdout.write(`  ${panels.length} overlays: ${panels.join(", ")}\n`);
  syncOverlayVisibility();
  syncOverlayPreview();
  broadcastProfiles();
}

/** Enter or leave the Overlays section's edit session for the active profile. */
function setOverlayEditing(active: boolean): void {
  overlayEditingActive = active;
  overlayLayout?.setEditing(active);
  syncOverlayVisibility();
  syncOverlayPreview();
  broadcastProfiles();
}

/**
 * Rebuild the application menu.
 *
 * Electron menu checkboxes hold their own state, so the menu has to be rebuilt
 * whenever a toggle changes elsewhere — from the tray, or from another window —
 * or the tick and the setting drift apart.
 */
function rebuildMenu(): void {
  const current = settings().get();
  buildApplicationMenu({
    openPreferences: () => openPreferences(PRELOAD),
    openEditor: () => openEditor(PRELOAD),
    openImporter: () => openImporter(PRELOAD),
    renderAudio: () => requestRender(PRELOAD),
    toggleOverlayEdit: () => overlayLayout?.toggleEditing(),
    overlayMode: true,
    toggles: {
      autoStart: current.autoStart,
      runAtLogin: current.runAtLogin,
      startMinimized: current.startMinimized,
    },
    setToggle: (name, value) => {
      settings().updateQuietly(
        name === "runAtLogin" ? { runAtLogin: applyLoginItem(value) } : { [name]: value },
      );
      broadcastStatus({});
      rebuildMenu();
    },
  });
}

/** The control window — start/stop, and what the app is currently doing. */
let controlWindow: BrowserWindow | null = null;

/**
 * Set once the app is genuinely on its way out.
 *
 * Without it the close handler cannot tell "the user pressed X" from "the app is
 * quitting", and would keep the window alive through the quit.
 */
let quitting = false;

let tray: Tray | null = null;

const TRAY_ICON = fileURLToPath(new URL("../static/tray.png", import.meta.url));

function showControlWindow(): void {
  if (controlWindow === null || controlWindow.isDestroyed()) {
    openControlWindow();
    return;
  }
  controlWindow.show();
  controlWindow.focus();
}

/**
 * The tray icon, and the only way out of the app once the window is hidden.
 *
 * Built once and then only relabelled: rebuilding the menu on every status change
 * makes it flicker shut under the pointer on Windows.
 */
function createTray(): void {
  if (tray !== null) return;

  const icon = nativeImage.createFromPath(TRAY_ICON);
  if (icon.isEmpty()) {
    process.stderr.write(
      `tray icon missing at ${TRAY_ICON} — the tray is the only way to quit once ` +
        `the window is hidden, so closing the window will quit instead\n`,
    );
    return;
  }

  tray = new Tray(icon);
  tray.setToolTip("Exxeed");
  tray.on("click", () => showControlWindow());
  tray.on("double-click", () => showControlWindow());
  refreshTrayMenu();
}

function refreshTrayMenu(): void {
  if (tray === null) return;

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show Exxeed", click: () => showControlWindow() },
      { type: "separator" },
      {
        label: sessionStatus.phase === "stopped" ? "Start" : "Stop",
        click: () => (sessionStatus.phase === "stopped" ? startSession() : stopSession()),
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );

  tray.setToolTip(
    sessionStatus.phase === "running" && sessionStatus.trackName !== null
      ? `Exxeed — ${sessionStatus.trackName}`
      : `Exxeed — ${sessionStatus.phase}`,
  );
}

/**
 * Keep the OS login item in step with the setting.
 *
 * The list Windows keeps is the setting of record, so this writes it and then
 * reads it back: a checkbox that says "on" while Windows disagrees is worse than
 * having no checkbox.
 */
function applyLoginItem(runAtLogin: boolean): boolean {
  // Only meaningful for a packaged build — from source the "app" is electron.exe
  // with an argument, and registering that would launch a bare Electron at login.
  if (!app.isPackaged) return runAtLogin;

  app.setLoginItemSettings({ openAtLogin: runAtLogin, args: ["--minimized"] });
  return app.getLoginItemSettings().openAtLogin;
}

const CONTROL_PAGE = fileURLToPath(new URL("../static/control.html", import.meta.url));

function openControlWindow(): void {
  if (controlWindow !== null && !controlWindow.isDestroyed()) {
    controlWindow.focus();
    return;
  }

  const window = new BrowserWindow({
    ...windowBounds("control", { width: 620, height: 580 }),
    title: "Exxeed",
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  rememberWindow("control", window);

  controlWindow = window;

  // Closing hides to the tray rather than quitting. The app is meant to be left
  // running while the sim comes and goes, so "I am done looking at this window"
  // and "I am done with the app" are different intentions and the close button
  // is the first one.
  //
  // This is only safe because the tray exists. The overlays are frameless, have
  // no taskbar entry and are always-on-top, and the application menu hangs off
  // this window — without a tray icon, hiding it would leave the app running with
  // no surface at all to stop it from, which is exactly the trap the previous
  // version had.
  window.on("close", (event) => {
    if (quitting) return;
    // No tray means nowhere to hide TO. Hiding anyway would strand the app with
    // no visible surface and no way to quit, which is the trap this replaced —
    // so without a tray, close still means quit.
    if (tray === null) {
      quitting = true;
      return;
    }
    event.preventDefault();
    window.hide();
  });

  window.once("closed", () => {
    controlWindow = null;
  });
  void window.loadFile(CONTROL_PAGE);
  window.webContents.once("did-finish-load", () => {
    broadcastStatus({});
    broadcastProfiles();
  });
}

/**
 * True while the app should be connected, or trying to be.
 *
 * Separate from whether a loop is currently running: the sim coming and going is
 * expected, and "on" has to survive it. Stopping is the only thing that clears
 * this.
 */
let wantRunning = false;

/**
 * True while the sim is actually connected with a session loaded — not merely
 * wanted. This, not `wantRunning`, is what the overlays follow: the app is
 * meant to be left on while the sim comes and goes, and overlays sitting over
 * the desktop "waiting for the sim" are a row of empty rectangles over
 * whatever else is on screen. They appear when the sim does, and go when it
 * goes.
 */
let sessionLive = false;

/**
 * Whether the sim is the window in front. Only consulted for a live iRacing
 * session: a replay has no sim window to be in front, and gating on one would
 * hide the overlays for the whole of it.
 */
let simFocused = true;
let focusGated = false;
let focusWatcher: ForegroundWatcher | null = null;

/**
 * Show the overlays while someone is arranging them, or while a session is live
 * and the sim is in front. Alt-tab to a browser mid-session and they go with
 * the sim, rather than sitting always-on-top over whatever you switched to.
 */
function syncOverlayVisibility(): void {
  const gated = focusGated && settings().get().hideOverlaysWhenSimUnfocused;
  overlayLayout?.setVisible(overlayEditingActive || (sessionLive && (!gated || simFocused)));
}

/** Live iRacing, the setting on, and the sim not in front: no callouts. */
const mutedForFocus = (): boolean =>
  focusGated && settings().get().hideOverlaysWhenSimUnfocused && !simFocused;

function setSessionLive(live: boolean, gateOnSimFocus = false): void {
  if (sessionLive === live) return;
  sessionLive = live;
  // Pack updates wait for the session to end (library.ts); this is that end.
  if (!live) checkUpdatesNow();

  focusWatcher?.stop();
  focusWatcher = null;
  focusGated = false;
  simFocused = true;
  if (live && gateOnSimFocus) {
    focusWatcher = watchSimFocus(
      (focused) => {
        simFocused = focused;
        syncOverlayVisibility();
      },
      () => {
        const focused = BrowserWindow.getFocusedWindow();
        return focused !== null && (overlayLayout?.windows.includes(focused) ?? false);
      },
    );
    // Null where the foreground cannot be read: behave as though always in front.
    focusGated = focusWatcher !== null;
  }

  syncOverlayVisibility();
  syncOverlayPreview();
}
/** Guards against two supervisors racing after a rapid stop/start. */
let supervising = false;

/** Set when the running loop was ended to reload settings, so the next one starts at once. */
let restartRequested = false;

/** Ends the supervisor's current wait early — a mode change should not sit out a retry delay. */
let wakeSupervisor: (() => void) | null = null;

const sleepMs = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      wakeSupervisor = null;
      resolve();
    }
    wakeSupervisor = done;
  });

/**
 * Keep a session running for as long as the app is meant to be on.
 *
 * The sim is not a precondition, it is a participant: it starts after the app,
 * it restarts between sessions, and it exits while the app stays open. Treating
 * "not running yet" as a startup error made the app something you had to launch
 * in the right order. Waiting is the normal resting state.
 */
async function supervise(): Promise<void> {
  if (supervising) return;
  supervising = true;

  try {
    while (wantRunning) {
      const surfaces = currentSurfaces;
      if (surfaces === null) return;

      try {
        broadcastStatus({ phase: "waiting", detail: "waiting for the sim" });
        await runTelemetryLoop(surfaces);
        liveIdentity = null;
        // A clean return means the source ended — the sim closed, or the replay
        // finished. Either way, go back to waiting rather than giving up.
      } catch (err) {
        liveIdentity = null;
        const message = err instanceof Error ? err.message : String(err);
        // Not an error worth shouting about: it is the expected state whenever
        // the sim is not up yet, which is most of the time.
        broadcastStatus({
          phase: "waiting",
          detail: message,
          trackName: null,
          carName: null,
          noteSetId: null,
          recordingTo: null,
        });
        surfaces.broadcast(STATE_FRAME_CHANNEL, emptyFrame);
      }

      if (!wantRunning) break;
      if (restartRequested) {
        restartRequested = false;
        continue;
      }
      // No sim on this platform: nothing will change by retrying every two
      // seconds, only by switching test mode on, which restarts this loop.
      await sleepMs(!testMode && !isIRacingSupported() ? 30_000 : 2000);
    }
  } finally {
    supervising = false;
    if (!wantRunning) {
      broadcastStatus({
        phase: "stopped",
        contentHint: null,
        detail: null,
        trackName: null,
        carName: null,
        noteSetId: null,
        recordingTo: null,
      });
      currentSurfaces?.broadcast(STATE_FRAME_CHANNEL, emptyFrame);
    }
  }
}

function startSession(): void {
  if (wantRunning) return;
  wantRunning = true;
  // Deliberately does NOT show the overlays. "On" means "waiting for the
  // sim", and until the sim actually has a session there is nothing for them
  // to show — see `setSessionLive`.
  void supervise();
}

/**
 * Switch test mode, and restart whatever was running so the new source takes
 * over. Turning it on also turns the app on: pressing Test mode means "show
 * me", not "arm it for later".
 */
function setTestMode(on: boolean): void {
  if (testMode === on) return;
  testMode = on;
  broadcastStatus({});
  if (on && !wantRunning) {
    startSession();
    return;
  }
  // Ends the running loop at its next frame, or the supervisor's wait between
  // attempts; either way the supervisor starts the new source straight after.
  restartRequested = true;
  loopToken++;
  setSessionLive(false);
  wakeSupervisor?.();
  void supervise();
}

function stopSession(): void {
  wantRunning = false;
  testMode = false;
  // Bumping the token makes any running loop stop at its next frame.
  loopToken++;
  setSessionLive(false);
}

/**
 * macOS: a dock icon while any ordinary window is open, none when only overlays
 * are. The overlays are not something you switch to — and with the control
 * window hidden to the tray, an icon that opens nothing would just be noise.
 *
 * Windows needs none of this: each ordinary window gets its own taskbar button
 * while it is visible, and overlays set `skipTaskbar`.
 */
function syncDock(): void {
  if (process.platform !== "darwin" || app.dock === undefined) return;
  const ordinaryVisible = BrowserWindow.getAllWindows().some(
    (w) => !w.isDestroyed() && w.isVisible() && !isOverlayWindow(w),
  );
  if (ordinaryVisible) void app.dock.show();
  else app.dock.hide();
}

app.on("browser-window-created", (_event, window) => {
  // After the event, so `isVisible` and the overlay marker are up to date.
  const later = (): void => void setImmediate(syncDock);
  window.on("show", later);
  window.on("hide", later);
  window.on("closed", later);
  later();
});

app.on("second-instance", () => {
  if (app.isReady()) showControlWindow();
});

void app.whenReady().then(() => {
  if (!firstInstance) return;
  store = new SettingsStore();
  // Seeds the Default profile the first time this installs, or when migrating
  // from a version that had no profiles yet (§ `overlay-profiles.ts`).
  profiles = new OverlayProfileStore(
    settings().get().panels.length === 0 ? [...DEFAULT_PANELS] : settings().get().panels,
  );
  // Themes became per profile: every profile from before keeps the theme it was wearing.
  for (const profile of profiles.profiles) {
    if (profile.theme === undefined) profiles.setTheme(profile.id, settings().get().overlayTheme);
  }
  // One random id per copy of the app, for counting downloads once (M8).
  if (settings().get().installationId === null) {
    settings().updateQuietly({ installationId: randomUUID() });
  }
  installSettingsIpc(settings(), resolveDataDir, RECORDINGS_DIR);
  onAccountChange((view) => {
    if (view.signedIn) {
      void shareOnSignIn(resolveDataDir(settings().get()), (line) => process.stdout.write(line));
    }
    // Your own packs on the account depend on who is signed in — so check again
    // when that changes, not on every refresh of the view.
    if (view.userId !== lastAccountUser) {
      lastAccountUser = view.userId;
      checkUpdatesNow();
    }
  });
  installAccount();
  // Saving or rendering in the editor changes what the pack list says about its audio.
  installEditorIpc(() => settings().get(), resolveDataDir, () => void refreshPacks());
  installPublishIpc({ getSettings: () => settings().get(), resolveDataDir });
  installThemeContentIpc({ themes, getSettings: () => settings().get(), apply: applyTheme, builtinAssets: builtinThemeAssets });
  installContentIpc({ getSettings: () => settings().get(), resolveDataDir });
  installLapImport({
    getSettings: () => settings().get(),
    resolveDataDir,
    changed: () => void refreshPacks(),
    identity: () => liveIdentity,
  });
  installLibrary({
    getSettings: () => settings().get(),
    resolveDataDir,
    sessionRunning: () => sessionLive,
    changed: () => void refreshPacks(),
    busy: (text) => {
      libraryBusy = text;
      broadcastStatus({});
    },
    unselect: (noteSetId) => {
      if (settings().get().noteSetId === noteSetId) settings().update({ noteSetId: null });
    },
  });
  installImporterIpc({
    getSettings: () => settings().get(),
    resolveDataDir,
    identity: () => liveIdentity,
    openImported: (noteSetId) => {
      // Selecting is how the editor is aimed (see "editNoteSet" below), and the
      // pack list should show the new set without waiting for anything else.
      settings().update({ noteSetId });
      void refreshPacks();
      openEditor(PRELOAD);
    },
  });
  registerPreferencesShortcut(PRELOAD);

  // The overlays are the product (§7): transparent, frameless, always-on-top,
  // one window per panel. They used to be behind EXXEED_OVERLAY and off by
  // default, which meant the normal way to run the app was the one way that did
  // not put anything over the sim — a development convenience that had become
  // the default experience.
  const start = (): void => startOverlays();
  start();

  // The tray comes first: the close button hides the window, so the app must
  // already have somewhere to be hidden to before that is possible.
  createTray();

  // --minimized is what the login item passes, so a launch at login goes
  // straight to the tray instead of putting a window in front of someone who
  // has just reached their desktop.
  const minimized =
    settings().get().startMinimized || process.argv.includes("--minimized");
  if (minimized) {
    process.stdout.write("starting minimized — Exxeed is in the tray\n");
  } else {
    openControlWindow();
  }

  // Reconcile the checkbox with what Windows actually has registered; someone
  // may have removed it from Startup outside the app.
  const stored = settings().get().runAtLogin;
  const actual = app.isPackaged ? app.getLoginItemSettings().openAtLogin : stored;
  if (actual !== stored) settings().updateQuietly({ runAtLogin: actual });

  // Renderer → main. The control window is the only thing that sends these, and
  // it is the only surface that can: the overlays are click-through.
  ipcMain.on(SESSION_COMMAND_CHANNEL, (_event, raw: unknown) => {
    const command = raw as SessionCommand;
    if (command.kind === "start") startSession();
    else if (command.kind === "stop") stopSession();
    else if (command.kind === "testMode") setTestMode(command.value);
    else if (command.kind === "autoStart") {
      settings().updateQuietly({ autoStart: command.value });
      broadcastStatus({});
    } else if (command.kind === "welcomed") {
      settings().updateQuietly({ welcomed: true });
      broadcastStatus({});
    } else if (command.kind === "startMinimized") {
      settings().updateQuietly({ startMinimized: command.value });
      broadcastStatus({});
    } else if (command.kind === "runAtLogin") {
      // Write to the OS first and store what it actually ended up as, so the
      // checkbox reflects Windows rather than our intent.
      settings().updateQuietly({ runAtLogin: applyLoginItem(command.value) });
      broadcastStatus({});
    } else if (command.kind === "selectNoteSet") {
      // Through update(), not updateQuietly: this is a person changing what the
      // app should be doing, so the session listener SHOULD rebuild on it.
      settings().update({ noteSetId: command.id });
      broadcastStatus({});
    } else if (command.kind === "openImporter") {
      const track = command.track;
      if (track === undefined) {
        openImporter(PRELOAD);
      } else {
        // The map's own names, so the importer resolves the same key back.
        const found = listedTracks.find(
          (t) => t.key.trackId === track.trackId && t.key.configId === track.configId,
        );
        openImporter(
          PRELOAD,
          found === undefined
            ? undefined
            : { trackId: track.trackId, trackName: found.trackName, configName: found.configName },
        );
      }
    } else if (command.kind === "editNoteSet") {
      // The editor edits whatever is selected, so selecting is how you aim it.
      const changed = settings().get().noteSetId !== command.id;
      settings().update({ noteSetId: command.id });
      openEditor(PRELOAD, { reload: changed });
    } else if (command.kind === "newNoteSet") {
      const dataDir = resolveDataDir(settings().get());
      createManualNoteSet(dataDir, { sim: "iracing", trackId: command.trackId, configId: command.configId })
        .then(async (id) => {
          settings().update({ noteSetId: id });
          await refreshPacks();
          openEditor(PRELOAD, { reload: true });
        })
        .catch((err: unknown) => {
          process.stderr.write(`could not create a note set: ${String(err)}\n`);
        });
    }
  });

  // An overlay window asks what its panel shows as it loads; changes arrive on PANEL_SETTINGS_CHANNEL.
  ipcMain.handle(PANEL_SETTINGS_GET_CHANNEL, (_event, panel: unknown) =>
    typeof panel === "string" && isPanelId(panel) ? profileStore().settingsOf(profileStore().activeId, panel) : null,
  );

  // An overlay window asks what to wear as it loads; changes arrive on THEME_CHANNEL.
  ipcMain.handle(THEME_GET_CHANNEL, () => overlayTheme(themes().find(activeThemeId())));

  // The profile editor's reads (control window).
  ipcMain.handle(OVERLAY_EDITOR_CHANNEL, (_event, raw: unknown) => {
    const request = raw as OverlayEditorRequest;
    if (request.op === "layout") return editorLayout(request.profileId);
    if (request.op === "theme") return overlayTheme(themes().find(request.id));
    if (request.op === "open") setEditorOpen(request.open === true);
    return null;
  });

  // Renderer → main: the Overlays section of the control window.
  ipcMain.on(OVERLAY_PROFILE_COMMAND_CHANNEL, (_event, raw: unknown) => {
    const command = raw as OverlayProfileCommand;
    if (command.kind === "create") {
      profileStore().create(command.name);
      broadcastProfiles();
    } else if (command.kind === "rename") {
      profileStore().rename(command.id, command.name);
      broadcastProfiles();
    } else if (command.kind === "delete") {
      const wasActive = profileStore().activeId === command.id;
      profileStore().delete(command.id);
      if (wasActive) queueOverlayRestart(false);
      else broadcastProfiles();
    } else if (command.kind === "setPanels") {
      profileStore().setPanels(command.id, command.panels);
      if (command.id === profileStore().activeId) {
        queueOverlayChange();
      } else {
        broadcastProfiles();
      }
    } else if (command.kind === "setActive") {
      if (command.id !== profileStore().activeId) {
        profileStore().setActive(command.id);
        queueOverlayRestart(false);
      }
    } else if (command.kind === "edit") {
      if (command.id === profileStore().activeId) {
        setOverlayEditing(true);
      } else {
        profileStore().setActive(command.id);
        queueOverlayRestart(true);
      }
    } else if (command.kind === "stopEditing") {
      setOverlayEditing(false);
    } else if (command.kind === "hideWhenSimUnfocused") {
      // Quietly: a visibility rule, not something a running session reloads for.
      settings().updateQuietly({ hideOverlaysWhenSimUnfocused: command.value });
      syncOverlayVisibility();
      broadcastProfiles();
    } else if (command.kind === "setPanelPart" || command.kind === "setPanelStyle") {
      // Live, like a theme: the open overlay shows or hides the part itself.
      const next = profileStore().setSettings(command.id, command.panel, (current) =>
        command.kind === "setPanelStyle"
          ? { ...current, style: command.style }
          : {
              ...current,
              hidden: command.shown
                ? current.hidden.filter((h) => h !== command.part)
                : [...current.hidden, command.part],
            },
      );
      if (command.id === profileStore().activeId) {
        const message: PanelSettingsMessage = { panel: command.panel, settings: next };
        overlayLayout?.broadcast(PANEL_SETTINGS_CHANNEL, message);
        // Both halves of a left/right pair share their choices; a pair just
        // made mirrored lines up at once, the other one following this one.
        const partner = MIRROR_PAIRS[command.panel];
        if (partner !== undefined) {
          profileStore().setSettings(command.id, partner, (current) => ({ ...current, style: next.style, hidden: [...next.hidden] }));
          overlayLayout?.broadcast(PANEL_SETTINGS_CHANNEL, { panel: partner, settings: profileStore().settingsOf(command.id, partner) });
          if (command.kind === "setPanelStyle") overlayLayout?.mirrorFrom(command.panel);
        }
      }
      broadcastProfiles();
    } else if (command.kind === "setTheme") {
      // Live: the open overlays restyle themselves. Never a restart — they
      // hold decoded audio and the reference arrays.
      applyTheme(command.id, command.profileId);
    } else if (command.kind === "setScreen") {
      profileStore().setScreen(command.id, command.width, command.height);
      broadcastProfiles();
    } else if (command.kind === "setBackground") {
      const image = command.image === null ? null : decodeImage(command.image);
      if (command.image === null || image !== null) profileStore().setBackground(command.id, image);
      broadcastProfiles();
    } else if (command.kind === "placePanel" || command.kind === "resetPanel") {
      if (isPanelId(command.panel)) placePanel(command.id, command.panel, command.kind === "placePanel" ? command.rect : null);
      broadcastProfiles();
    } else if (command.kind === "newTheme") {
      // A copy of what is on screen now, selected and opened: the quickest way
      // to a theme is changing one that already works.
      const profileId = command.profileId ?? profileStore().activeId;
      const id = themes().create(themes().find(profileThemeId(profileId)), command.name.trim() || "My theme");
      applyTheme(id, profileId);
    } else if (command.kind === "editTheme") {
      // Shown in its folder, not opened: handing a .json to whatever app the
      // system picks is how an editor ended up crashing. The app's own editor
      // (the Edit button) is the way to change it.
      if (themes().isCustom(command.id)) shell.showItemInFolder(themes().pathOf(command.id));
    } else if (command.kind === "deleteTheme") {
      themes().remove(command.id);
      // Every profile that wore it falls back to the default.
      for (const profile of profileStore().profiles) {
        if (profile.theme === command.id) profileStore().setTheme(profile.id, themes().find(command.id).id);
      }
      applyTheme(activeThemeId());
    } else if (command.kind === "openThemesFolder") {
      void shell.openPath(themes().dir);
    } else if (command.kind === "inspectOverlay") {
      overlayLayout?.inspect(command.panel);
    }
  });

  rebuildMenu();

  process.stdout.write(
    debugEnabled()
      ? "debug on (running from source) — preferences has a Debug section\n"
      : "debug off — EXXEED_DEBUG=1 to enable\n",
  );
  process.stdout.write(`preferences: ${PREFERENCES_SHORTCUT}\n`);

  // The picker's contents, in the background — nothing waits on them.
  void refreshPacks();

  // Nothing to configure up front any more: the note set follows the track the
  // sim reports, so there is no longer a question to answer before starting.
  if (settings().get().autoStart) {
    process.stdout.write("autostart on — waiting for the sim\n");
    startSession();
  } else {
    process.stdout.write("autostart off — press Start in the Exxeed window\n");
    broadcastStatus({ phase: "stopped", contentHint: null });
  }

  // A changed note set, voice, car, data folder or lead adjust means a different
  // engine and different audio, so the session is rebuilt. Panels are not in
  // that list: adding or removing a window at runtime is M6's layout work.
  //
  // The reload goes through supervise(), never a second runTelemetryLoop beside
  // the first. The iRacing SDK maps the sim's shared memory once per process, so
  // two adapters share it: the old loop's close() unmaps it under the new one,
  // and the new one's next read takes the whole app down — no exception, no log.
  // That is what "the app crashes when I open the editor" was: Edit selects the
  // note set, which is a settings change. Ending the running loop and letting the
  // supervisor start the next one means one adapter at a time, always.
  // Audio is per voice: another voice can leave every pack needing a render.
  let listedVoice = settings().get().voiceId;
  settings().onChange(() => {
    if (settings().get().voiceId === listedVoice) return;
    listedVoice = settings().get().voiceId;
    void refreshPacks();
  });

  settings().onChange(() => {
    // Nothing to reload while stopped; the next Start reads the new settings.
    if (!wantRunning) return;
    process.stdout.write("settings changed — reloading the session\n");
    restartRequested = true;
    loopToken++;
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) start();
  });
});

// Whichever way the app is being shut down — the control window, File > Quit,
// Alt+F4 — stop the loop first so the recorder stops taking writes it will not
// get to flush.
app.on("before-quit", () => stopSession());

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
