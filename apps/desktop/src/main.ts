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
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, ipcMain, Menu, nativeImage, Tray } from "electron";

import { classOf, deltaSeconds, LapTimer, mps, pct, radians } from "@exxeed/core";
import {
  AUDIO_PLAY_CHANNEL,
  AUDIO_PRELOAD_CHANNEL,
  ENGINE_EVENT_CHANNEL,
  MAP_CHANNEL,
  OVERLAY_PROFILE_COMMAND_CHANNEL,
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
  toTickInput,
  type DashState,
  type SessionIdentity,
  type TelemetryFrame,
  type TelemetrySource,
} from "@exxeed/telemetry";

import { audioKey, LocalContentIndex, localRepositories, type TrackSummary } from "@exxeed/repo";

import { buildApplicationMenu } from "./menu.js";
import { FULLSCREEN_WARNING, isOverlayWindow, OverlayLayout, sendTo } from "./overlay.js";
import { OverlayProfileStore } from "./overlay-profiles.js";
import { startOverlayPreview, type OverlayPreview } from "./overlay-preview.js";
import { createManualNoteSet, installEditorIpc, openEditor, requestRender } from "./editor.js";
import { watchSimFocus, type ForegroundWatcher } from "./foreground.js";
import { installAccount, onAccountChange } from "./account.js";
import { shareCut, shareOnSignIn, syncBeforeSession } from "./cloud-sync.js";
import { installPublishIpc } from "./publish.js";
import { checkUpdatesNow, installLibrary, knownItem, remoteMinePacks } from "./library.js";
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

// fileURLToPath leaves a trailing separator on a directory URL, which every use
// below then doubles up on ("...\exxeed\/data"). Harmless to fs, but these paths
// get printed.
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url)).replace(/[\\/]+$/, "");
const FIXTURE = `${REPO_ROOT}/packages/telemetry/test/fixtures/synthetic-3laps.ndjson`;

/**
 * The one recordings folder. Deliberately not under the chosen data folder:
 * a recording is what this machine drove, not part of a note set's data, and
 * pointing the data folder at data/demo must not hide the laps.
 */
const RECORDINGS_DIR = `${REPO_ROOT}/data/recordings`;

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
 * Pick a source. iRacing when the platform can support it, otherwise replay a
 * recording — which is how the whole app is developed on macOS (§9).
 *
 * EXXEED_REPLAY overrides, so a recording can be replayed on Windows too. That
 * matters more than it sounds: replaying a real lap is the only way to iterate on
 * callout timing without driving.
 */
function createSource(): TelemetrySource {
  const { debug } = settings().get();

  // Debug settings only bite while the debug flag is on. They persist, so a
  // replay file set once stays set — and without this, someone who set one and
  // then started normally would have a sim that never connects and no visible
  // panel to explain it.
  if (!debugEnabled()) {
    if (isIRacingSupported()) return new IRacingAdapter({ hz: 60 });
    return new ReplayAdapter(FIXTURE, { speed: 1, loop: true });
  }

  if (debug.replayPath !== null) {
    return new ReplayAdapter(resolveReplayPath(debug.replayPath), {
      speed: debug.replaySpeed,
      loop: debug.loopReplay,
    });
  }
  if (isIRacingSupported()) return new IRacingAdapter({ hz: 60 });

  // Nothing to connect to and nothing chosen: the built-in synthetic lap, so the
  // window shows something rather than sitting blank.
  return new ReplayAdapter(FIXTURE, { speed: debug.replaySpeed, loop: debug.loopReplay });
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

  const identity = source.identity;
  liveIdentity = identity;

  // Before anything reads the track from disk: fetch its map if someone has
  // already shared one, so this session has a map from the first lap and the
  // auto-mapper does not cut a competing one.
  await syncBeforeSession(resolveDataDir(settings().get()), identity, (line) => process.stdout.write(line));
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
  const recorder = mapped
    ? null
    : new NdjsonRecorder(recordingPath(identity), {
        startedAt: new Date().toISOString(),
        source: source.name,
        ...(identity ?? {}),
      });

  process.stdout.write(
    recorder === null
      ? `not recording — ${describeIdentity(identity)} is already mapped\n`
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
  });

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

          if (session.audio?.clips.has(key) === true) {
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
        toStateFrame(frame, source.name, session, suppressedBy, lapElapsedS, source.dash?.() ?? null),
      );

      // The race around the car, on its own slower clock. Only a source that
      // has it sends it — a replay has none, and the race panels say so.
      if (frame.tMs - raceSentAt >= RACE_INTERVAL_MS || frame.tMs < raceSentAt) {
        raceSentAt = frame.tMs;
        const snapshot = source.race?.() ?? null;
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
  return {
    broadcast: (channel, payload) => layout.broadcast(channel, payload),
    // The first panel opened hosts the audio. Which one it is does not matter —
    // nothing about it is visible — but it has to be exactly one.
    audio: (channel, payload) => {
      const host = layout.windows[0];
      if (host !== undefined) sendTo(host, channel, payload);
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

/** What the Overlays section of the control window shows. */
function overlayProfilesView(): OverlayProfilesView {
  return {
    profiles: profileStore().profiles,
    activeProfileId: profileStore().activeId,
    editing: overlayEditingActive,
    debugEnabled: debugEnabled(),
    hideWhenSimUnfocused: settings().get().hideOverlaysWhenSimUnfocused,
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
    width: 620,
    height: 580,
    title: "Exxeed",
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: false },
  });

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

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
      await sleepMs(2000);
    }
  } finally {
    supervising = false;
    if (!wantRunning) {
      broadcastStatus({
        phase: "stopped",
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

function stopSession(): void {
  wantRunning = false;
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

void app.whenReady().then(() => {
  store = new SettingsStore();
  // Seeds the Default profile the first time this installs, or when migrating
  // from a version that had no profiles yet (§ `overlay-profiles.ts`).
  profiles = new OverlayProfileStore(
    settings().get().panels.length === 0 ? [...DEFAULT_PANELS] : settings().get().panels,
  );
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
  installEditorIpc(() => settings().get(), resolveDataDir);
  installPublishIpc({ getSettings: () => settings().get(), resolveDataDir });
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
    else if (command.kind === "autoStart") {
      settings().updateQuietly({ autoStart: command.value });
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
        queueOverlayRestart(overlayEditingActive);
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
    broadcastStatus({ phase: "stopped" });
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
