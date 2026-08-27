/**
 * Corner detection — SPEC.md §5.
 *
 * Input is one clean lap already on the pct grid (§4.3). Output is the corner
 * list a `TrackMap` is built from.
 *
 * §5.2 is the important part of this file's brief, and it is a decision about
 * *effort*, not capability: chicanes split, fast kinks fall under the threshold,
 * and one hairpin raises the P98 enough to hide them. "Do not try to solve these
 * algorithmically. Ship a per-track corners.override.json ... Ten minutes per
 * track beats a week of tuning."
 *
 * So this module implements §5's algorithm plainly and does not get clever. The
 * override file is not a workaround for a weak detector — it is the design.
 */

import { wrapPct } from "./pct.js";
import { cellLengthM } from "./resample.js";
import type { ResampledLap } from "./resample.js";
import type { Metres, Pct } from "./units.js";
import { pct } from "./units.js";

/** A corner as detected, before any override is applied. */
export interface DetectedCorner {
  /** 1-based, sequential from start/finish (§5 step 5). */
  readonly index: number;
  readonly entryPct: Pct;
  readonly apexPct: Pct;
  readonly exitPct: Pct;
  readonly direction: "left" | "right";
  /** 1 (flat kink) … 6 (hairpin). */
  readonly severity: number;
  /** Diagnostics — what the override author needs to judge a region by. */
  readonly lengthM: Metres;
  readonly minSpeedMps: number;
  readonly peakSteerRad: number;
  readonly meanSteerRad: number;
}

export interface DetectOptions {
  /**
   * Sign of `steerRad` when turning right.
   *
   * Required, with no default, and deliberately so. §12: "Never assume the
   * steering sign. Measure it." A default here would be an assumption wearing a
   * parameter's clothes — and getting it wrong inverts every corner's direction
   * silently. The measured constant lives with the adapter that defines the
   * frame; pass it in.
   */
  readonly steerSignRight: 1 | -1;
  /** Smoothing window as a fraction of lap length. §5 step 1 says ~0.2%. */
  readonly smoothFraction?: number;
  /** Threshold as a fraction of the 98th percentile. §5 step 2 says 0.15. */
  readonly thresholdFraction?: number;
  /** Regions closer than this are merged. §5 step 3 says 30 m. */
  readonly mergeGapM?: number;
  /** Regions shorter than this are discarded. §5 step 3 says 20 m. */
  readonly minLengthM?: number;
}

const DEFAULTS = {
  smoothFraction: 0.002,
  thresholdFraction: 0.15,
  mergeGapM: 30,
  minLengthM: 20,
} as const;

/** Moving average over ±`win` cells, wrapping at start/finish. */
export function smoothWrapped(values: readonly number[], win: number): number[] {
  const n = values.length;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = -win; k <= win; k++) sum += values[(i + k + n) % n]!;
    out[i] = sum / (2 * win + 1);
  }
  return out;
}

/** Nearest-rank percentile of `values`, 0..1. */
export function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[i]!;
}

/**
 * Severity 1..6, from how slow the corner is and how much lock it takes.
 *
 * §4.1 fixes the ends of the scale — 1 is a flat kink, 6 a hairpin — and leaves
 * the middle to judgement. Speed does most of the work because it is what a
 * driver feels; steering breaks the ties, so a slow-but-open corner and a
 * slow-and-tight one do not score the same.
 */
export function severityOf(minSpeedMps: number, peakSteerRad: number): number {
  const bySpeed =
    minSpeedMps < 15 ? 6 : minSpeedMps < 22 ? 5 : minSpeedMps < 30 ? 4 : minSpeedMps < 40 ? 3 : minSpeedMps < 55 ? 2 : 1;
  const byLock = peakSteerRad > 1.2 ? 6 : peakSteerRad > 0.9 ? 5 : peakSteerRad > 0.6 ? 4 : peakSteerRad > 0.35 ? 3 : peakSteerRad > 0.18 ? 2 : 1;
  const blended = Math.round((bySpeed * 2 + byLock) / 3);
  return Math.min(6, Math.max(1, blended));
}

/** Contiguous runs of `true`, joined across the start/finish wrap. */
function maskedRegions(mask: readonly boolean[]): { start: number; end: number }[] {
  const n = mask.length;
  const regions: { start: number; end: number }[] = [];
  let start: number | null = null;

  for (let i = 0; i < n; i++) {
    if (mask[i] && start === null) start = i;
    else if (!mask[i] && start !== null) {
      regions.push({ start, end: i - 1 });
      start = null;
    }
  }
  if (start !== null) regions.push({ start, end: n - 1 });

  // A corner sitting on start/finish arrives as one region at each end of the
  // array. Spa's turn 1 is the canonical case (§4.2), so this is not an edge
  // case to skip — it is the corner people care most about.
  if (regions.length > 1) {
    const head = regions[0]!;
    const tail = regions[regions.length - 1]!;
    if (head.start === 0 && tail.end === n - 1) {
      regions.pop();
      regions[0] = { start: tail.start - n, end: head.end };
    }
  }

  return regions;
}

export function detectCorners(lap: ResampledLap, options: DetectOptions): DetectedCorner[] {
  const opts = { ...DEFAULTS, ...options };
  const { gridSize, lengthM, steerRad, speedMps } = lap;
  const mPerCell = cellLengthM(gridSize, lengthM);

  // 1. Smooth.
  const win = Math.max(1, Math.round(opts.smoothFraction * gridSize));
  const smooth = smoothWrapped(steerRad, win);

  // 2. Adaptive threshold off the 98th percentile of |steerSmooth|.
  const threshold = opts.thresholdFraction * percentile(smooth.map(Math.abs), 0.98);

  // 3. Group, merge across small gaps, discard the short ones.
  const raw = maskedRegions(smooth.map((v) => Math.abs(v) > threshold));

  const merged: { start: number; end: number }[] = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last !== undefined && (r.start - last.end - 1) * mPerCell < opts.mergeGapM) last.end = r.end;
    else merged.push({ ...r });
  }

  const kept = merged.filter((r) => (r.end - r.start + 1) * mPerCell >= opts.minLengthM);

  // 4/5. Describe each region and number sequentially from start/finish.
  return kept.map((r, k) => {
    const idx: number[] = [];
    for (let i = r.start; i <= r.end; i++) idx.push((i + gridSize) % gridSize);

    const mean = idx.reduce((sum, i) => sum + smooth[i]!, 0) / idx.length;
    const apex = idx.reduce((best, i) => (speedMps[i]! < speedMps[best]! ? i : best), idx[0]!);
    const peak = idx.reduce((mx, i) => Math.max(mx, Math.abs(smooth[i]!)), 0);
    const minSpeed = speedMps[apex]!;

    return {
      index: k + 1,
      entryPct: wrapPct((r.start + 0.5) / gridSize),
      apexPct: pct((apex + 0.5) / gridSize),
      exitPct: wrapPct((r.end + 0.5) / gridSize),
      direction: Math.sign(mean) === options.steerSignRight ? "right" : "left",
      severity: severityOf(minSpeed, peak),
      lengthM: ((r.end - r.start + 1) * mPerCell) as Metres,
      minSpeedMps: minSpeed,
      peakSteerRad: peak,
      meanSteerRad: mean,
    };
  });
}
