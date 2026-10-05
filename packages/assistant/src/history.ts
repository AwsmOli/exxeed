/**
 * Whether a gap is growing or shrinking.
 *
 * A `RaceView` is one moment: it says the car behind is 1.8 s back and nothing
 * about a minute ago. "Is he catching me?" is a question about the change, so
 * the gaps are kept here as they go by and the change is worked out from them —
 * in the app, with arithmetic, rather than by a model guessing from two numbers
 * it happened to be shown.
 *
 * ## Lap over lap, where there is a lap to compare with
 *
 * The gap on the road breathes within a lap: two cars a fixed distance apart
 * are further apart in seconds through a hairpin than down a straight, and one
 * car is always better than the other somewhere. A line fitted through a minute
 * of that reads the breathing as a trend — a ±0.3 s swing fits to half a second
 * a lap of closing that is not happening.
 *
 * So the gap now is compared with the gap at the same place on the track one
 * lap ago. Whatever repeats every lap cancels, and what is left is the change
 * per lap, which is the unit the answer is wanted in anyway.
 *
 * Before there is a lap of unbroken history, a fitted line over the last minute
 * is the best there is, and is reported as that (`basis: "window"`) so the
 * answer can be hedged.
 */

import type { RaceView } from "@exxeed/overlays";

interface Sample {
  readonly tS: number;
  /** Seconds on the road, positive ahead — `RelativeRow.gapS`. */
  readonly gapS: number;
  /** The player's laps plus lap position. Null when the view does not say. */
  readonly dist: number | null;
}

/** How much history is kept per car: this long, or this many laps, whichever is more. */
const KEEP_S = 180;
const KEEP_LAPS = 1.25;

/** A gap in the samples longer than this starts the series again. */
const MAX_STEP_S = 5;

/**
 * A change this large between two samples is not racing, it is a discontinuity:
 * a spin, a tow, or the gap wrapping as a car goes a lap down.
 */
const MAX_JUMP_S = 3;

/** The lap-over-lap change is averaged over this much of the lap just driven. */
const AVERAGE_OVER_LAPS = 0.1;

/** The fitted line: how far back it looks, and the least it will work from. */
const WINDOW_S = 60;
const MIN_SPAN_S = 15;
const MIN_SAMPLES = 10;

export type GapTrend =
  | {
      readonly basis: "lap";
      /** Seconds on the road now, positive ahead. */
      readonly gapS: number;
      /** Seconds the gap closed over the last lap: positive is closing, whichever side the car is on. */
      readonly closingPerLapS: number;
    }
  | {
      readonly basis: "window";
      readonly gapS: number;
      /** Seconds the gap closes per second of racing. Multiply by a lap time for "per lap". */
      readonly closingPerS: number;
      /** How much history the fit is over, seconds. */
      readonly spanS: number;
    };

/** The gap at `dist`, interpolated, or null if the series does not reach back that far. */
function gapAt(samples: readonly Sample[], dist: number): number | null {
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    if (a.dist === null || b.dist === null) continue;
    if (a.dist <= dist && dist <= b.dist) {
      const f = b.dist === a.dist ? 0 : (dist - a.dist) / (b.dist - a.dist);
      return a.gapS + (b.gapS - a.gapS) * f;
    }
  }
  return null;
}

function lapOverLap(samples: readonly Sample[]): number | null {
  const now = samples[samples.length - 1]?.dist ?? null;
  if (now === null) return null;

  let sum = 0;
  let n = 0;
  for (const s of samples) {
    if (s.dist === null || s.dist < now - AVERAGE_OVER_LAPS) continue;
    const before = gapAt(samples, s.dist - 1);
    if (before === null) continue;
    sum += s.gapS - before;
    n += 1;
  }
  return n === 0 ? null : sum / n;
}

function fittedSlope(all: readonly Sample[]): { slope: number; spanS: number } | null {
  const last = all[all.length - 1];
  if (last === undefined) return null;
  const samples = all.filter((s) => last.tS - s.tS <= WINDOW_S);
  const first = samples[0];
  if (first === undefined || samples.length < MIN_SAMPLES) return null;
  const spanS = last.tS - first.tS;
  if (spanS < MIN_SPAN_S) return null;

  const n = samples.length;
  const meanT = samples.reduce((a, s) => a + s.tS, 0) / n;
  const meanG = samples.reduce((a, s) => a + s.gapS, 0) / n;
  let num = 0;
  let den = 0;
  for (const s of samples) {
    num += (s.tS - meanT) * (s.gapS - meanG);
    den += (s.tS - meanT) ** 2;
  }
  return den === 0 ? null : { slope: num / den, spanS };
}

export class GapHistory {
  readonly #series = new Map<number, Sample[]>();
  #lastT: number | null = null;

  /**
   * Feed one race view. `tS` is any monotonic clock in seconds; going
   * backwards (a replay looping, a new session) forgets everything.
   */
  record(tS: number, view: RaceView | null): void {
    if (view === null || (this.#lastT !== null && tS < this.#lastT)) {
      this.clear();
      if (view === null) return;
    }
    this.#lastT = tS;

    const player = view.relatives.find((r) => r.isPlayer);
    // In the pits every gap is changing for a reason that is not pace.
    if (player === undefined || player.onPitRoad) {
      this.#series.clear();
      return;
    }

    const pct = view.cars.find((c) => c.isPlayer)?.lapDistPct ?? null;
    const dist = pct === null ? null : view.lap + pct;

    for (const row of view.relatives) {
      if (row.isPlayer) continue;
      if (row.onPitRoad) {
        this.#series.delete(row.carIdx);
        continue;
      }
      const series = this.#series.get(row.carIdx) ?? [];
      const last = series[series.length - 1];
      const broken =
        last !== undefined &&
        (tS - last.tS > MAX_STEP_S ||
          Math.abs(row.gapS - last.gapS) > MAX_JUMP_S ||
          // The player going backwards along the lap is a reset or a tow.
          (dist !== null && last.dist !== null && dist < last.dist - 0.01));
      const kept = broken
        ? []
        : series.filter(
            (s) => tS - s.tS <= KEEP_S || (dist !== null && s.dist !== null && dist - s.dist <= KEEP_LAPS),
          );
      kept.push({ tS, gapS: row.gapS, dist });
      this.#series.set(row.carIdx, kept);
    }

    // A car that has dropped out of the relative stops being sampled; forget it
    // once what is held could no longer join up with a new sample anyway.
    for (const [carIdx, series] of this.#series) {
      const last = series[series.length - 1];
      if (last === undefined || tS - last.tS > MAX_STEP_S) this.#series.delete(carIdx);
    }
  }

  /** The trend for one car, or null if there is not enough to say. */
  trend(carIdx: number): GapTrend | null {
    const samples = this.#series.get(carIdx);
    const last = samples?.[samples.length - 1];
    if (samples === undefined || last === undefined) return null;

    // Ahead is positive and closing means falling; behind is negative and
    // closing means rising. One sign for "closing" either way.
    const closing = (change: number): number => (last.gapS >= 0 ? -change : change);

    const perLap = lapOverLap(samples);
    if (perLap !== null) return { basis: "lap", gapS: last.gapS, closingPerLapS: closing(perLap) };

    const fit = fittedSlope(samples);
    if (fit === null) return null;
    return { basis: "window", gapS: last.gapS, closingPerS: closing(fit.slope), spanS: fit.spanS };
  }

  clear(): void {
    this.#series.clear();
    this.#lastT = null;
  }
}
