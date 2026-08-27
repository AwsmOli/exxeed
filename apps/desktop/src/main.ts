/**
 * Electron main process — SPEC.md §7 and milestone M0.
 *
 * "Timing-critical work runs in the main process, never a renderer. Renderers get
 * throttled when occluded or backgrounded, which will silently destroy callout
 * timing. Main owns the telemetry loop, the note engine and audio, and pushes a
 * compact state frame to renderers over IPC at 60 Hz. Never send raw telemetry
 * across IPC."
 *
 * At M0a this loop only forwards frames and records them. The note engine hooks
 * in at M2 — right here, between the source and the IPC push, so that nothing
 * about the timing path has to move when it does.
 */

import { fileURLToPath } from "node:url";

import { app, BrowserWindow } from "electron";

import { mps, pct } from "@exxeed/core";
import { STATE_FRAME_CHANNEL, type StateFrame } from "@exxeed/overlays";
import {
  IRacingAdapter,
  isIRacingSupported,
  NdjsonRecorder,
  ReplayAdapter,
  type TelemetryFrame,
  type TelemetrySource,
} from "@exxeed/telemetry";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * Pick a source. iRacing when the platform can support it, otherwise replay a
 * recording — which is how the whole app is developed on macOS (§9).
 *
 * `EXXEED_REPLAY` overrides, so you can replay a recording on Windows too. That
 * matters more than it sounds: replaying a real lap is the only way to iterate on
 * callout timing without driving.
 */
function createSource(): TelemetrySource {
  const replayPath = process.env["EXXEED_REPLAY"];
  if (replayPath !== undefined && replayPath !== "") {
    return new ReplayAdapter(replayPath, { speed: 1, loop: true });
  }

  if (isIRacingSupported()) return new IRacingAdapter({ hz: 60 });

  return new ReplayAdapter(
    `${REPO_ROOT}/packages/telemetry/test/fixtures/synthetic-3laps.ndjson`,
    { speed: 1, loop: true },
  );
}

const emptyFrame: StateFrame = {
  tMs: 0,
  lap: 0,
  lapDistPct: pct(0),
  speedMps: mps(0),
  throttle: 0,
  brake: 0,
  gear: 0,
  deltaS: null,
  connected: false,
  sourceName: "—",
};

/** Telemetry frame → the compact frame renderers actually need (§7). */
const toStateFrame = (f: TelemetryFrame, sourceName: string): StateFrame => ({
  tMs: f.tMs,
  lap: f.lap,
  lapDistPct: f.lapDistPct,
  speedMps: f.speedMps,
  throttle: f.throttle,
  brake: f.brake,
  gear: f.gear,
  // Needs a loaded ReferenceLap — M3 (§7.2).
  deltaS: null,
  connected: true,
  sourceName,
});

async function runTelemetryLoop(window: BrowserWindow): Promise<void> {
  const source = createSource();
  const recorder = new NdjsonRecorder(
    `${REPO_ROOT}/data/recordings/${new Date().toISOString().replace(/[:.]/g, "-")}.ndjson`,
    { startedAt: new Date().toISOString(), source: source.name },
  );

  try {
    await source.connect();
  } catch (err) {
    process.stderr.write(`telemetry source failed to connect: ${String(err)}\n`);
    if (!window.isDestroyed()) window.webContents.send(STATE_FRAME_CHANNEL, emptyFrame);
    return;
  }

  // `window.isDestroyed()` alone is not enough: the render frame is disposed
  // before the BrowserWindow reports itself destroyed, so a loop checking only
  // that races the teardown and floods the log with "Render frame was disposed".
  // Stop on the close event, and re-check webContents at the moment of sending.
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
      if (window.webContents.isDestroyed()) break;
      window.webContents.send(STATE_FRAME_CHANNEL, toStateFrame(frame, source.name));
    }
  } finally {
    await source.close();
    await recorder.close();
  }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 720,
    height: 560,
    title: "Exxeed — M0 telemetry",
    webPreferences: {
      // ESM preload scripts must carry the .mjs extension, which is why the
      // source is preload.mts — tsc emits .mjs from .mts and .js from .ts.
      preload: fileURLToPath(new URL("./preload.mjs", import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  void window.loadFile(fileURLToPath(new URL("../static/index.html", import.meta.url)));
  return window;
}

void app.whenReady().then(() => {
  const window = createWindow();
  void runTelemetryLoop(window);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const next = createWindow();
      void runTelemetryLoop(next);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
