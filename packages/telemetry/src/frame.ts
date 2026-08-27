/**
 * The telemetry frame — one 60 Hz sample, and the only shape the rest of the app
 * sees of the sim.
 *
 * SI throughout (SPEC.md §3): metres, metres/second, radians, seconds. Nothing
 * here is ever kph. The branded units make that a compile error rather than a
 * convention; the adapters are the I/O boundary where the constructors are
 * allowed to be called.
 */

import type { Mps, Pct, Radians, Seconds } from "@exxeed/core";

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
   * Recorded from M0a onward specifically so the centreline comes free from laps
   * you already drove, rather than needing a second driving session at M1.
   */
  readonly lat: number;
  readonly lon: number;

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
