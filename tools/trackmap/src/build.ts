/**
 * Cutting a `TrackMap` and a `ReferenceLap` from one recorded lap — SPEC.md §5,
 * §4.1 and §4.3.
 *
 * The logic all lives in `@exxeed/core`; this file is the assembly, kept apart
 * from cli.ts so tests drive the same code path the command does.
 *
 * Two artefacts come out, and §4.0 is emphatic that they are keyed differently:
 * the map by `TrackRef` (it holds corner indices, so re-cutting it invalidates
 * anything referring to them) and the reference lap by `TrackKey` + car (raw
 * telemetry, which must survive a re-cut). Getting that backwards is the
 * §4.0 mistake, and it is silent.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import {
  applyOverrides,
  buildCentreline,
  CornerOverridesSchema,
  detectCorners,
  metres,
  perCornerMetrics,
  resampleLap,
  type Corner,
  type CornerOverrides,
  type DetectedCorner,
  type ReferenceLap,
  type TrackMap,
  type TrackRef,
} from "@exxeed/core";
import { parseFrame, STEER_SIGN_RIGHT, assertSteeringSignMeasured, type TelemetryFrame } from "@exxeed/telemetry";

export interface BuildOptions {
  readonly recordingPath: string;
  readonly trackRef: TrackRef;
  readonly trackName: string;
  readonly configName: string;
  readonly carId: string;
  /** Track length. Taken from the lap's own `lapDistM` channel when omitted. */
  readonly lengthM?: number;
  readonly gridSize?: number;
  readonly overrides?: CornerOverrides;
}

export interface BuildResult {
  readonly map: TrackMap;
  readonly referenceLap: ReferenceLap;
  readonly detected: readonly DetectedCorner[];
  readonly corners: readonly Corner[];
  readonly diagnostics: {
    readonly frames: number;
    readonly lapTimeS: number;
    readonly coverage: number;
    readonly lengthM: number;
    readonly closureErrorM: number;
    readonly pathLengthM: number;
    readonly yawSign: 1 | -1;
    readonly orientationAgreement: number;
    readonly warnings: readonly string[];
  };
}

export class TrackMapBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrackMapBuildError";
  }
}

/** Read an NDJSON recording into frames, ignoring the header line. */
export async function readFrames(path: string): Promise<TelemetryFrame[]> {
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  const frames: TelemetryFrame[] = [];
  try {
    for await (const line of lines) {
      if (line.trim() === "") continue;
      const frame = parseFrame(line);
      if (frame !== null) frames.push(frame);
    }
  } finally {
    lines.close();
  }
  return frames;
}

/**
 * Track length from the lap's own `lapDistM` channel.
 *
 * `lapDistM / lapDistPct` is the length the sim itself implies at every sample,
 * so taking the median of that is both a measurement and a check on §4.3's
 * assumption that pct is evenly spaced in distance. Samples near the line are
 * skipped because the ratio is unstable as pct approaches zero.
 */
export function inferLengthM(frames: readonly TelemetryFrame[]): number {
  const ratios = frames
    .filter((f) => f.lapDistPct > 0.05 && f.lapDistM > 0)
    .map((f) => f.lapDistM / f.lapDistPct)
    .sort((a, b) => a - b);

  if (ratios.length === 0) {
    throw new TrackMapBuildError(
      "cannot infer track length: no sample carried lapDistM. Pass --length, or use a " +
        "recording made after that channel was added.",
    );
  }
  return ratios[Math.floor(ratios.length / 2)]!;
}

export function buildTrackMap(frames: readonly TelemetryFrame[], options: BuildOptions): BuildResult {
  // Corner direction is derived from the steering sign, so refuse to emit a map
  // if that has not been measured — a map with every direction possibly inverted
  // is worse than no map, because it looks fine (§5, §12).
  assertSteeringSignMeasured();

  if (frames.length < 2) {
    throw new TrackMapBuildError(`recording has ${frames.length} frames — not a lap`);
  }

  const gridSize = options.gridSize ?? 2000;
  const lengthM = metres(options.lengthM ?? inferLengthM(frames));

  const { lap, coverage, warnings } = resampleLap(frames, gridSize, lengthM);

  const centreline = buildCentreline(frames, gridSize, lengthM, {
    steerSignRight: STEER_SIGN_RIGHT,
  });

  const detected = detectCorners(lap, { steerSignRight: STEER_SIGN_RIGHT });
  const overrides = options.overrides ?? CornerOverridesSchema.parse({ schema: 1, operations: [] });
  const corners = applyOverrides(detected, overrides, lap);

  if (corners.length === 0) {
    throw new TrackMapBuildError(
      "no corners survived detection and overrides — refusing to write an empty map",
    );
  }

  const map: TrackMap = {
    schema: 1,
    trackRef: options.trackRef,
    trackName: options.trackName,
    configName: options.configName,
    lengthM,
    generatedFrom: {
      source: "telemetry",
      baselineCarId: options.carId,
      lapHash: hashLap(frames),
    },
    corners: corners.map((c) => ({ ...c })),
    centreline: centreline.centreline,
  };

  const perCorner: Record<string, ReturnType<typeof perCornerMetrics>> = {};
  for (const corner of corners) {
    perCorner[String(corner.index)] = perCornerMetrics(lap, corner, lengthM);
  }

  const referenceLap: ReferenceLap = {
    // TrackKey, not TrackRef — re-cutting the map must not invalidate this (§4.0).
    trackKey: {
      sim: options.trackRef.sim,
      trackId: options.trackRef.trackId,
      configId: options.trackRef.configId,
    },
    carId: options.carId,
    lapTimeS: lap.lapTimeS,
    gridSize,
    channels: {
      speedMps: [...lap.speedMps],
      throttle: [...lap.throttle],
      brake: [...lap.brake],
      gear: [...lap.gear],
      steerRad: [...lap.steerRad],
      elapsedS: [...lap.elapsedS],
    },
    derivedForMapVersion: options.trackRef.mapVersion,
    perCorner,
    brakeChannelInferred: false,
  };

  return {
    map,
    referenceLap,
    detected,
    corners,
    diagnostics: {
      frames: frames.length,
      lapTimeS: lap.lapTimeS,
      coverage,
      lengthM,
      closureErrorM: centreline.closureErrorM,
      pathLengthM: centreline.pathLengthM,
      yawSign: centreline.yawSign,
      orientationAgreement: centreline.orientationAgreement,
      warnings,
    },
  };
}

/**
 * Identifies the lap a map was cut from (§4.1's `generatedFrom.lapHash`).
 *
 * Over the driven channels rather than the whole file, so re-extracting the same
 * lap from a recording — which rebases `tMs` — still hashes the same.
 */
function hashLap(frames: readonly TelemetryFrame[]): string {
  const h = createHash("sha256");
  for (const f of frames) {
    h.update(`${f.lapDistPct.toFixed(6)},${f.speedMps.toFixed(3)},${f.steerRad.toFixed(4)};`);
  }
  return `sha256:${h.digest("hex")}`;
}
