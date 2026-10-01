/**
 * How long until the car reaches a callout's point — the question every
 * trigger asks (§6.1).
 *
 * The first answer was distance ÷ current speed: assume the car holds the
 * speed it has now. It never does. Down a straight into a braking zone the car
 * is still gaining speed when the callout starts, so it arrives sooner than
 * that assumed; out of a corner the reverse. The editor drew both — the blue
 * arc walked along the reference lap's real speeds, the dashed line where the
 * engine actually started — and authors were left nudging `leadAdjustS` to
 * close the gap one note at a time.
 *
 * With a reference lap there is a better answer: the reference lap already
 * says how long that stretch of track takes. Scale it by how fast the car is
 * going compared with the reference at the same point, and at reference pace
 * the engine starts exactly where the editor's blue arc does. Without one,
 * the constant-speed answer is all there is.
 */

import type { ReferenceLap } from "./schema.js";
import { wrapPct } from "./pct.js";
import type { Metres, Mps, Pct } from "./units.js";

export interface LeadModel {
  /** Seconds until the car, at `atPct` doing `speedMps`, reaches `eventPct` (`dAheadM` ahead). */
  secondsAhead(atPct: Pct, eventPct: Pct, dAheadM: Metres, speedMps: Mps): number;
}

/** Distance over current speed. A stopped car is never about to arrive — unless it is already there. */
export const constantSpeedLead: LeadModel = {
  secondsAhead: (_atPct, _eventPct, dAheadM, speedMps) =>
    speedMps > 0 ? dAheadM / speedMps : dAheadM === 0 ? 0 : Number.POSITIVE_INFINITY,
};

/** Slowest speed the profile is walked at — the same floor the editor's windows use (trigger-window.ts). */
export const PROFILE_FLOOR_MPS = 5;

/**
 * How far the driver's pace may stretch the reference timing. A car crawling
 * back to the pits is not going to be "three times as late"; past these
 * bounds the reference no longer says anything useful about this lap.
 */
const PACE_MIN = 0.5;
const PACE_MAX = 2;

/**
 * Timing from the reference lap's speed profile.
 *
 * Precomputes the time from the line to every grid cell once, so each tick is
 * two lookups and a subtraction — this runs at 60 Hz for every armed note.
 */
export function referenceLead(lap: ReferenceLap, lengthM: Metres): LeadModel {
  const grid = lap.gridSize;
  const stepM = lengthM / grid;
  const speed = (i: number): number => {
    const v = lap.channels.speedMps[i];
    return v === undefined || v < PROFILE_FLOOR_MPS ? PROFILE_FLOOR_MPS : v;
  };

  // cumulative[i]: seconds from the line to the start of cell i.
  const cumulative = new Float64Array(grid + 1);
  for (let i = 0; i < grid; i++) cumulative[i + 1] = cumulative[i]! + stepM / speed(i);
  const lapS = cumulative[grid]!;

  const timeAt = (p: number): number => {
    const x = wrapPct(p) * grid;
    const i = Math.min(grid - 1, Math.floor(x));
    return cumulative[i]! + (x - i) * (cumulative[i + 1]! - cumulative[i]!);
  };

  return {
    secondsAhead(atPct, eventPct, _dAheadM, speedMps) {
      const reference = (((timeAt(eventPct) - timeAt(atPct)) % lapS) + lapS) % lapS;
      const here = speed(Math.min(grid - 1, Math.floor(wrapPct(atPct) * grid)));
      // Slower than the reference here: everything ahead takes longer.
      const pace = Math.min(PACE_MAX, Math.max(PACE_MIN, here / Math.max(speedMps, 1)));
      return reference * pace;
    },
  };
}
