/**
 * The telemetry frame — one 60 Hz sample, and the only shape the rest of the app
 * sees of the sim.
 *
 * SI throughout (SPEC.md §3): metres, metres/second, radians, seconds. Nothing
 * here is ever kph. The branded units make that a compile error rather than a
 * convention; the adapters are the I/O boundary where the constructors are
 * allowed to be called.
 */

import type { Metres, Mps, Pct, Radians, Seconds } from "@exxeed/core";

/**
 * `irsdk_TrkLoc` — SPEC.md §6.4.
 *
 * The misspelling of "Approaching" is the SDK's own. Match it exactly rather than
 * tidying it up, or the next person to grep the SDK header won't find this.
 */
export const TRK_LOC = {
  NotInWorld: -1,
  OffTrack: 0,
  InPitStall: 1,
  AproachingPits: 2,
  OnTrack: 3,
} as const;

export type TrkLoc = (typeof TRK_LOC)[keyof typeof TRK_LOC];

export const isTrkLoc = (n: number): n is TrkLoc =>
  n === -1 || n === 0 || n === 1 || n === 2 || n === 3;

export interface TelemetryFrame {
  /** Milliseconds since the recording started. Monotonic, and the clock the
   *  replay harness drives from — not wall time. */
  readonly tMs: number;
  readonly sessionTimeS: Seconds;
  readonly lap: number;

  /**
   * Lap position, 0..1.
   *
   * The iRacing SDK reports `LapDistPct` with a unit string of `"%"` but the
   * value is genuinely 0..1. Do NOT "fix" this by dividing by 100 (SPEC.md §3).
   */
  readonly lapDistPct: Pct;

  readonly speedMps: Mps;
  /** 0..1. */
  readonly throttle: number;
  /** 0..1. */
  readonly brake: number;
  /** −1 reverse, 0 neutral, 1..n. */
  readonly gear: number;
  /** Radians. Which sign means left is NOT assumed — see steering.ts and §5. */
  readonly steerRad: Radians;

  /**
   * Degrees, straight off the SDK. Projected to a local planar frame during map
   * generation (§4.1.1), not here.
   *
   * **M0b finding: iRacing does not expose these.** `Lat` and `Lon` are not
   * merely zero, they are absent from the telemetry variable list entirely, so
   * §4.1.1's primary centreline path does not exist. Kept in the frame because
   * another sim may populate them and old recordings carry the field, but the
   * centreline has to come from dead reckoning — see the motion channels below.
   */
  readonly lat: number;
  readonly lon: number;

  /**
   * Velocity in the car's own frame, m/s: X forward, Y lateral. With
   * `yawNorthRad` these are what §4.1.1's dead-reckoning fallback integrates,
   * and since `Lat`/`Lon` turned out to be absent, that fallback is the only
   * centreline path there is.
   *
   * Dead reckoning accumulates drift and needs a closure correction at
   * start/finish (§4.1.1) — that correction is M1's problem, but it cannot be
   * done at all unless these are in the recording, which is why they are here
   * before the M1 lap gets driven rather than after.
   */
  readonly velocityXMps: Mps;
  readonly velocityYMps: Mps;

  /** Heading relative to north, radians. The frame the velocities rotate into. */
  readonly yawNorthRad: Radians;

  /**
   * Distance travelled along the lap, metres — the SDK's own `LapDist`.
   *
   * Redundant with `lapDistPct × lengthM`, and that is the point: it gives the
   * true track length off a recording without trusting a session-info field, and
   * it is a direct check that the pct grid is spaced the way §4.3 assumes.
   */
  readonly lapDistM: Metres;

  // Suppression inputs — SPEC.md §6.4. All of them, from the first recording, so
  // a lap recorded today can still be replayed against the engine at M2.
  readonly isOnTrack: boolean;
  readonly onPitRoad: boolean;
  readonly isInGarage: boolean;
  readonly playerTrackSurface: TrkLoc;
  readonly playerCarTowTime: number;
  readonly enterExitReset: number;
}

// The crawling threshold from §6.4 lives in @exxeed/core alongside the rest of
// the suppression rules — it is an engine threshold, not a property of the frame.
