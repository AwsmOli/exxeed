/**
 * Completed laps out of a stream of frames, and whether each is clean enough to
 * cut a track map from.
 *
 * A map is cut from exactly one lap (§5), and a bad lap makes a bad map quietly:
 * an off in turn three is a corner that is not there, a tow is a straight line
 * across the infield, a pit stop is a corner in the pit lane. So "clean" here is
 * strict, and says why when it is not — the log line is how someone finds out
 * why the map has not appeared after the lap they thought was fine.
 *
 * Pure and incremental: `push` a frame, get back a lap when one finishes. The
 * same code runs live in the app and over a recording in a test.
 */

import { TRK_LOC, type TelemetryFrame } from "./frame.js";

export interface CompletedLap {
  readonly lap: number;
  readonly frames: readonly TelemetryFrame[];
  readonly lapTimeS: number;
  /** Null when clean; otherwise the first reason it is not, in words. */
  readonly dirty: string | null;
}

/** How close to the line a lap has to start and end to count as covering it. */
const EDGE_PCT = 0.02;
/** A gap in samples longer than this is a pause, a reset or a dropped connection. */
const MAX_GAP_MS = 1000;
/** Backward movement in pct beyond jitter means the car went the wrong way or was reset. */
const MAX_BACKSTEP_PCT = 0.002;

function dirtyReason(frames: readonly TelemetryFrame[]): string | null {
  const first = frames[0]!;
  const last = frames[frames.length - 1]!;
  if (first.lapDistPct > EDGE_PCT) return `started at ${(first.lapDistPct * 100).toFixed(1)}% of the lap, not the line`;
  if (last.lapDistPct < 1 - EDGE_PCT) return `ended at ${(last.lapDistPct * 100).toFixed(1)}% of the lap, not the line`;

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    const at = `at ${(f.lapDistPct * 100).toFixed(0)}%`;
    if (f.isInGarage) return `in the garage ${at}`;
    if (f.onPitRoad) return `on pit road ${at}`;
    if (!f.isOnTrack) return `not on track ${at}`;
    if (f.playerCarTowTime > 0) return `towed ${at}`;
    if (f.playerTrackSurface === TRK_LOC.OffTrack) return `off track ${at}`;
    if (f.playerTrackSurface !== TRK_LOC.OnTrack) return `not on the racing surface ${at}`;
    if (i > 0) {
      const prev = frames[i - 1]!;
      if (f.tMs - prev.tMs > MAX_GAP_MS) return `a ${((f.tMs - prev.tMs) / 1000).toFixed(1)}s gap in telemetry ${at}`;
      if (prev.lapDistPct - f.lapDistPct > MAX_BACKSTEP_PCT) return `went backwards ${at}`;
    }
  }
  return null;
}

export class LapCollector {
  #lap: number | null = null;
  #frames: TelemetryFrame[] = [];

  /** Feed one frame. Returns the lap that just finished, if this frame started a new one. */
  push(frame: TelemetryFrame): CompletedLap | null {
    if (this.#lap === null) {
      this.#lap = frame.lap;
      this.#frames = [frame];
      return null;
    }
    if (frame.lap === this.#lap) {
      this.#frames.push(frame);
      return null;
    }

    const frames = this.#frames;
    const lap = this.#lap;
    this.#lap = frame.lap;
    this.#frames = [frame];

    // A lap counter that jumps by other than one — a reset to the pits, a new
    // session — did not end a lap, it abandoned one.
    if (frame.lap !== lap + 1 || frames.length < 2) return null;

    const lapTimeS = (frames[frames.length - 1]!.tMs - frames[0]!.tMs) / 1000;
    return { lap, frames, lapTimeS, dirty: dirtyReason(frames) };
  }

  reset(): void {
    this.#lap = null;
    this.#frames = [];
  }
}

/** Every completed lap in a list of frames — for recordings, and for tests. */
export function splitLaps(frames: Iterable<TelemetryFrame>): CompletedLap[] {
  const collector = new LapCollector();
  const laps: CompletedLap[] = [];
  for (const frame of frames) {
    const done = collector.push(frame);
    if (done !== null) laps.push(done);
  }
  return laps;
}
