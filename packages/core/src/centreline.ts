/**
 * The track centreline — SPEC.md §4.1.1.
 *
 * §4.1.1 says to project `Lat`/`Lon` and treats dead reckoning as the fallback:
 * "Use Lat/Lon unless it turns out to be unavailable."
 *
 * It turned out to be unavailable. iRacing does not expose `Lat` or `Lon` at all
 * — they are absent from the telemetry variable list, not merely zero — so the
 * fallback is the only path there is, and this module is it.
 *
 * That is less alarming than §4.1.1 makes it sound. Integrating the car-frame
 * velocities against heading over one clean Daytona lap closes the loop to 1.9 m
 * over 5701 m, far below anything a schematic map or the note editor (§7.4) can
 * show.
 *
 * **Lat/Lon did come back, from outside the live SDK.** iRacing's disk telemetry
 * (`.ibt`) records them, and so do exports built from it, such as Garage 61's
 * lap CSVs. For those, `buildCentrelineFromPositions` projects the positions
 * directly — §4.1.1's primary path — with no drift to correct and no yaw sense
 * to guess, so no mirrored map. The steering check still runs, as a check on the
 * data rather than a way to pick an orientation.
 */

import type { Metres, Pct } from "./units.js";

/**
 * What integrating a lap needs from each sample.
 *
 * Structural rather than importing `TelemetryFrame`, for the same reason as
 * `LapSample` in resample.ts: `packages/core` sits below `@exxeed/telemetry`.
 */
export interface CentrelineSample {
  readonly tMs: number;
  readonly lapDistPct: Pct;
  /** Car-frame velocity: X forward, Y lateral, m/s. */
  readonly velocityXMps: number;
  readonly velocityYMps: number;
  /** Heading relative to north, radians. */
  readonly yawNorthRad: number;
  /** Used to decide handedness — see `buildCentreline`. */
  readonly steerRad: number;
}

export interface CentrelineOptions {
  /**
   * Sign of `steerRad` when turning right. Required for the same reason
   * `detectCorners` requires it (§12) — and here it is what keeps the map from
   * coming out mirrored.
   */
  readonly steerSignRight: 1 | -1;
  /** Ignore samples below this |steerRad| when checking handedness. */
  readonly minSteerRad?: number;
}

export interface CentrelineResult {
  /** Matches `Centreline` in schema.ts — this is what a `TrackMap` carries. */
  readonly centreline: { gridSize: number; x: number[]; y: number[] };
  /** How far from its own start the uncorrected loop ended, in metres. */
  readonly closureErrorM: number;
  /** Integrated path length. Compare against the track's real length. */
  readonly pathLengthM: number;
  /** Which sense of `yawNorthRad` was used. Discovered, not assumed. */
  readonly yawSign: 1 | -1;
  /**
   * Fraction of turning samples whose path curvature agreed with the steering
   * input, 0..1. This is the number that says the map is not mirrored.
   */
  readonly orientationAgreement: number;
}

export class CentrelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CentrelineError";
  }
}

/** Samples further apart than this are a stall or a dropped chunk, not motion. */
const MAX_DT_S = 0.5;

interface Integration {
  readonly x: number[];
  readonly y: number[];
  readonly cumM: number[];
  readonly pct: number[];
  readonly steer: number[];
  readonly pathLengthM: number;
  readonly closureErrorM: number;
}

function integrate(samples: readonly CentrelineSample[], yawSign: 1 | -1): Integration {
  let x = 0;
  let y = 0;
  let cum = 0;
  const xs: number[] = [];
  const ys: number[] = [];
  const cums: number[] = [];
  const pcts: number[] = [];
  const steers: number[] = [];

  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    const dt = (b.tMs - a.tMs) / 1000;
    if (dt <= 0 || dt > MAX_DT_S) continue;

    const yaw = yawSign * a.yawNorthRad;
    // Rotate the car-frame velocity into the world frame. X forward, Y lateral,
    // and the world frame is x = east, y = north.
    const east = a.velocityXMps * Math.sin(yaw) + a.velocityYMps * Math.cos(yaw);
    const north = a.velocityXMps * Math.cos(yaw) - a.velocityYMps * Math.sin(yaw);

    x += east * dt;
    y += north * dt;
    cum += Math.hypot(east, north) * dt;

    xs.push(x);
    ys.push(y);
    cums.push(cum);
    pcts.push(a.lapDistPct);
    steers.push(a.steerRad);
  }

  return {
    x: xs,
    y: ys,
    cumM: cums,
    pct: pcts,
    steer: steers,
    pathLengthM: cum,
    closureErrorM: Math.hypot(x, y),
  };
}

/**
 * How often the drawn path curves the way the driver was steering.
 *
 * With x = east and y = north, a positive cross product between successive
 * segments is a counter-clockwise turn, which is a left. So a right-hand corner
 * — `sign(steerRad) === steerSignRight` — must show a negative cross product.
 */
function agreement(run: Integration, steerSignRight: 1 | -1, minSteer: number): number {
  let checked = 0;
  let agreed = 0;
  const stride = 3; // Consecutive 60 Hz points are too close to give a stable cross.

  for (let i = stride; i < run.x.length - stride; i++) {
    const steer = run.steer[i]!;
    if (Math.abs(steer) < minSteer) continue;

    const dx1 = run.x[i]! - run.x[i - stride]!;
    const dy1 = run.y[i]! - run.y[i - stride]!;
    const dx2 = run.x[i + stride]! - run.x[i]!;
    const dy2 = run.y[i + stride]! - run.y[i]!;
    const cross = dx1 * dy2 - dy1 * dx2;
    if (cross === 0) continue;

    const turningRight = Math.sign(steer) === steerSignRight;
    checked++;
    if (turningRight === cross < 0) agreed++;
  }

  return checked === 0 ? 0 : agreed / checked;
}

/**
 * Integrate one lap into a 2D centreline on the pct grid.
 *
 * **The handedness of `yawNorthRad` is discovered, not assumed** — but not by
 * closure, which is a trap. Negating the yaw very nearly mirrors the path, and a
 * mirrored loop closes exactly as well as the right one; on the Daytona fixture
 * the two differ only because lateral velocity breaks the symmetry. A mirrored
 * map is silently wrong in the §12 sense: it draws a plausible circuit with every
 * left turned into a right, and nothing downstream can tell.
 *
 * So the sign is chosen by checking the drawn curvature against the steering
 * input, whose convention was measured on a real lap (§5, M0b). That is
 * independent ground truth rather than a self-consistency check. Closure is still
 * reported, as a quality measure of the integration.
 *
 * The closure error is then distributed along the lap in proportion to distance
 * travelled. Spreading it by distance rather than by sample index matters:
 * samples bunch up where the car is slow, so an index-weighted correction would
 * push the corners around and leave the straights alone.
 */
export function buildCentreline(
  samples: readonly CentrelineSample[],
  gridSize: number,
  lengthM: Metres,
  options: CentrelineOptions,
): CentrelineResult {
  if (!Number.isInteger(gridSize) || gridSize < 2) {
    throw new CentrelineError(`gridSize must be an integer >= 2, got ${gridSize}`);
  }
  if (samples.length < 2) {
    throw new CentrelineError(`need at least 2 samples, got ${samples.length}`);
  }

  const minSteer = options.minSteerRad ?? 0.15;
  const forward = integrate(samples, 1);
  const reverse = integrate(samples, -1);

  if (forward.x.length === 0) {
    throw new CentrelineError(
      "no usable samples — every interval was zero-length or longer than " +
        `${MAX_DT_S}s. Is this a recording rather than a single lap?`,
    );
  }

  // A lap recorded before the motion channels existed parses fine and integrates
  // to a single point (M0b). Failing loudly here is the whole reason this check
  // exists: a centreline of 2000 identical points is a valid-looking artefact
  // that draws nothing, and it would surface much later, in the editor.
  if (forward.pathLengthM < lengthM * 0.5) {
    throw new CentrelineError(
      `integrated path is ${forward.pathLengthM.toFixed(0)} m against a track length of ` +
        `${lengthM.toFixed(0)} m. The velocity channels are missing or zero — this recording ` +
        `predates them and cannot produce a centreline.`,
    );
  }

  const forwardScore = agreement(forward, options.steerSignRight, minSteer);
  const reverseScore = agreement(reverse, options.steerSignRight, minSteer);

  const useReverse = reverseScore > forwardScore;
  const best = useReverse ? reverse : forward;
  const yawSign: 1 | -1 = useReverse ? -1 : 1;
  const orientationAgreement = useReverse ? reverseScore : forwardScore;

  if (orientationAgreement < 0.8) {
    throw new CentrelineError(
      `the drawn path agrees with the steering input only ${(orientationAgreement * 100).toFixed(0)}% ` +
        `of the time in either yaw sense (forward ${(forwardScore * 100).toFixed(0)}%, ` +
        `reverse ${(reverseScore * 100).toFixed(0)}%). Refusing to emit a centreline that may be ` +
        `mirrored — check steerSignRight and the velocity channels.`,
    );
  }

  const n = best.x.length;
  const total = best.cumM[n - 1]!;
  const driftX = best.x[n - 1]!;
  const driftY = best.y[n - 1]!;

  const corrX = new Array<number>(n);
  const corrY = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const share = total > 0 ? best.cumM[i]! / total : 0;
    corrX[i] = best.x[i]! - driftX * share;
    corrY[i] = best.y[i]! - driftY * share;
  }

  const centreline = toGrid(corrX, corrY, best.pct, gridSize);

  return {
    centreline,
    closureErrorM: best.closureErrorM,
    pathLengthM: best.pathLengthM,
    yawSign,
    orientationAgreement,
  };
}

/**
 * Put a drawn path onto the pct grid, so the map, the corners, the landmarks and
 * the traces all share one index space (§4.1.1).
 */
function toGrid(
  xs: readonly number[],
  ys: readonly number[],
  pcts: readonly number[],
  gridSize: number,
): { gridSize: number; x: number[]; y: number[] } {
  const gx = new Array<number>(gridSize).fill(Number.NaN);
  const gy = new Array<number>(gridSize).fill(Number.NaN);
  for (let i = 0; i < xs.length; i++) {
    const cell = Math.min(gridSize - 1, Math.max(0, Math.floor(pcts[i]! * gridSize)));
    if (Number.isNaN(gx[cell]!)) {
      gx[cell] = xs[i]!;
      gy[cell] = ys[i]!;
    }
  }

  // Cells the car crossed too fast to land a sample in: carry the previous point
  // forward, wrapping, so the array has no holes for the renderer to trip on.
  const firstGood = gx.findIndex((v) => !Number.isNaN(v));
  if (firstGood === -1) throw new CentrelineError("no grid cell received a sample");
  for (let k = 0; k < gridSize; k++) {
    const i = (firstGood + k) % gridSize;
    if (Number.isNaN(gx[i]!)) {
      const prev = (i - 1 + gridSize) % gridSize;
      gx[i] = gx[prev]!;
      gy[i] = gy[prev]!;
    }
  }
  return { gridSize, x: gx, y: gy };
}

/** A sample with a real position, for `buildCentrelineFromPositions`. */
export interface PositionSample {
  readonly lapDistPct: Pct;
  /** Degrees, WGS84 as iRacing writes them. */
  readonly lat: number;
  readonly lon: number;
  readonly steerRad: number;
}

/** Mean Earth radius, metres. The projection error over a circuit is centimetres. */
const EARTH_RADIUS_M = 6371008.8;

/** Does this lap carry real positions, rather than the zeros a live recording has? */
export function hasPositions(samples: readonly { lat: number; lon: number }[]): boolean {
  if (samples.length < 2) return false;
  const real = samples.filter((s) => (s.lat !== 0 || s.lon !== 0) && Number.isFinite(s.lat) && Number.isFinite(s.lon));
  return real.length >= samples.length * 0.95;
}

/**
 * A centreline from recorded positions — §4.1.1's primary path.
 *
 * An equirectangular projection about the lap's mean latitude: x east and y
 * north in metres. At circuit scale that is exact to well under the width of a
 * kerb. Nothing is integrated, so there is no drift to spread and no yaw sense to
 * discover; closure is simply how far the last sample is from the first, which
 * for one lap from the line is the distance covered in one sample.
 */
export function buildCentrelineFromPositions(
  samples: readonly PositionSample[],
  gridSize: number,
  options: CentrelineOptions,
): CentrelineResult {
  if (!Number.isInteger(gridSize) || gridSize < 2) {
    throw new CentrelineError(`gridSize must be an integer >= 2, got ${gridSize}`);
  }
  const real = samples.filter((s) => (s.lat !== 0 || s.lon !== 0) && Number.isFinite(s.lat) && Number.isFinite(s.lon));
  if (real.length < 2) throw new CentrelineError(`need at least 2 samples with positions, got ${real.length}`);

  const lat0 = real.reduce((a, s) => a + s.lat, 0) / real.length;
  const lon0 = real.reduce((a, s) => a + s.lon, 0) / real.length;
  const rad = Math.PI / 180;
  const kx = EARTH_RADIUS_M * Math.cos(lat0 * rad) * rad;
  const ky = EARTH_RADIUS_M * rad;

  const x = real.map((s) => (s.lon - lon0) * kx);
  const y = real.map((s) => (s.lat - lat0) * ky);
  let path = 0;
  for (let i = 1; i < x.length; i++) path += Math.hypot(x[i]! - x[i - 1]!, y[i]! - y[i - 1]!);

  const run: Integration = {
    x,
    y,
    cumM: [],
    pct: real.map((s) => s.lapDistPct),
    steer: real.map((s) => s.steerRad),
    pathLengthM: path,
    closureErrorM: Math.hypot(x[x.length - 1]! - x[0]!, y[y.length - 1]! - y[0]!),
  };

  // Positions cannot be mirrored, so a low score here means the steering data or
  // its sign convention is wrong — worth refusing just the same, because corner
  // directions come from that same steering.
  const orientationAgreement = agreement(run, options.steerSignRight, options.minSteerRad ?? 0.15);
  if (orientationAgreement < 0.8) {
    throw new CentrelineError(
      `the recorded path agrees with the steering input only ${(orientationAgreement * 100).toFixed(0)}% ` +
        "of the time. Positions cannot be mirrored, so the steering channel or its sign is wrong.",
    );
  }

  return {
    centreline: toGrid(x, y, run.pct, gridSize),
    closureErrorM: run.closureErrorM,
    pathLengthM: path,
    yawSign: 1,
    orientationAgreement,
  };
}
