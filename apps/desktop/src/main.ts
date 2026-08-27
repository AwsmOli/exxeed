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

import { mps, pct, radians } from "@exxeed/core";
import {
  AUDIO_PLAY_CHANNEL,
  AUDIO_PRELOAD_CHANNEL,
  STATE_FRAME_CHANNEL,
  type AudioClip,
  type AudioPlayCommand,
  type StateFrame,
} from "@exxeed/overlays";
import {
  IRacingAdapter,
  isIRacingSupported,
  NdjsonRecorder,
  ReplayAdapter,
  toTickInput,
  type TelemetryFrame,
  type TelemetrySource,
} from "@exxeed/telemetry";

import { audioKey } from "@exxeed/repo";

import { createOverlayWindow, FULLSCREEN_WARNING } from "./overlay.js";
import { loadSession, type LoadedSession } from "./session.js";

// Before any getPath call: without it userData lands under "@exxeed", taken from
// the package name, which is where the overlay's remembered position lives.
app.setName("Exxeed");

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
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

async function createSession(): Promise<LoadedSession | null> {
  const noteSetId = env("EXXEED_NOTES");
  if (noteSetId === undefined) return null;

  return loadSession({
    dataDir: env("EXXEED_DATA") ?? `${REPO_ROOT}/data/demo`,
    noteSetId,
    voiceId: env("EXXEED_VOICE") ?? "en_test",
    profile: { leadAdjustS: Number(env("EXXEED_LEAD_ADJUST") ?? "0") },
  });
}

const toStateFrame = (
  f: TelemetryFrame,
  sourceName: string,
  session: LoadedSession | null,
  suppressedBy: StateFrame["suppressedBy"],
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
  deltaS: null, // Needs a loaded ReferenceLap — M3 (§7.2).
  connected: true,
  sourceName,
  suppressedBy,
  queuedNoteIds: session?.engine.queued() ?? [],
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
  deltaS: null,
  connected: false,
  sourceName: "—",
  suppressedBy: null,
  queuedNoteIds: [],
};

async function runTelemetryLoop(window: BrowserWindow): Promise<void> {
  const source = createSource();

  let session: LoadedSession | null = null;
  try {
    session = await createSession();
  } catch (err) {
    process.stderr.write(`could not load note set: ${String(err)}\n`);
  }

  for (const warning of session?.warnings ?? []) {
    process.stderr.write(`warning: ${warning}\n`);
  }

  // Ship every clip to the renderer once, up front, so the trigger path is a
  // lookup rather than a read (§4.5).
  if (session?.audio != null && !window.webContents.isDestroyed()) {
    const clips: AudioClip[] = [...session.audio.clips].map(([key, wav]) => ({ key, wav }));
    window.webContents.send(AUDIO_PRELOAD_CHANNEL, clips);
    process.stdout.write(
      `preloaded ${clips.length} clips, ${(session.audio.totalBytes / 1024).toFixed(0)} KiB\n`,
    );
  }

  const recorder = new NdjsonRecorder(
    `${REPO_ROOT}/data/recordings/${new Date().toISOString().replace(/[:.]/g, "-")}.ndjson`,
    { startedAt: new Date().toISOString(), source: source.name },
  );

  try {
    await source.connect();
  } catch (err) {
    process.stderr.write(`telemetry source failed to connect: ${String(err)}\n`);
    if (!window.isDestroyed()) window.webContents.send(STATE_FRAME_CHANNEL, emptyFrame);
    await recorder.close();
    return;
  }

  // `window.isDestroyed()` alone is not enough: the render frame is disposed
  // before the BrowserWindow reports itself destroyed, so a loop checking only
  // that races teardown and floods the log with "Render frame was disposed".
  let stopped = false;
  window.once("closed", () => {
    stopped = true;
    void source.close();
  });

  try {
    for await (const frame of source) {
      if (stopped || window.isDestroyed()) break;

      // Always-on recording (§9). Every lap anyone drives must be replayable —
      // the moment this becomes opt-in, the interesting lap is the unrecorded one.
      recorder.write(frame);

      let suppressedBy: StateFrame["suppressedBy"] = null;

      if (session !== null) {
        const result = session.engine.tick(toTickInput(frame));
        suppressedBy = result.suppressedBy;

        for (const event of result.events) {
          if (event.kind === "drop") {
            process.stdout.write(`DROP ${event.noteId} (${event.reason})\n`);
            continue;
          }

          const key = audioKey(event.noteId, event.variant);
          process.stdout.write(`PLAY ${key} (${event.durationMs}ms)\n`);

          if (session.audio?.clips.has(key) === true && !window.webContents.isDestroyed()) {
            const command: AudioPlayCommand = {
              key,
              noteId: event.noteId,
              durationMs: event.durationMs,
            };
            window.webContents.send(AUDIO_PLAY_CHANNEL, command);
          }
        }
      }

      if (window.webContents.isDestroyed()) break;
      window.webContents.send(
        STATE_FRAME_CHANNEL,
        toStateFrame(frame, source.name, session, suppressedBy),
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

function createWindow(): BrowserWindow {
  // EXXEED_OVERLAY gives the §7 overlay: transparent, frameless, click-through,
  // above the sim. Off by default because a click-through always-on-top window
  // is a nuisance to develop against.
  if (env("EXXEED_OVERLAY") !== undefined) {
    process.stdout.write(FULLSCREEN_WARNING);
    return createOverlayWindow(PRELOAD, PAGE);
  }

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

  void window.loadFile(PAGE);
  return window;
}

void app.whenReady().then(() => {
  const window = createWindow();
  // Wait for the renderer before preloading audio into it, or the clips land in
  // a page that is not listening yet.
  window.webContents.once("did-finish-load", () => void runTelemetryLoop(window));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const next = createWindow();
      next.webContents.once("did-finish-load", () => void runTelemetryLoop(next));
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
