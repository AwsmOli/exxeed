/**
 * ReplayAdapter — SPEC.md §9.
 *
 * "You cannot iterate on callout timing by driving laps. Highest-leverage thing
 * in the build, so it comes BEFORE the note engine, not after."
 *
 * This is the adapter everything is actually developed against. It reads a
 * recording back on a virtual clock at any speed, runs on any platform, and needs
 * no sim — which is what lets the engine, the schemas and the tests be built on a
 * machine that cannot run iRacing at all.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import { mps, pct, radians, seconds } from "@exxeed/core";

import { isTrkLoc, TRK_LOC, type TelemetryFrame, type TrkLoc } from "./frame.js";
import type { TelemetrySource } from "./source.js";

export interface ReplayOptions {
  /**
   * Playback rate. 1 = real time, 100 = a hundred times faster. Pass
   * `Number.POSITIVE_INFINITY` (or use `speed: 0`) to run flat out with no
   * pacing at all, which is what the golden-file tests want.
   */
  readonly speed?: number;
  readonly loop?: boolean;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Parse one NDJSON line into a frame. This is an I/O boundary, so it is one of
 * the few places allowed to call the unit constructors (SPEC.md §3).
 */
export function parseFrame(line: string): TelemetryFrame | null {
  const raw: unknown = JSON.parse(line);
  if (typeof raw !== "object" || raw === null) return null;

  const r = raw as Record<string, unknown>;
  if (r["kind"] === "meta") return null;

  const num = (key: string): number => {
    const v = r[key];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`telemetry frame field "${key}" is not a finite number`);
    }
    return v;
  };
  const bool = (key: string): boolean => r[key] === true;

  const surface = num("playerTrackSurface");
  const trkLoc: TrkLoc = isTrkLoc(surface) ? surface : TRK_LOC.NotInWorld;

  return {
    tMs: num("tMs"),
    sessionTimeS: seconds(num("sessionTimeS")),
    lap: num("lap"),
    lapDistPct: pct(num("lapDistPct")),
    speedMps: mps(num("speedMps")),
    throttle: num("throttle"),
    brake: num("brake"),
    gear: num("gear"),
    steerRad: radians(num("steerRad")),
    lat: num("lat"),
    lon: num("lon"),
    isOnTrack: bool("isOnTrack"),
    onPitRoad: bool("onPitRoad"),
    isInGarage: bool("isInGarage"),
    playerTrackSurface: trkLoc,
    playerCarTowTime: num("playerCarTowTime"),
    enterExitReset: num("enterExitReset"),
  };
}

export class ReplayAdapter implements TelemetrySource {
  readonly name: string;
  readonly #path: string;
  readonly #speed: number;
  readonly #loop: boolean;
  #connected = false;

  constructor(path: string, options: ReplayOptions = {}) {
    this.#path = path;
    this.#speed = options.speed === undefined || options.speed <= 0
      ? Number.POSITIVE_INFINITY
      : options.speed;
    this.#loop = options.loop ?? false;
    this.name = `replay:${path.split("/").pop() ?? path}`;
  }

  get connected(): boolean {
    return this.#connected;
  }

  connect(): Promise<void> {
    this.#connected = true;
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.#connected = false;
    return Promise.resolve();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<TelemetryFrame> {
    do {
      yield* this.#readOnce();
    } while (this.#loop && this.#connected);
  }

  async *#readOnce(): AsyncGenerator<TelemetryFrame> {
    const lines = createInterface({
      input: createReadStream(this.#path, { encoding: "utf8" }),
      crlfDelay: Number.POSITIVE_INFINITY,
    });

    // The virtual clock: pace against the recording's own tMs, not wall time, so
    // playback speed is exact and a paused debugger doesn't skew the timeline.
    let firstFrameMs: number | null = null;
    let startedAt = 0;

    try {
      for await (const line of lines) {
        if (!this.#connected) return;
        if (line.trim() === "") continue;

        const frame = parseFrame(line);
        if (frame === null) continue;

        if (Number.isFinite(this.#speed)) {
          if (firstFrameMs === null) {
            firstFrameMs = frame.tMs;
            startedAt = Date.now();
          }
          const dueAt = startedAt + (frame.tMs - firstFrameMs) / this.#speed;
          const waitMs = dueAt - Date.now();
          if (waitMs > 1) await sleep(waitMs);
        }

        yield frame;
      }
    } finally {
      lines.close();
    }
  }
}
