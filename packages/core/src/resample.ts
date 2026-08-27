/**
 * Resampling a driven lap onto the fixed pct grid — SPEC.md §4.3.
 *
 * "Resample to a fixed LapDistPct grid. The single most useful decision in the
 * data model: comparison, delta and overlay rendering become array indexing with
 * no time alignment."
 *
 * Everything downstream of a recording consumes this, not raw frames: corner
 * detection (§5), the onset functions (§5.1), the centreline (§4.1.1) and the
 * trace overlay (§7.1) all assume one lap on one evenly-spaced grid. Doing it
 * once here is what keeps them from each inventing their own alignment.
 *
 * This is also the gate. A recording contains out-laps, spins, resets and pit
 * stops as well as laps, and a track map cut from one of those is wrong in a way
 * nothing downstream can detect — so `resampleLap` reports what it could not
 * vouch for rather than quietly returning arrays of the right length.
 */

import type { Metres, Pct } from "./units.js";
import { metres, pct, seconds, type Seconds } from "./units.js";

/**
 * The fields resampling needs from one telemetry sample.
 *
 * Declared structurally rather than importing `TelemetryFrame`, because that
 * lives in `@exxeed/telemetry`, which depends on this package — and §3 keeps
 * `packages/core` at the bottom of the stack. A `TelemetryFrame` satisfies this
 * without either side knowing about the other.
 */
export interface LapSample {
  readonly tMs: number;
  readonly lapDistPct: Pct;
  readonly speedMps: number;
  readonly throttle: number;
  readonly brake: number;
  readonly gear: number;
  readonly steerRad: number;
}

/** One lap on the pct grid. Channel names match `ReferenceLap.channels` (§4.3). */
export interface ResampledLap {
  readonly gridSize: number;
  readonly lengthM: Metres;
  readonly speedMps: readonly number[];
  readonly throttle: readonly number[];
  readonly brake: readonly number[];
  readonly gear: readonly number[];
  readonly steerRad: readonly number[];
  /** Elapsed lap time at each grid position — what §7.2's delta bar reads. */
  readonly elapsedS: readonly number[];
  readonly lapTimeS: Seconds;
}

export interface ResampleResult {
  readonly lap: ResampledLap;
  /**
   * Fraction of grid cells that had a real sample either side of them, 0..1.
   * Below 1 means the car was moving fast enough, or the log sparse enough, that
   * some cells were interpolated across a gap.
   */
  readonly coverage: number;
  /** Non-fatal problems. A lap with any of these is not fit to cut a map from. */
  readonly warnings: readonly string[];
}

export class LapResampleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LapResampleError";
  }
}

/** Largest gap between consecutive samples we will interpolate across, in pct. */
const MAX_GAP_PCT = 0.02;

/**
 * Resample one lap's samples onto `gridSize` evenly-spaced positions.
 *
 * `samples` must be a single lap in driving order, ascending in `lapDistPct`.
 * Splitting a recording into laps is the caller's job — it needs the lap counter
 * and the suppression channels, which are telemetry concerns, not core ones.
 *
 * Values are linearly interpolated between the two bracketing samples rather
 * than snapped to the nearest one. At 60 Hz a grid cell holds about four samples
 * on a slow corner and none at all on a straight, so snapping would alias the
 * fast sections and interpolation would not.
 */
export function resampleLap(
  samples: readonly LapSample[],
  gridSize: number,
  lengthM: Metres,
): ResampleResult {
  if (!Number.isInteger(gridSize) || gridSize < 2) {
    throw new LapResampleError(`gridSize must be an integer >= 2, got ${gridSize}`);
  }
  if (samples.length < 2) {
    throw new LapResampleError(`need at least 2 samples to resample, got ${samples.length}`);
  }

  const warnings: string[] = [];

  // Ascending order is a precondition, not something to sort into place: a lap
  // whose pct goes backwards is a reset or a wrong-way excursion, and silently
  // sorting it would turn a rejectable lap into a plausible-looking one.
  for (let i = 1; i < samples.length; i++) {
    if (samples[i]!.lapDistPct < samples[i - 1]!.lapDistPct) {
      throw new LapResampleError(
        `samples must ascend in lapDistPct; index ${i} goes backwards ` +
          `(${samples[i - 1]!.lapDistPct.toFixed(4)} -> ${samples[i]!.lapDistPct.toFixed(4)}). ` +
          `Split the recording into laps before resampling.`,
      );
    }
  }

  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  if (first.lapDistPct > 0.02 || last.lapDistPct < 0.98) {
    warnings.push(
      `lap covers only ${first.lapDistPct.toFixed(3)}..${last.lapDistPct.toFixed(3)} of the grid ` +
        `— this is a partial lap`,
    );
  }

  const speedMps = new Array<number>(gridSize);
  const throttle = new Array<number>(gridSize);
  const brake = new Array<number>(gridSize);
  const gear = new Array<number>(gridSize);
  const steerRad = new Array<number>(gridSize);
  const elapsedS = new Array<number>(gridSize);

  const t0 = first.tMs;
  let covered = 0;
  let cursor = 0;
  let widestGapPct = 0;

  for (let i = 0; i < gridSize; i++) {
    // Cell centres, matching indexToPct in pct.ts.
    const target = (i + 0.5) / gridSize;

    while (cursor < samples.length - 2 && samples[cursor + 1]!.lapDistPct < target) cursor++;

    const a = samples[cursor]!;
    const b = samples[cursor + 1]!;
    const span = b.lapDistPct - a.lapDistPct;
    const t = span > 0 ? (target - a.lapDistPct) / span : 0;
    // Clamp rather than extrapolate at the two ends, where the grid can reach
    // slightly past the first and last sample.
    const k = t < 0 ? 0 : t > 1 ? 1 : t;

    const lerp = (x: number, y: number): number => x + (y - x) * k;

    speedMps[i] = lerp(a.speedMps, b.speedMps);
    throttle[i] = lerp(a.throttle, b.throttle);
    brake[i] = lerp(a.brake, b.brake);
    steerRad[i] = lerp(a.steerRad, b.steerRad);
    elapsedS[i] = lerp(a.tMs - t0, b.tMs - t0) / 1000;
    // Gear is an integer selection, not a quantity — interpolating it would
    // invent a gear 3.4 that the car was never in.
    gear[i] = k < 0.5 ? a.gear : b.gear;

    if (span <= MAX_GAP_PCT && target >= a.lapDistPct && target <= b.lapDistPct) covered++;
    if (span > widestGapPct) widestGapPct = span;
  }

  if (widestGapPct > MAX_GAP_PCT) {
    warnings.push(
      `widest sample gap is ${(widestGapPct * 100).toFixed(2)}% of the lap ` +
        `(${(widestGapPct * lengthM).toFixed(0)} m) — dropped frames or a paused sim`,
    );
  }

  const coverage = covered / gridSize;
  const lapTimeS = (last.tMs - first.tMs) / 1000;

  return {
    lap: {
      gridSize,
      lengthM,
      speedMps,
      throttle,
      brake,
      gear,
      steerRad,
      elapsedS,
      lapTimeS: seconds(lapTimeS),
    },
    coverage,
    warnings,
  };
}

/** Lap position of grid cell `i` — the inverse of the grid this module builds. */
export const cellPct = (i: number, gridSize: number): Pct => pct((i + 0.5) / gridSize);

/** Distance one grid cell spans. */
export const cellLengthM = (gridSize: number, lengthM: Metres): Metres =>
  metres(lengthM / gridSize);
