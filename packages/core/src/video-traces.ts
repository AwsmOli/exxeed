/**
 * Throttle and brake from a guide video — experimental.
 *
 * Most track-guide videos show the driver's inputs as bars in an on-screen
 * overlay. The tracer window plays the video and measures, frame by frame,
 * how much of each bar is lit; this turns those measurements into a
 * reference lap whose inputs are the video's, so the callouts made from that
 * video and the reference they are compared against are the same lap.
 *
 * What the video cannot give — speed, gear, the time at each point — comes
 * from an existing reference lap for the same track and car, stretched to the
 * video's lap time. Speed and gear are therefore approximate; throttle and
 * brake are measured.
 */

import { perCornerMetrics } from "./onsets.js";
import type { ResampledLap } from "./resample.js";
import type { ReferenceLap } from "./schema.js";
import type { Metres, Seconds } from "./units.js";

/**
 * How full a bar is, 0–1, from how lit each line across it is, ordered from
 * the bar's empty end to its full end (bottom to top for an upright bar).
 *
 * A bar fills from its empty end without gaps, so the fill is the lit run
 * from that end: a line counts as lit when most of it is, a thin unlit edge
 * at the very end (the bar's border, a box drawn a little too big) is
 * stepped over, and a line or two of video noise inside the run does not
 * end it. Anything lit further up — the scene showing through a see-through
 * overlay, a number painted on the bar — is not part of the run, so it does
 * not count.
 */
export function barFill(profile: readonly number[]): number {
  const n = profile.length;
  if (n === 0) return 0;
  const lit = (i: number): boolean => profile[i]! >= 0.5;
  // Step over a thin unlit edge at the empty end.
  const edge = Math.max(2, Math.round(n * 0.15));
  let i = 0;
  while (i < n && i < edge && !lit(i)) i++;
  if (i === n || !lit(i)) return 0;
  let end = i;
  let gap = 0;
  for (; i < n; i++) {
    if (lit(i)) {
      end = i + 1;
      gap = 0;
    } else if (++gap > 2) {
      break;
    }
  }
  return end / n;
}

/**
 * The pedal bars, read from one box drawn loosely round both.
 *
 * Per frame and per column of the box, the renderer records the lit run
 * from the bottom of the box up, once for green (throttle) and once for red
 * (brake): the row where it starts and the row where it ends, rows counted
 * from the top, −1 for none. Laid out as frames × columns × 4:
 * [green bottom, green top, red bottom, red top].
 */
export interface PedalFrames {
  readonly width: number;
  readonly height: number;
  /** Seconds into the video, one per frame. */
  readonly times: ArrayLike<number>;
  readonly runs: ArrayLike<number>;
}

export interface BarPlace {
  /** First and last column of the bar, in the box. */
  readonly x0: number;
  readonly x1: number;
}

export interface PedalCalibration {
  readonly throttle: BarPlace | null;
  readonly brake: BarPlace | null;
  /** The bars' empty and full rows, in the box (0 at the top). */
  readonly bottom: number;
  readonly top: number;
}

const at = (f: PedalFrames, frame: number, column: number, k: number): number =>
  f.runs[(frame * f.width + column) * 4 + k]!;

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))]!;
};

/**
 * The columns of the box where a bar of this colour is: those lit in a long
 * run often. A bar is full or nearly so for long stretches; a trace line
 * scrolling through the box makes a long upright run in a column only for
 * the moment it passes. Returns the best column's neighbours that are about
 * as busy, as a span.
 */
function findBar(
  f: PedalFrames,
  k: number,
  minRun: number,
  limits: { from: number; to: number; bottom: number; slack: number } | null = null,
): BarPlace | null {
  const frames = f.times.length;
  const busy = new Array<number>(f.width).fill(0);
  const from = limits?.from ?? 0;
  const to = limits?.to ?? f.width - 1;
  for (let i = 0; i < frames; i++) {
    for (let x = from; x <= to; x++) {
      const bot = at(f, i, x, k);
      const top = at(f, i, x, k + 1);
      if (bot < 0 || bot - top + 1 < minRun) continue;
      // A bar fills from its bottom: a run that starts elsewhere is not it.
      if (limits !== null && Math.abs(bot - limits.bottom) > limits.slack) continue;
      busy[x]!++;
    }
  }
  let best = from;
  for (let x = from + 1; x <= to; x++) if (busy[x]! > busy[best]!) best = x;
  if (busy[best]! < Math.max(3, frames * 0.01)) return null;
  const enough = busy[best]! * 0.5;
  let x0 = best;
  let x1 = best;
  while (x0 > from && busy[x0 - 1]! >= enough) x0--;
  while (x1 < to && busy[x1 + 1]! >= enough) x1++;
  return { x0, x1 };
}

/**
 * Where the bars are and what full is, from the whole video. The throttle
 * bar is full again and again over a lap, so its usual bottom is 0% and the
 * highest it reaches — all but a stray frame or two — is 100%. The brake
 * bar sits beside it at the same height, so it uses the same rows.
 */
export function calibratePedals(f: PedalFrames): PedalCalibration {
  const throttle = findBar(f, 0, Math.max(4, f.height * 0.3));
  const bottoms: number[] = [];
  const tops: number[] = [];
  if (throttle !== null) {
    for (let i = 0; i < f.times.length; i++) {
      for (let x = throttle.x0; x <= throttle.x1; x++) {
        const bot = at(f, i, x, 0);
        if (bot < 0) continue;
        bottoms.push(bot);
        tops.push(at(f, i, x, 1));
      }
    }
  }
  let bottom = Math.round(percentile(bottoms, 0.5));
  let top = Math.round(percentile(tops, 0.02));
  // The brake bar sits beside the throttle bar, filling from the same row:
  // look for it only in the columns either side, and only at runs that
  // start there. Red elsewhere in the box — a glove, a sleeve, a kerb seen
  // through the overlay — is not it.
  let brake: BarPlace | null;
  if (throttle !== null && Number.isFinite(bottom)) {
    const w = throttle.x1 - throttle.x0 + 1;
    const slack = Math.max(2, Math.round((bottom - top + 1) * 0.12));
    const near = { bottom, slack };
    const left = findBar(f, 2, Math.max(3, f.height * 0.1), { from: Math.max(0, throttle.x0 - 4 * w), to: Math.max(0, throttle.x0 - 1), ...near });
    const right = findBar(f, 2, Math.max(3, f.height * 0.1), { from: Math.min(f.width - 1, throttle.x1 + 1), to: Math.min(f.width - 1, throttle.x1 + 4 * w), ...near });
    brake = left ?? right;
  } else {
    brake = findBar(f, 2, Math.max(3, f.height * 0.15));
  }
  if (!Number.isFinite(bottom)) bottom = f.height - 1;
  if (!Number.isFinite(top)) top = 0;
  return { throttle, brake, bottom, top };
}

/**
 * Each frame's throttle and brake, 0–1, from the calibration: the median
 * over the bar's columns of how far its run reaches from the bar's bottom
 * towards full. A run that does not start at the bar's bottom is not the bar
 * filling — the scene through a see-through overlay, a trace line — and
 * counts as empty.
 */
export function pedalFills(f: PedalFrames, cal: PedalCalibration): VideoInputSample[] {
  const full = Math.max(1, cal.bottom - cal.top + 1);
  const slack = Math.max(2, Math.round(full * 0.12));
  const fillOf = (i: number, bar: BarPlace | null, k: number): number => {
    if (bar === null) return 0;
    const values: number[] = [];
    for (let x = bar.x0; x <= bar.x1; x++) {
      const bot = at(f, i, x, k);
      const top = at(f, i, x, k + 1);
      values.push(bot < 0 || bot < cal.bottom - slack ? 0 : Math.max(0, Math.min(1, (cal.bottom - top + 1) / full)));
    }
    return percentile(values, 0.5);
  };
  const out: VideoInputSample[] = [];
  for (let i = 0; i < f.times.length; i++) {
    out.push({ t: f.times[i]!, throttle: fillOf(i, cal.throttle, 0), brake: fillOf(i, cal.brake, 2) });
  }
  return out;
}

export interface FrameChange {
  /** Seconds into the video. */
  readonly t: number;
  /** How different this frame's box is from the previous frame's, 0–1. */
  readonly diff: number;
}

/**
 * The moments a box changed suddenly — where something that only changes at
 * the start/finish line (a lap number, a last-lap time) did. A change counts
 * when it is far above the box's usual frame-to-frame noise; changes closer
 * together than `minGapS` are one event, at its strongest frame.
 */
export function findCrossings(changes: readonly FrameChange[], minGapS = 5): number[] {
  if (changes.length < 3) return [];
  const sorted = [...changes.map((c) => c.diff)].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const threshold = Math.max(median * 6, 0.04);
  const out: { t: number; diff: number }[] = [];
  for (const c of changes) {
    if (c.diff < threshold) continue;
    const last = out[out.length - 1];
    if (last !== undefined && c.t - last.t < minGapS) {
      if (c.diff > last.diff) out[out.length - 1] = { t: c.t, diff: c.diff };
      continue;
    }
    out.push({ t: c.t, diff: c.diff });
  }
  return out.map((c) => c.t);
}

export interface VideoInputSample {
  /** Seconds into the video. */
  readonly t: number;
  /** 0–1. */
  readonly throttle: number;
  readonly brake: number;
}

/** Linear interpolation of the samples at time t; the nearest end outside them. */
function inputsAt(samples: readonly VideoInputSample[], t: number): { throttle: number; brake: number } {
  let lo = 0;
  let hi = samples.length - 1;
  if (t <= samples[0]!.t) return samples[0]!;
  if (t >= samples[hi]!.t) return samples[hi]!;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid]!.t <= t) lo = mid;
    else hi = mid;
  }
  const a = samples[lo]!;
  const b = samples[hi]!;
  const k = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
  return { throttle: a.throttle + (b.throttle - a.throttle) * k, brake: a.brake + (b.brake - a.brake) * k };
}

export interface VideoReferenceOptions {
  /** The reference lap to take speed, gear and timing from. */
  readonly base: ReferenceLap;
  /** Measured inputs, in video time. */
  readonly samples: readonly VideoInputSample[];
  /** Video seconds at which the car crosses the line, starting and ending the lap. */
  readonly lapStartS: number;
  readonly lapEndS: number;
  /** The track's length and corners, to recompute the braking and throttle points. */
  readonly lengthM: Metres;
  readonly corners: readonly { readonly index: number; readonly entryPct: number; readonly apexPct: number; readonly exitPct: number }[];
}

/**
 * A reference lap with the video's throttle and brake, timed as the video's
 * lap: the base lap's time profile stretched evenly to the video's lap time,
 * so a point a third of the way through the base lap's time is a third of the
 * way through the video's.
 */
export function referenceFromVideo(o: VideoReferenceOptions): ReferenceLap {
  const { base } = o;
  const lapTimeS = o.lapEndS - o.lapStartS;
  if (!(lapTimeS > 0)) throw new Error("the lap must end after it starts");
  if (o.samples.length === 0) throw new Error("no inputs were measured");
  const k = lapTimeS / base.lapTimeS;
  const elapsedS = base.channels.elapsedS.map((e) => e * k);
  const throttle: number[] = [];
  const brake: number[] = [];
  for (const e of elapsedS) {
    const at = inputsAt(o.samples, o.lapStartS + e);
    throttle.push(Math.max(0, Math.min(1, at.throttle)));
    brake.push(Math.max(0, Math.min(1, at.brake)));
  }
  const channels = {
    ...base.channels,
    speedMps: base.channels.speedMps.map((v) => v / k),
    throttle,
    brake,
    elapsedS,
  };
  const lap: ResampledLap = {
    gridSize: base.gridSize,
    lengthM: o.lengthM,
    ...channels,
    lapTimeS: lapTimeS as Seconds,
  };
  const perCorner: ReferenceLap["perCorner"] = {};
  for (const c of o.corners) perCorner[String(c.index)] = perCornerMetrics(lap, c, o.lengthM);
  return { ...base, lapTimeS, channels, perCorner, brakeChannelInferred: false };
}

// ---------------------------------------------------------------------------
// Reading the overlay's speed, so the lap is placed from the video alone.
//
// The renderer cuts each digit out of the speed box, frame by frame, and
// shrinks it to a small grid of how lit each cell is (GLYPH_CELLS values,
// plus its width over height). The same font in the same place makes the
// same shapes, so clustering them leaves about ten groups; the person names
// each once, and every frame's number follows.
// ---------------------------------------------------------------------------

/** A glyph's grid: 10 columns × 14 rows, then its aspect. */
export const GLYPH_W = 10;
export const GLYPH_H = 14;
export const GLYPH_DIMS = GLYPH_W * GLYPH_H + 1;

export interface GlyphClusters {
  /** Per glyph, the cluster it belongs to. */
  readonly ids: Int32Array;
  readonly centroids: number[][];
  readonly counts: number[];
}

const glyphDistance = (a: ArrayLike<number>, ao: number, b: readonly number[]): number => {
  let sum = 0;
  for (let i = 0; i < GLYPH_DIMS; i++) sum += Math.abs(a[ao + i]! - b[i]!);
  return sum / GLYPH_DIMS;
};

/**
 * Group glyphs that look alike: each joins the nearest group within
 * `threshold` (mean difference per cell, 0–1), or starts one. A group's
 * shape is the running mean of its members. Groups are numbered by size,
 * largest first.
 */
export function clusterGlyphs(vectors: ArrayLike<number>, threshold = 0.1): GlyphClusters {
  const n = Math.floor(vectors.length / GLYPH_DIMS);
  const centroids: number[][] = [];
  const counts: number[] = [];
  const raw = new Int32Array(n);
  for (let g = 0; g < n; g++) {
    const o = g * GLYPH_DIMS;
    let best = -1;
    let bestD = Infinity;
    for (let c = 0; c < centroids.length; c++) {
      const d = glyphDistance(vectors, o, centroids[c]!);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (best < 0 || bestD > threshold) {
      centroids.push(Array.from({ length: GLYPH_DIMS }, (_, i) => vectors[o + i]!));
      counts.push(1);
      raw[g] = centroids.length - 1;
      continue;
    }
    const k = ++counts[best]!;
    const c = centroids[best]!;
    for (let i = 0; i < GLYPH_DIMS; i++) c[i]! += (vectors[o + i]! - c[i]!) / k;
    raw[g] = best;
  }
  const order = counts.map((_, i) => i).sort((a, b) => counts[b]! - counts[a]!);
  const rank = new Int32Array(order.length);
  order.forEach((c, r) => (rank[c] = r));
  return {
    ids: raw.map((c) => rank[c]!),
    centroids: order.map((c) => centroids[c]!),
    counts: order.map((c) => counts[c]!),
  };
}

/**
 * Each frame's number, from its glyphs left to right and what each group was
 * named: "0"–"9" for a digit, "" for something to skip (a unit, a smudge).
 * Null for a frame with no digits, or with a glyph from a group not named.
 */
export function readNumbers(
  frames: number,
  glyphFrame: ArrayLike<number>,
  ids: ArrayLike<number>,
  labels: readonly (string | null)[],
): (number | null)[] {
  const text = Array.from({ length: frames }, () => "");
  const bad = new Uint8Array(frames);
  for (let g = 0; g < ids.length; g++) {
    const f = glyphFrame[g]!;
    const label = labels[ids[g]!] ?? null;
    if (label === null) bad[f] = 1;
    else text[f] += label;
  }
  return text.map((t, f) => (bad[f] === 1 || !/^\d+$/.test(t) ? null : Number(t)));
}

/**
 * Speeds with misreads taken out and short gaps filled: a reading far from
 * its neighbours' middle value is dropped (a digit caught changing, a car
 * passing behind a see-through overlay), then gaps of up to `maxGapS` are
 * bridged linearly.
 */
export function cleanSpeeds(times: ArrayLike<number>, values: readonly (number | null)[], maxJump = 25, maxGapS = 1): (number | null)[] {
  const n = values.length;
  const out: (number | null)[] = [...values];
  const window = 5;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v === null || v === undefined) continue;
    const near: number[] = [];
    for (let j = Math.max(0, i - window); j <= Math.min(n - 1, i + window); j++) {
      const w = values[j];
      if (j !== i && w !== null && w !== undefined) near.push(w);
    }
    if (near.length < 3) continue;
    near.sort((a, b) => a - b);
    if (Math.abs(v - near[Math.floor(near.length / 2)]!) > maxJump) out[i] = null;
  }
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (out[i] === null) continue;
    if (last >= 0 && i - last > 1 && times[i]! - times[last]! <= maxGapS) {
      const a = out[last]!;
      const b = out[i]!;
      for (let j = last + 1; j < i; j++) out[j] = a + ((b - a) * (times[j]! - times[last]!)) / (times[i]! - times[last]!);
    }
    last = i;
  }
  return out;
}

/**
 * Gears with one-frame misreads taken out and gaps filled: a gear held for
 * less than `minHoldS` between two stretches of the same other gear is that
 * other gear (a digit caught changing), and a frame with no reading has the
 * gear before it. A moment of neutral between two gears — the lever passing
 * through — is the gear it was on its way to. Null only before the first reading.
 */
export function cleanGears(times: ArrayLike<number>, values: readonly (number | null)[], minHoldS = 0.1, neutralS = 0.75): (number | null)[] {
  const out: (number | null)[] = [];
  let last: number | null = null;
  for (const v of values) {
    if (v !== null && v !== undefined) last = v;
    out.push(last);
  }
  for (let i = 0; i < out.length; ) {
    let j = i;
    while (j < out.length && out[j] === out[i]) j++;
    const before = i > 0 ? out[i - 1]! : null;
    if (before !== null && j < out.length && out[j] === before && times[j]! - times[i]! < minHoldS) out.fill(before, i, j);
    // Neutral on the way from one gear to the next is the gear being taken.
    else if (out[i] === 0 && before !== null && j < out.length && times[j]! - times[i]! < neutralS) out.fill(out[j]!, i, j);
    i = j;
  }
  return out;
}

export interface VideoLapSample extends VideoInputSample {
  /** Speed read off the overlay, km/h; null where it could not be. */
  readonly speedKph: number | null;
  /** Gear read off the overlay (0 neutral); null or absent where it was not. */
  readonly gear?: number | null;
}

/**
 * A reference lap entirely from the video: where the car is at each moment
 * comes from its own speed, added up over the lap and scaled to the track's
 * length, so a point is placed by how far the car had gone — not by another
 * driver's timing. Speed, throttle and brake are the video's, and the gear
 * where it was read; steering, and the gear otherwise, come from `base` at
 * the same place.
 */
export function referenceFromVideoSpeed(o: Omit<VideoReferenceOptions, "samples"> & { readonly samples: readonly VideoLapSample[] }): ReferenceLap {
  const { base } = o;
  const lapTimeS = o.lapEndS - o.lapStartS;
  if (!(lapTimeS > 0)) throw new Error("the lap must end after it starts");
  const inLap = o.samples.filter((s) => s.t >= o.lapStartS && s.t <= o.lapEndS && s.speedKph !== null);
  if (inLap.length < 10) throw new Error("no speed was read over this lap");
  const covered = inLap.length / o.samples.filter((s) => s.t >= o.lapStartS && s.t <= o.lapEndS).length;
  if (covered < 0.8) throw new Error(`the speed was read on only ${Math.round(covered * 100)}% of the lap`);

  // Distance by time, from the start line: trapezoids between readings.
  const ts = [o.lapStartS];
  const ds = [0];
  let prevT = o.lapStartS;
  let prevV = inLap[0]!.speedKph! / 3.6;
  for (const s of inLap) {
    const v = s.speedKph! / 3.6;
    ds.push(ds[ds.length - 1]! + ((prevV + v) / 2) * (s.t - prevT));
    ts.push(s.t);
    prevT = s.t;
    prevV = v;
  }
  ds.push(ds[ds.length - 1]! + prevV * (o.lapEndS - prevT));
  ts.push(o.lapEndS);
  // The overlay's speed and the track's own length never agree exactly (a
  // line, a rounding, a units slip): scale so the lap is the track.
  const scale = o.lengthM / ds[ds.length - 1]!;

  const grid = base.gridSize;
  const timeAt: number[] = [];
  let j = 0;
  for (let i = 0; i < grid; i++) {
    const d = (i / grid) * ds[ds.length - 1]!;
    while (j < ds.length - 2 && ds[j + 1]! < d) j++;
    const span = ds[j + 1]! - ds[j]!;
    const k = span > 0 ? (d - ds[j]!) / span : 0;
    timeAt.push(ts[j]! + (ts[j + 1]! - ts[j]!) * k);
  }
  const speedAt = (t: number): number => {
    let lo = 0;
    let hi = inLap.length - 1;
    if (t <= inLap[0]!.t) return inLap[0]!.speedKph!;
    if (t >= inLap[hi]!.t) return inLap[hi]!.speedKph!;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (inLap[mid]!.t <= t) lo = mid;
      else hi = mid;
    }
    const a = inLap[lo]!;
    const b = inLap[hi]!;
    return a.speedKph! + ((b.speedKph! - a.speedKph!) * (t - a.t)) / (b.t - a.t);
  };
  const throttle: number[] = [];
  const brake: number[] = [];
  for (const t of timeAt) {
    const at = inputsAt(o.samples, t);
    throttle.push(Math.max(0, Math.min(1, at.throttle)));
    brake.push(Math.max(0, Math.min(1, at.brake)));
  }
  // The video's gear where it was read over (nearly) the whole lap: the one
  // showing at that moment. Otherwise the base lap's.
  const geared = o.samples.filter((s) => s.t >= o.lapStartS && s.t <= o.lapEndS && s.gear !== null && s.gear !== undefined);
  const all = o.samples.filter((s) => s.t >= o.lapStartS && s.t <= o.lapEndS).length;
  let gear = base.channels.gear;
  if (geared.length >= all * 0.8) {
    let g = 0;
    gear = timeAt.map((t) => {
      while (g < geared.length - 1 && geared[g + 1]!.t <= t) g++;
      return geared[g]!.gear!;
    });
  }
  const channels = {
    ...base.channels,
    gear,
    speedMps: timeAt.map((t) => (speedAt(t) / 3.6) * scale),
    throttle,
    brake,
    elapsedS: timeAt.map((t) => t - o.lapStartS),
  };
  const lap: ResampledLap = { gridSize: grid, lengthM: o.lengthM, ...channels, lapTimeS: lapTimeS as Seconds };
  const perCorner: ReferenceLap["perCorner"] = {};
  for (const c of o.corners) perCorner[String(c.index)] = perCornerMetrics(lap, c, o.lengthM);
  return { ...base, lapTimeS, channels, perCorner, brakeChannelInferred: false };
}
