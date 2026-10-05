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
