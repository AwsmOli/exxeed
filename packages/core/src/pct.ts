/**
 * Lap-position arithmetic — SPEC.md §4.6.
 *
 * EVERY distance comparison in this codebase goes through one of these. Plain
 * `a - b` or `Math.abs(a - b)` on lap percentages is a bug (SPEC.md §12), and it
 * is a particularly nasty one because it only shows up at the single corner
 * nearest start/finish — which at Spa is turn 1, the corner people care most
 * about. See the `t1_board_100` landmark at pct 0.99781 in §4.2.
 */

import type { Metres, Pct } from "./units.js";
import { metres, pct } from "./units.js";

/** Fold any real number onto 0..1. Handles negatives, unlike a bare `% 1`. */
export const wrapPct = (p: number): Pct => pct(((p % 1) + 1) % 1);

/**
 * Distance ahead from `from` to `to`, travelling in the racing direction.
 * Always 0..lengthM — never negative, so it is safe to compare against a lead
 * distance without a sign check.
 */
export const aheadM = (from: Pct, to: Pct, lengthM: Metres): Metres =>
  metres(wrapPct(to - from) * lengthM);

/**
 * Signed shortest distance between two lap positions, −lengthM/2 .. +lengthM/2.
 * Positive means `a` is later on the lap than `b`.
 *
 * Used wherever "how far apart are these two points" is the question — the fading
 * error metric (§6.5) and stage 4 ingest validation (§10) both depend on it being
 * wraparound-safe.
 */
export const deltaM = (a: Pct, b: Pct, lengthM: Metres): Metres =>
  metres((((a - b + 1.5) % 1) - 0.5) * lengthM);

/** Move a lap position along the track by a signed distance in metres. */
export const offsetPct = (p: Pct, byM: Metres, lengthM: Metres): Pct =>
  wrapPct(p + byM / lengthM);

/**
 * Index into a fixed-size pct grid (SPEC.md §4.3 — `ReferenceLap.gridSize`).
 * Clamped into range so callers get a usable index rather than `undefined` from
 * `noUncheckedIndexedAccess` at the exact grid edge.
 */
export const pctToIndex = (p: Pct, gridSize: number): number => {
  const i = Math.floor(wrapPct(p) * gridSize);
  return i >= gridSize ? gridSize - 1 : i;
};

/** Centre of grid cell `i`, as a lap position. */
export const indexToPct = (i: number, gridSize: number): Pct =>
  wrapPct((i + 0.5) / gridSize);
