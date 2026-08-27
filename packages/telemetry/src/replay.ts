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

import { metres, mps, pct, radians, seconds } from "@exxeed/core";

import { isTrkLoc, TRK_LOC, type TelemetryFrame, type TrkLoc } from "./frame.js";
import type { SessionIdentity, TelemetrySource } from "./source.js";

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

  /**
   * For channels added to the frame after recordings already existed. A missing
   * one is an older lap, not a corrupt line, so it defaults rather than throwing
   * — the checked-in fixture and every lap driven before M1 predate the motion
   * channels. Anything consuming them has to reject an all-zero lap on its own;
   * see the centreline builder.
   */
  const numOr = (key: string, fallback: number): number => {
    const v = r[key];
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
  };

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
    velocityXMps: mps(numOr("velocityXMps", 0)),
    velocityYMps: mps(numOr("velocityYMps", 0)),
    yawNorthRad: radians(numOr("yawNorthRad", 0)),
    lapDistM: metres(numOr("lapDistM", 0)),
    isOnTrack: bool("isOnTrack"),
    onPitRoad: bool("onPitRoad"),
    isInGarage: bool("isInGarage"),
    playerTrackSurface: trkLoc,
    playerCarTowTime: num("playerCarTowTime"),
    enterExitReset: num("enterExitReset"),
  };
}

/**
 * Read track and car back out of the recording's header line, so replaying a lap
 * says what it is of. Returns null for a recording written before the header
 * carried it — those still replay fine, they just cannot say.
 */
async function readHeaderIdentity(path: string): Promise<SessionIdentity | null> {
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  try {
    for await (const line of lines) {
      if (line.trim() === "") continue;
      const raw: unknown = JSON.parse(line);
      if (typeof raw !== "object" || raw === null) return null;
      const r = raw as Record<string, unknown>;
      // The header is the first line or it is not there at all.
      if (r["kind"] !== "meta") return null;

      const str = (key: string): string | null =>
        typeof r[key] === "string" ? (r[key] as string) : null;

      const trackId = str("trackId");
      if (trackId === null) return null;

      return {
        trackId,
        trackName: str("trackName") ?? trackId,
        trackConfig: str("trackConfig") ?? "",
        carId: str("carId") ?? "unknown-car",
        carName: str("carName") ?? "unknown car",
      };
    }
    return null;
  } finally {
    lines.close();
  }
}

export class ReplayAdapter implements TelemetrySource {
  readonly name: string;
  readonly #path: string;
  readonly #speed: number;
  readonly #loop: boolean;
  #connected = false;
  #identity: SessionIdentity | null = null;
  /** Accumulated across loop passes — see the note on `#readOnce`. */
  #tOffsetMs = 0;
  #lapOffset = 0;

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

  get identity(): SessionIdentity | null {
    return this.#identity;
  }

  async connect(): Promise<void> {
    this.#identity = await readHeaderIdentity(this.#path);
    this.#connected = true;
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

  /**
   * One pass over the file.
   *
   * ## Why a looped pass offsets `tMs` and `lap`
   *
   * Reaching the end of a recording and starting again is an artefact of replay,
   * not something that happened to the car: it kept driving. So a looped pass
   * continues the clock and the lap counter rather than rewinding them.
   *
   * Without this, a single extracted lap can never produce a callout. §6.4 holds
   * everything quiet until one lap has completed since `IsOnTrack` went true, and
   * a one-lap file reports the same `lap` on every frame of every pass — so the
   * gate stays shut forever and the engine looks broken when it is behaving
   * exactly as specified. Rewinding `tMs` was the same class of problem, and the
   * scheduler grew a guard for it; the guard stays as defence, but the honest fix
   * is not to rewind in the first place.
   *
   * Pacing still works off the file's own timestamps, so playback speed is exact.
   */
  async *#readOnce(): AsyncGenerator<TelemetryFrame> {
    const lines = createInterface({
      input: createReadStream(this.#path, { encoding: "utf8" }),
      crlfDelay: Number.POSITIVE_INFINITY,
    });

    // The virtual clock: pace against the recording's own tMs, not wall time, so
    // playback speed is exact and a paused debugger doesn't skew the timeline.
    let firstFrameMs: number | null = null;
    let startedAt = 0;

    let firstLap: number | null = null;
    let lastFrameMs = 0;
    let lastLap = 0;
    let count = 0;

    try {
      for await (const line of lines) {
        if (!this.#connected) return;
        if (line.trim() === "") continue;

        const raw = parseFrame(line);
        if (raw === null) continue;

        if (Number.isFinite(this.#speed)) {
          if (firstFrameMs === null) {
            firstFrameMs = raw.tMs;
            startedAt = Date.now();
          }
          const dueAt = startedAt + (raw.tMs - firstFrameMs) / this.#speed;
          const waitMs = dueAt - Date.now();
          if (waitMs > 1) await sleep(waitMs);
        }

        if (firstFrameMs === null) firstFrameMs = raw.tMs;
        if (firstLap === null) firstLap = raw.lap;
        lastFrameMs = raw.tMs;
        lastLap = raw.lap;
        count++;

        yield this.#tOffsetMs === 0 && this.#lapOffset === 0
          ? raw
          : { ...raw, tMs: raw.tMs + this.#tOffsetMs, lap: raw.lap + this.#lapOffset };
      }
    } finally {
      lines.close();
    }

    if (this.#loop && firstFrameMs !== null && firstLap !== null && count > 1) {
      // Leave one frame's gap between passes so the join is not a duplicate
      // timestamp, and credit the laps the pass actually covered.
      const spanMs = lastFrameMs - firstFrameMs;
      this.#tOffsetMs += spanMs + spanMs / (count - 1);
      this.#lapOffset += lastLap - firstLap + 1;
    }
  }
}
