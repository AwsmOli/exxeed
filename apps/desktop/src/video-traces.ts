/**
 * Traces from a guide video — experimental.
 *
 * A window of its own, opened from the importer on the guide being looked at.
 * The window plays the video and measures the input bars in its overlay frame
 * by frame (static/tracer.js); this side downloads the video, turns the
 * measurements into a reference lap (core `referenceFromVideo`), and saves it
 * once it has been looked at.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { BrowserWindow, ipcMain } from "electron";

import { barFill, findCrossings, referenceFromVideo, trackKeyId, type Metres, type ReferenceLap, type TrackKey } from "@exxeed/core";
import { downloadVideo, resolveYtDlpSetup } from "@exxeed/importer";
import type { Settings } from "@exxeed/overlays";
import { localRepositories } from "@exxeed/repo";

import { dataPath } from "./paths.js";
import { rememberWindow, windowBounds } from "./window-state.js";

export const VIDEO_TRACES_CHANNEL = "exxeed:video-traces";

const PAGE = fileURLToPath(new URL("../static/tracer.html", import.meta.url));
const TOOLS_DIR = dataPath("tools");
const VIDEO_DIR = dataPath("video-cache");

export interface VideoTracesDeps {
  readonly getSettings: () => Settings;
  readonly resolveDataDir: (settings: Settings) => string;
  /** The reference laps changed: let the running session and the panels know. */
  readonly changed: () => void;
}

interface Target {
  readonly trackKey: TrackKey;
  readonly label: string;
  /** Each car with a reference lap here, and that lap's time — to guess which stretch of the video is a lap. */
  readonly cars: readonly { readonly carId: string; readonly lapTimeS: number }[];
}

/** One frame's measurement: how lit each line of each bar is, empty end first. */
interface FrameMeasure {
  readonly t: number;
  readonly throttle: readonly number[];
  readonly brake: readonly number[];
}

type Request =
  | { op: "context" }
  | { op: "download" }
  | { op: "crossings"; changes: readonly { t: number; diff: number }[] }
  | { op: "build"; trackKey: TrackKey; carId: string; lapStartS: number; lapEndS: number; frames: readonly FrameMeasure[] }
  | { op: "save"; token: string };

let video: { id: string; title: string } | null = null;
let window: BrowserWindow | null = null;
let built: { token: string; lap: ReferenceLap } | null = null;

/** Every mapped track that has a reference lap to build on, with its cars. */
async function targets(dataDir: string): Promise<Target[]> {
  const repos = localRepositories(dataDir);
  const out: Target[] = [];
  for (const t of await repos.trackMaps.listTracks()) {
    const cars = [];
    for (const carId of await repos.referenceLaps.listCars(t.key)) {
      const lap = await repos.referenceLaps.get(t.key, carId);
      if (lap !== null) cars.push({ carId, lapTimeS: lap.lapTimeS });
    }
    if (cars.length === 0) continue;
    out.push({ trackKey: t.key, label: t.configName === "" ? t.trackName : `${t.trackName} — ${t.configName}`, cars });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

const fmtLap = (s: number): string => {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(3).padStart(6, "0")}`;
};

async function build(deps: VideoTracesDeps, r: Extract<Request, { op: "build" }>) {
  const repos = localRepositories(deps.resolveDataDir(deps.getSettings()));
  const base = await repos.referenceLaps.get(r.trackKey, r.carId);
  if (base === null) throw new Error("there is no reference lap for that car on that track to build on");
  const version = await repos.trackMaps.latestVersion(r.trackKey);
  const map = version === null ? null : await repos.trackMaps.get({ ...r.trackKey, mapVersion: version });
  if (map === null) throw new Error("that track has no map");
  const samples = r.frames.map((f) => ({ t: f.t, throttle: barFill(f.throttle), brake: barFill(f.brake) }));
  const lap = referenceFromVideo({
    base,
    samples,
    lapStartS: r.lapStartS,
    lapEndS: r.lapEndS,
    lengthM: map.lengthM as Metres,
    corners: map.corners,
  });
  const token = randomUUID();
  built = { token, lap };
  return {
    token,
    lapTimeS: lap.lapTimeS,
    baseLapTimeS: base.lapTimeS,
    summary: `${fmtLap(lap.lapTimeS)} from the video, built on the ${fmtLap(base.lapTimeS)} reference lap of ${r.carId}.`,
    base: { throttle: base.channels.throttle, brake: base.channels.brake },
    video: { throttle: lap.channels.throttle, brake: lap.channels.brake },
  };
}

async function save(deps: VideoTracesDeps, token: string): Promise<string> {
  if (built === null || built.token !== token) throw new Error("build the lap again — that one is no longer here");
  const repos = localRepositories(deps.resolveDataDir(deps.getSettings()));
  await repos.referenceLaps.put(built.lap);
  const lap = built.lap;
  built = null;
  deps.changed();
  return `Saved: the ${fmtLap(lap.lapTimeS)} lap from the video is now the reference for ${lap.carId} on ${trackKeyId(lap.trackKey)}.`;
}

export function installVideoTracesIpc(deps: VideoTracesDeps): void {
  ipcMain.handle(VIDEO_TRACES_CHANNEL, async (_event, request: Request) => {
    try {
      switch (request.op) {
        case "context":
          return { ok: true, value: { video, targets: await targets(deps.resolveDataDir(deps.getSettings())) } };
        case "download": {
          if (video === null) throw new Error("no video chosen — open this from the importer");
          const yt = await resolveYtDlpSetup(TOOLS_DIR);
          if (yt === null) throw new Error("yt-dlp is not installed — install it from the importer first");
          const path = await downloadVideo(yt, video.id, join(VIDEO_DIR, `${video.id}.mp4`));
          return { ok: true, value: pathToFileURL(path).href };
        }
        case "crossings":
          return { ok: true, value: findCrossings(request.changes) };
        case "build":
          return { ok: true, value: await build(deps, request) };
        case "save":
          return { ok: true, value: await save(deps, request.token) };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

/** Open the tracer on a video, or point the open one at it. */
export function openTracer(preload: string, chosen: { id: string; title: string }): void {
  video = chosen;
  if (window !== null && !window.isDestroyed()) {
    void window.loadFile(PAGE);
    window.show();
    window.focus();
    return;
  }
  window = new BrowserWindow({
    ...windowBounds("tracer", { width: 1280, height: 860 }),
    title: "Exxeed — Traces From Video (experimental)",
    backgroundColor: "#101215",
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  rememberWindow("tracer", window);
  void window.loadFile(PAGE);
  window.once("closed", () => {
    window = null;
  });
}
