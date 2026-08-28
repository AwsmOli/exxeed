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

import { app, BrowserWindow } from "electron";

import { deltaSeconds, LapTimer, mps, pct, radians } from "@exxeed/core";
import {
  AUDIO_PLAY_CHANNEL,
  AUDIO_PRELOAD_CHANNEL,
  ENGINE_EVENT_CHANNEL,
  MAP_CHANNEL,
  REFERENCE_CHANNEL,
  STATE_FRAME_CHANNEL,
  type AudioClip,
  type AudioPlayCommand,
  type EngineEventView,
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

import { audioKey } from "@exxeed/repo";

import { FULLSCREEN_WARNING, markClosing, OverlayLayout, sendTo } from "./overlay.js";
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
 * Pick a source. iRacing when the platform can support it, otherwise replay a
 * recording — which is how the whole app is developed on macOS (§9).
 *
 * EXXEED_REPLAY overrides, so a recording can be replayed on Windows too. That
 * matters more than it sounds: replaying a real lap is the only way to iterate on
 * callout timing without driving.
 */
function createSource(): TelemetrySource {
  // EXXEED_SPEED only affects replay. Real time is real time.
  const speed = Number(env("EXXEED_SPEED") ?? "1");

  const replayPath = env("EXXEED_REPLAY");
  if (replayPath !== undefined) return new ReplayAdapter(replayPath, { speed, loop: true });
  if (isIRacingSupported()) return new IRacingAdapter({ hz: 60 });
  return new ReplayAdapter(FIXTURE, { speed, loop: true });
}

async function createSession(replaying: boolean): Promise<LoadedSession | null> {
  const noteSetId = env("EXXEED_NOTES");
  if (noteSetId === undefined) return null;

  // EXXEED_SKIP_OUTLAP only means anything against a recording. On a live
  // session the out-lap gate is the rule, not friction, so it is not negotiable
  // from an environment variable.
  const skipOutLap = replaying && env("EXXEED_SKIP_OUTLAP") !== undefined;
  if (skipOutLap) {
    process.stdout.write("skipping the out-lap gate — replay only (§6.4)\n");
  }

  return loadSession({
    assumeLapComplete: skipOutLap,
    dataDir: env("EXXEED_DATA") ?? `${REPO_ROOT}/data/demo`,
    noteSetId,
    ...(env("EXXEED_CAR") === undefined ? {} : { carId: Number(env("EXXEED_CAR")) }),
    voiceId: env("EXXEED_VOICE") ?? "en_test",
    profile: { leadAdjustS: Number(env("EXXEED_LEAD_ADJUST") ?? "0") },
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

async function runTelemetryLoop(surfaces: Surfaces): Promise<void> {
  const source = createSource();
  const replaying = source instanceof ReplayAdapter;

  let session: LoadedSession | null = null;
  try {
    session = await createSession(replaying);
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

  try {
    await source.connect();
  } catch (err) {
    process.stderr.write(`telemetry source failed to connect: ${String(err)}\n`);
    surfaces.broadcast(STATE_FRAME_CHANNEL, emptyFrame);
    return;
  }

  // Built after connect, not before: the track and car are only known once the
  // sim has handed over its session data, and they decide where this lands.
  const recorder = new NdjsonRecorder(recordingPath(source.identity), {
    startedAt: new Date().toISOString(),
    source: source.name,
    ...(source.identity ?? {}),
  });
  process.stdout.write(
    `recording ${describeIdentity(source.identity)} -> ${recorder.path}\n`,
  );

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
      if (stopped || !surfaces.alive()) break;

      // Always-on recording (§9). Every lap anyone drives must be replayable —
      // the moment this becomes opt-in, the interesting lap is the unrecorded one.
      recorder.write(frame);

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
    await recorder.close();
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
  if (raw === undefined) return [...PANELS];

  const wanted = raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
  const unknown = wanted.filter((s) => !isPanelId(s));
  for (const name of unknown) {
    process.stderr.write(`unknown panel "${name}" — known: ${PANELS.join(", ")}\n`);
  }
  const panels = wanted.filter(isPanelId);
  return panels.length === 0 ? [...PANELS] : panels;
}

function createDesktopWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 760,
    height: 660,
    title: "Exxeed",
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // This renderer is the audio output device. Throttling it would delay
      // callouts, which is the one thing §7 is trying to prevent.
      backgroundThrottling: false,
    },
  });

  forwardRendererConsole(window);
  void window.loadFile(PAGE);
  return window;
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

/** One window: broadcast and audio both mean "that window". */
function singleWindowSurfaces(window: BrowserWindow): Surfaces {
  window.on("close", () => markClosing(window));
  const send = (channel: string, payload: unknown): void => sendTo(window, channel, payload);
  return {
    broadcast: send,
    audio: send,
    alive: () => !window.isDestroyed() && !window.webContents.isDestroyed(),
    onClosed: (callback) => window.once("closed", callback),
  };
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

function startOverlays(): void {
  process.stdout.write(FULLSCREEN_WARNING);

  const layout = new OverlayLayout();
  const panels = chosenPanels();

  panels.forEach((panel, index) => {
    const window = layout.create(panel, index, PRELOAD, PAGE);
    forwardRendererConsole(window);
  });

  process.stdout.write(`  ${panels.length} overlays: ${panels.join(", ")}\n`);

  // Wait for the renderers before sending anything, or the map, the reference
  // and the clips all land in pages that are not listening yet.
  const last = layout.windows[layout.windows.length - 1];
  if (last === undefined) return;
  last.webContents.once("did-finish-load", () => {
    void runTelemetryLoop(overlaySurfaces(layout));
  });
}

function startDesktop(): void {
  const window = createDesktopWindow();
  window.webContents.once("did-finish-load", () => {
    void runTelemetryLoop(singleWindowSurfaces(window));
  });
}

void app.whenReady().then(() => {
  // EXXEED_OVERLAY gives the §7 overlays: transparent, frameless, click-through,
  // above the sim, one window per panel. Off by default because a fleet of
  // click-through always-on-top windows is a nuisance to develop against.
  const overlayMode = env("EXXEED_OVERLAY") !== undefined;
  if (overlayMode) startOverlays();
  else startDesktop();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (overlayMode) startOverlays();
      else startDesktop();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
