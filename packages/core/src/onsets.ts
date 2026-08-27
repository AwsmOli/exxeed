/**
 * Braking onset and throttle pickup — SPEC.md §5.1.
 *
 * "Both the reference lap and the live driver must use the SAME function, or
 * §6.5's error metric compares different quantities."
 *
 * That is the entire reason these live in `packages/core` rather than in the
 * track-map builder: the builder calls them once per corner to fill
 * `ReferenceLap.perCorner`, and the fading logic (§6.5) calls them every lap
 * against the driver's own trace. Two implementations that agree today would
 * drift apart, and the symptom would be a callout that never fades.
 *
 * §5.1's warning is the one to keep in mind while reading `brakeOnsetPct`:
 * "Note this is the ONSET, not the first sample found scanning backwards — a
 * driver is still hard on the brakes at corner entry, so a naive backwards scan
 * returns something ≈ entryPct and the metric becomes meaningless."
 */

import { wrapPct } from "./pct.js";
import type { ResampledLap } from "./resample.js";
import type { Metres, Pct } from "./units.js";
import { pct } from "./units.js";

/** Brake pressure above which the driver is considered to be braking (§5.1). */
export const BRAKE_ON = 0.15;

/** Throttle above which the driver is considered back on the power (§5.1). */
export const THROTTLE_ON = 0.5;

/** How far back from corner entry to look for the start of braking (§5.1). */
export const BRAKE_SEARCH_M = 300;

/** How far past the apex to look for throttle pickup before giving up. */
export const THROTTLE_SEARCH_M = 400;

const cellsFor = (metresBack: number, gridSize: number, lengthM: Metres): number =>
  Math.max(1, Math.round((metresBack / lengthM) * gridSize));

/**
 * Where braking for this corner began, or null if the car never braked for it.
 *
 * Walks back from `entryPct` to find the braking region, then keeps walking to
 * its beginning — that second part is the whole point. Search is wraparound-safe
 * because a corner 300 m past start/finish has its braking point before the line
 * (§4.2's La Source case).
 */
export function brakeOnsetPct(
  lap: ResampledLap,
  entryPct: Pct,
  lengthM: Metres = lap.lengthM,
): Pct | null {
  const { gridSize, brake } = lap;
  const window = cellsFor(BRAKE_SEARCH_M, gridSize, lengthM);
  const entryCell = Math.min(gridSize - 1, Math.floor(wrapPct(entryPct) * gridSize));

  const at = (k: number): number => brake[((k % gridSize) + gridSize) % gridSize]!;

  // Find the braking region that ends at or before entry, scanning back from
  // entry until we are inside it.
  let inside: number | null = null;
  for (let k = 0; k <= window; k++) {
    if (at(entryCell - k) > BRAKE_ON) {
      inside = entryCell - k;
      break;
    }
  }
  if (inside === null) return null;

  // Then keep going to where that contiguous region started. Stopping at the
  // first braking sample would return a point ≈ entryPct, which is §5.1's
  // explicit failure mode.
  let onset = inside;
  let searched = entryCell - inside;
  while (searched < window && at(onset - 1) > BRAKE_ON) {
    onset--;
    searched++;
  }

  return wrapPct((((onset % gridSize) + gridSize) % gridSize + 0.5) / gridSize);
}

/**
 * Where the driver got back on the throttle after the apex, or null if they did
 * not within `THROTTLE_SEARCH_M`.
 */
export function throttleOnPct(
  lap: ResampledLap,
  apexPct: Pct,
  lengthM: Metres = lap.lengthM,
): Pct | null {
  const { gridSize, throttle } = lap;
  const window = cellsFor(THROTTLE_SEARCH_M, gridSize, lengthM);
  const apexCell = Math.min(gridSize - 1, Math.floor(wrapPct(apexPct) * gridSize));

  for (let k = 0; k <= window; k++) {
    const cell = (apexCell + k) % gridSize;
    if (throttle[cell]! > THROTTLE_ON) return pct((cell + 0.5) / gridSize);
  }
  return null;
}

/** The `ReferenceLap.perCorner` entry for one corner (§4.3). */
export interface PerCornerMetrics {
  readonly brakeOnsetPct: number | null;
  readonly throttleOnPct: number | null;
  readonly minSpeedMps: number;
}

/**
 * Minimum speed between entry and exit, wraparound-safe.
 *
 * Deliberately not "speed at the apex": the apex is where the detector found the
 * minimum on the *baseline* car (§4.1), and this is computed per car.
 */
export function minSpeedBetween(lap: ResampledLap, entryPct: Pct, exitPct: Pct): number {
  const { gridSize, speedMps } = lap;
  const from = Math.floor(wrapPct(entryPct) * gridSize);
  const to = Math.floor(wrapPct(exitPct) * gridSize);
  const span = ((to - from + gridSize) % gridSize) + 1;

  let min = Number.POSITIVE_INFINITY;
  for (let k = 0; k < span; k++) {
    const v = speedMps[(from + k) % gridSize]!;
    if (v < min) min = v;
  }
  return Number.isFinite(min) ? min : 0;
}

/** Both §5.1 metrics plus the minimum speed, for one corner. */
export function perCornerMetrics(
  lap: ResampledLap,
  corner: { entryPct: number; apexPct: number; exitPct: number },
  lengthM: Metres = lap.lengthM,
): PerCornerMetrics {
  return {
    brakeOnsetPct: brakeOnsetPct(lap, pct(corner.entryPct), lengthM),
    throttleOnPct: throttleOnPct(lap, pct(corner.apexPct), lengthM),
    minSpeedMps: minSpeedBetween(lap, pct(corner.entryPct), pct(corner.exitPct)),
  };
}
