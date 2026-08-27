/**
 * The delta bar's arithmetic — SPEC.md §7.2.
 *
 *   delta = currentElapsedS - reference.channels.elapsedS[pctIndex]
 *
 * Which is only that simple because `ReferenceLap` is resampled onto a fixed pct
 * grid (§4.3): comparison is an array index with no time alignment. It is the
 * decision the spec calls the single most useful one in the data model, and this
 * is where it pays.
 *
 * Computed in main, not the renderer, for the same reason the engine is: the
 * renderer draws what it is told (§7). Pure arithmetic, so it lives in core
 * where the lint boundary keeps it honest and the tests can reach it.
 */

import { pctToIndex } from "./pct.js";
import type { Pct, Seconds } from "./units.js";
import { seconds } from "./units.js";

/**
 * Turns a stream of absolute session times into elapsed-lap times.
 *
 * The sim gives session time, not lap time, so the lap's start has to be caught
 * as it goes past. Until a start/finish crossing has been seen there is nothing
 * to measure from — and reporting a delta anyway, against a lap whose start was
 * guessed, would be worse than reporting none.
 */
export class LapTimer {
  #lapStartS: number | null = null;
  #lastPct: number | null = null;

  /** Elapsed time on the current lap, or null before the first crossing. */
  update(sessionTimeS: number, lapDistPct: number): Seconds | null {
    const last = this.#lastPct;
    this.#lastPct = lapDistPct;

    // Same half-lap test §6.2 re-arms on: a car sitting near the line jitters
    // across it, and counting every backwards step as a crossing reported 4404
    // laps for a six-lap session.
    if (last !== null && last - lapDistPct > 0.5) {
      this.#lapStartS = sessionTimeS;
    }

    if (this.#lapStartS === null) return null;
    return seconds(sessionTimeS - this.#lapStartS);
  }

  reset(): void {
    this.#lapStartS = null;
    this.#lastPct = null;
  }
}

export interface DeltaInput {
  readonly lapElapsedS: Seconds | null;
  readonly lapDistPct: Pct;
  readonly referenceElapsedS: readonly number[];
  readonly gridSize: number;
}

/** Seconds up or down on the reference at this point of the lap. */
export function deltaSeconds(input: DeltaInput): Seconds | null {
  if (input.lapElapsedS === null) return null;

  const reference = input.referenceElapsedS[pctToIndex(input.lapDistPct, input.gridSize)];
  if (reference === undefined) return null;

  return seconds(input.lapElapsedS - reference);
}
