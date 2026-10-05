/**
 * Traces from a guide video — experimental.
 *
 * A window of its own, opened from the importer on the guide being looked at.
 * The window plays the video and measures the input bars in its overlay frame
 * by frame (static/tracer.js); this side downloads the video, turns the
 * measurements into a reference lap (core `referenceFromVideoSpeed`, or
 * `referenceFromVideo` when the speed was not read), and saves it
 * once it has been looked at.
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { BrowserWindow, ipcMain } from "electron";

import {
  calibratePedals,
  findCrossings,
  pedalFills,
  referenceFromVideo,
  trackKeyId,
  type Metres,
  type ReferenceLap,
  type TrackKey,
  cleanGears,
  cleanSpeeds,
  clusterGlyphs,
  readNumbers,
  referenceFromVideoSpeed,
  type VideoLapSample,
} from "@exxeed/core";
import { downloadVideo, resolveYtDlpSetup } from "@exxeed/importer";
import type { Settings } from "@exxeed/overlays";
import { localRepositories } from "@exxeed/repo";

import { dataPath } from "./paths.js";
import { rememberWindow, windowBounds } from "./window-state.js";

export const VIDEO_TRACES_CHANNEL = "exxeed:video-traces";

const PAGE = fileURLToPath(new URL("../static/tracer.html", import.meta.url));
const TOOLS_DIR = dataPath("tools");
const VIDEO_DIR = dataPath("video-cache");
/** Reference laps replaced by one from a video, kept to restore. */
const BACKUP_DIR = dataPath("reflaps-replaced");

export interface VideoTracesDeps {
  readonly getSettings: () => Settings;
  readonly resolveDataDir: (settings: Settings) => string;
  /** The reference laps changed: let the running session and the panels know. */
  readonly changed: () => void;
}

interface Target {
  readonly trackKey: TrackKey;
  readonly label: string;
  /** The lap's length, to check a stretch of video against: metres. */
  readonly lengthM: number;
  /** Each car with a reference lap here, and that lap's time — to guess which stretch of the video is a lap. */
  readonly cars: readonly { readonly carId: string; readonly lapTimeS: number }[];
}


type Request =
  | { op: "context" }
  | { op: "download" }
  | { op: "crossings"; changes: readonly { t: number; diff: number }[] }
  /** The whole read of the pedal box (core PedalFrames): where the bars are, and each frame's fills. */
  | { op: "calibrate"; width: number; height: number; times: Float64Array; runs: Int16Array }
  /** The speed box's digits, cut out and shrunk (core GLYPH_DIMS each): group them by shape. */
  | { op: "clusterGlyphs"; vectors: Float32Array }
  /** Each frame's speed from the named groups, misreads taken out; km/h. */
  | { op: "readSpeeds"; times: Float64Array; glyphFrame: Int32Array; ids: Int32Array; labels: (string | null)[]; mph: boolean }
  /** Each frame's gear from the named groups (0 neutral), blips taken out. */
  | { op: "readGears"; times: Float64Array; glyphFrame: Int32Array; ids: Int32Array; labels: (string | null)[] }
  | { op: "build"; trackKey: TrackKey; carId: string; lapStartS: number; lapEndS: number; samples: readonly VideoLapSample[] }
  | { op: "save"; token: string };

let video: { id: string; title: string } | null = null;
let window: BrowserWindow | null = null;
let built: { token: string; lap: ReferenceLap; doubt: boolean } | null = null;

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
    const version = await repos.trackMaps.latestVersion(t.key);
    const map = version === null ? null : await repos.trackMaps.get({ ...t.key, mapVersion: version });
    if (map === null) continue;
    out.push({ trackKey: t.key, lengthM: map.lengthM, label: t.configName === "" ? t.trackName : `${t.trackName} — ${t.configName}`, cars });
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
  const options = {
    base,
    lapStartS: r.lapStartS,
    lapEndS: r.lapEndS,
    lengthM: map.lengthM as Metres,
    corners: map.corners,
  };
  // With the overlay's speed, the lap is placed by how far the car went;
  // without it, by the reference lap's timing stretched to the video's.
  const withSpeed = r.samples.filter((x) => x.t >= r.lapStartS && x.t <= r.lapEndS && x.speedKph !== null).length;
  const inLap = r.samples.filter((x) => x.t >= r.lapStartS && x.t <= r.lapEndS).length;
  const bySpeed = inLap > 0 && withSpeed / inLap >= 0.8;
  const lap = bySpeed ? referenceFromVideoSpeed({ ...options, samples: r.samples }) : referenceFromVideo({ ...options, samples: r.samples });
  // How far the video's speed says the car went, against the track: well off
  // and the stretch is not one lap in real time — a narrated section with the
  // footage held still, a cut, or a guide for another layout.
  let distanceM: number | null = null;
  if (bySpeed) {
    distanceM = 0;
    let prev: VideoLapSample | null = null;
    for (const x of r.samples) {
      if (x.t < r.lapStartS || x.t > r.lapEndS || x.speedKph === null) continue;
      if (prev !== null) distanceM += ((prev.speedKph! + x.speedKph) / 7.2) * (x.t - prev.t);
      prev = x;
    }
  }
  const off = distanceM === null ? 0 : distanceM / map.lengthM - 1;
  const doubt = Math.abs(off) > 0.04;
  const metres = (m: number): string => `${Math.round(m).toLocaleString("en")} m`;
  const check =
    distanceM === null
      ? ""
      : doubt
        ? ` But its speed adds up to ${metres(distanceM)} and the track is ${metres(map.lengthM)}: this stretch is not one whole lap of this layout in real time. Do not save it.`
        : ` Its speed adds up to ${metres(distanceM)} of the track's ${metres(map.lengthM)}.`;
  const withGear = r.samples.filter((x) => x.t >= r.lapStartS && x.t <= r.lapEndS && x.gear !== null && x.gear !== undefined).length;
  const lends = bySpeed && withGear >= inLap * 0.8 ? "is not used but for its steering" : "lends only its gear";
  const token = randomUUID();
  built = { token, lap, doubt };
  return {
    token,
    lapTimeS: lap.lapTimeS,
    baseLapTimeS: base.lapTimeS,
    bySpeed,
    doubt,
    summary: bySpeed
      ? `${fmtLap(lap.lapTimeS)} from the video, placed by its own speed — the ${fmtLap(base.lapTimeS)} reference lap of ${r.carId} ${lends}.${check}`
      : `${fmtLap(lap.lapTimeS)} from the video, placed by the ${fmtLap(base.lapTimeS)} reference lap of ${r.carId}'s timing — read the speed for an exact placing.`,
    speed: { base: base.channels.speedMps, video: lap.channels.speedMps },
    gear: lap.channels.gear,
    base: { throttle: base.channels.throttle, brake: base.channels.brake },
    video: { throttle: lap.channels.throttle, brake: lap.channels.brake },
  };
}

async function save(deps: VideoTracesDeps, token: string): Promise<string> {
  if (built === null || built.token !== token) throw new Error("build the lap again — that one is no longer here");
  if (built.doubt) throw new Error("that stretch of video is not one lap of this track — it is not saved");
  const repos = localRepositories(deps.resolveDataDir(deps.getSettings()));
  // The lap being replaced is kept, so an experiment can be undone: copy it
  // back into reflaps/ to restore it.
  const previous = await repos.referenceLaps.get(built.lap.trackKey, built.lap.carId);
  let kept = "";
  if (previous !== null) {
    const dir = join(BACKUP_DIR, trackKeyId(previous.trackKey).replaceAll("/", "-"));
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${previous.carId}-${new Date().toISOString().replaceAll(":", "-")}.json`);
    await writeFile(file, `${JSON.stringify(previous)}\n`);
    kept = ` The ${fmtLap(previous.lapTimeS)} lap it replaced is kept in ${file}.`;
  }
  await repos.referenceLaps.put(built.lap);
  const lap = built.lap;
  built = null;
  deps.changed();
  return `Saved: the ${fmtLap(lap.lapTimeS)} lap from the video is now the reference for ${lap.carId} on ${trackKeyId(lap.trackKey)}.${kept}`;
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
          const path = await downloadVideo(yt, video.id, join(VIDEO_DIR, `${video.id}-1080p.mp4`));
          return { ok: true, value: pathToFileURL(path).href };
        }
        case "crossings":
          return { ok: true, value: findCrossings(request.changes) };
        case "clusterGlyphs": {
          const c = clusterGlyphs(request.vectors);
          // The groups worth naming: the bigger ones. The rest are smudges and digits caught mid-change.
          const shown = c.counts.findIndex((n) => n < Math.max(5, c.counts[0]! * 0.01));
          const keep = shown < 0 ? c.counts.length : Math.min(shown, 24);
          return { ok: true, value: { ids: c.ids, centroids: c.centroids.slice(0, keep), counts: c.counts.slice(0, keep) } };
        }
        case "readSpeeds": {
          const read = readNumbers(request.times.length, request.glyphFrame, request.ids, request.labels);
          const kph = read.map((v) => (v === null ? null : request.mph ? v * 1.609344 : v));
          return { ok: true, value: cleanSpeeds(request.times, kph) };
        }
        case "readGears":
          return { ok: true, value: cleanGears(request.times, readNumbers(request.times.length, request.glyphFrame, request.ids, request.labels)) };
        case "calibrate": {
          const frames = { width: request.width, height: request.height, times: request.times, runs: request.runs };
          const calibration = calibratePedals(frames);
          return { ok: true, value: { calibration, samples: pedalFills(frames, calibration) } };
        }
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
    // Reading goes on behind other windows: a hidden page is handed no video frames.
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
  });
  rememberWindow("tracer", window);
  void window.loadFile(PAGE);
  window.once("closed", () => {
    window = null;
  });
}
