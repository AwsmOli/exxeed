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

import { fileURLToPath } from "node:url";

import { app, BrowserWindow, ipcMain, Menu, nativeImage, Tray } from "electron";

import { deltaSeconds, LapTimer, mps, pct, radians } from "@exxeed/core";
import {
  AUDIO_PLAY_CHANNEL,
  AUDIO_PRELOAD_CHANNEL,
  ENGINE_EVENT_CHANNEL,
  MAP_CHANNEL,
  REFERENCE_CHANNEL,
  SESSION_COMMAND_CHANNEL,
  SESSION_STATUS_CHANNEL,
  STATE_FRAME_CHANNEL,
  type AudioClip,
  type AudioPlayCommand,
  type EngineEventView,
  type NoteSetPack,
  type SessionCommand,
  type SessionStatus,
  type StateFrame,
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
  type SessionIdentity,
  type TelemetryFrame,
  type TelemetrySource,
} from "@exxeed/telemetry";

import { audioKey, localRepositories } from "@exxeed/repo";

import { buildApplicationMenu } from "./menu.js";
import { FULLSCREEN_WARNING, OverlayLayout, sendTo } from "./overlay.js";
import { installEditorIpc, openEditor, requestRender } from "./editor.js";
import {
  installSettingsIpc,
  openPreferences,
  PREFERENCES_SHORTCUT,
  registerPreferencesShortcut,
} from "./preferences.js";
import { debugEnabled, SettingsStore } from "./settings.js";
import { loadSession, type LoadedSession } from "./session.js";

// Before any getPath call: without it userData lands under "@exxeed", taken from
// the package name, which is where the overlay's remembered position lives.
app.setName("Exxeed");

// fileURLToPath leaves a trailing separator on a directory URL, which every use
// below then doubles up on ("...\exxeed\/data"). Harmless to fs, but these paths
// get printed.
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url)).replace(/[\\/]+$/, "");
const FIXTURE = `${REPO_ROOT}/packages/telemetry/test/fixtures/synthetic-3laps.ndjson`;

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

/**
 * Bumped whenever the session has to be rebuilt. A running telemetry loop
 * carries the token it started with and stops as soon as it stops matching,
 * which is how a settings change replaces a session without two loops ever
 * writing to the same recorder.
 */
let loopToken = 0;

const resolveDataDir = (s: { dataDir: string | null }): string =>
  s.dataDir ?? `${REPO_ROOT}/data/demo`;

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
    return new ReplayAdapter(debug.replayPath, {
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
  const candidates = await localRepositories(dataDir).noteSets.listForTrack(key);
  if (candidates.length === 0) {
    return { id: null, detail: `no note set for ${identity.trackName}` };
  }

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
  return `${REPO_ROOT}/data/recordings/${dir}/${stamp}.ndjson`;
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
};

/**
 * Every pack on disk, refreshed rather than re-read on every status broadcast.
 *
 * The list changes when someone adds or renders a note set, which is rare; the
 * status broadcasts on every phase change, which is not.
 */
let packs: NoteSetPack[] = [];

async function refreshPacks(): Promise<void> {
  try {
    const dataDir = resolveDataDir(settings().get());
    const repos = localRepositories(dataDir);
    const [summaries, tracks] = await Promise.all([
      repos.noteSets.listAll(),
      repos.trackMaps.listTracks(),
    ]);

    const written = summaries.map((p) => ({
      id: p.id,
      trackName: trackNameFor(tracks, p.trackKey.trackId, p.trackKey.configId),
      carClass: p.carClass,
      noteCount: p.noteCount,
      status: p.status,
      trackId: p.trackKey.trackId,
      configId: p.trackKey.configId,
      active: false,
    }));

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
  };
  currentSurfaces?.broadcast(SESSION_STATUS_CHANNEL, sessionStatus);
  controlWindow?.webContents.send(SESSION_STATUS_CHANNEL, sessionStatus);
  refreshTrayMenu();
}

async function runTelemetryLoop(surfaces: Surfaces): Promise<void> {
  const token = ++loopToken;
  const source = createSource();

  // Connect FIRST. The sim knows which track and car it loaded, and that is what
  // decides the note set — asking a driver to pick one that matches is asking
  // them to restate something the sim has already said. It also makes a failed
  // connect cheap: nothing has been loaded yet to throw away.
  await source.connect();

  const identity = source.identity;
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

  broadcastStatus({
    phase: "running",
    trackName: identity?.trackName ?? null,
    carName: identity?.carName ?? null,
    noteSetId: chosen.id,
    detail: chosen.detail,
    recordingTo: recorder?.path ?? null,
  });

  const lapTimer = new LapTimer();

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
        toStateFrame(frame, source.name, session, suppressedBy, lapElapsedS),
      );
    }
  } finally {
    await source.close();
    await recorder?.close();
  }
}

// ESM preload scripts must carry the .mjs extension, which is why the source is
// preload.mts — tsc emits .mjs from .mts and .js from .ts.
const PRELOAD = fileURLToPath(new URL("./preload.mjs", import.meta.url));
const PAGE = fileURLToPath(new URL("../static/index.html", import.meta.url));

/**
 * Which panels to open. `EXXEED_PANELS=map,delta` for a subset; all of them
 * otherwise. Unknown names are called out rather than ignored — a typo that
 * silently opens nothing is a bad afternoon.
 */
function chosenPanels(): PanelId[] {
  const raw = env("EXXEED_PANELS");
  if (raw !== undefined) {
    const wanted = raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
    for (const name of wanted.filter((s) => !isPanelId(s))) {
      process.stderr.write(`unknown panel "${name}" — known: ${PANELS.join(", ")}\n`);
    }
  }
  const panels = settings().get().panels;
  const chosen = panels.length === 0 ? [...PANELS] : [...panels];

  // The telemetry panel is the raw channel dump — lapDistPct to five places,
  // gear, the suppression flags. That is a debugging instrument, not something
  // to read at 200 km/h, and it is the one panel that tells a driver nothing
  // they cannot see on the car's own dash. Keep it for development, hide it
  // otherwise, and leave it in PANELS so nobody's saved layout loses its place.
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

function startOverlays(): void {
  process.stdout.write(FULLSCREEN_WARNING);

  const layout = new OverlayLayout();
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
  if (last === undefined) return;
  last.webContents.once("did-finish-load", () => {
    // Only publish the surfaces. Whether a session should be running is the
    // supervisor's business, not a window's: a window finishing load says
    // nothing about whether the sim is up.
    currentSurfaces = overlaySurfaces(layout);
    // Read wantRunning NOW rather than when the windows were created: autostart
    // fires between those two moments, so a value captured at creation would
    // hide the overlays a beat after the session had shown them.
    layout.setVisible(wantRunning);
    broadcastStatus({});
  });
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
    width: 420,
    height: 520,
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
  window.webContents.once("did-finish-load", () => broadcastStatus({}));
}

/**
 * True while the app should be connected, or trying to be.
 *
 * Separate from whether a loop is currently running: the sim coming and going is
 * expected, and "on" has to survive it. Stopping is the only thing that clears
 * this.
 */
let wantRunning = false;
/** Guards against two supervisors racing after a rapid stop/start. */
let supervising = false;

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
        // A clean return means the source ended — the sim closed, or the replay
        // finished. Either way, go back to waiting rather than giving up.
      } catch (err) {
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
  // The overlays exist to show a session. With none running they are five
  // translucent rectangles of nothing sitting over whatever else is on screen,
  // so they follow the session rather than the app.
  overlayLayout?.setVisible(true);
  void supervise();
}

function stopSession(): void {
  wantRunning = false;
  // Bumping the token makes any running loop stop at its next frame.
  loopToken++;
  overlayLayout?.setVisible(false);
}

void app.whenReady().then(() => {
  store = new SettingsStore();
  installSettingsIpc(settings(), resolveDataDir);
  installEditorIpc(() => settings().get(), resolveDataDir);
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
    } else if (command.kind === "editNoteSet") {
      // The editor edits whatever is selected, so selecting is how you aim it.
      settings().update({ noteSetId: command.id });
      openEditor(PRELOAD);
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
  settings().onChange(() => {
    const surfaces = currentSurfaces;
    if (surfaces === null) return;
    process.stdout.write("settings changed — reloading the session\n");
    void runTelemetryLoop(surfaces);
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
