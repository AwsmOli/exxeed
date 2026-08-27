/**
 * Suppression — SPEC.md §6.4. When to say nothing at all.
 *
 * The inputs are deliberately sim-neutral booleans rather than iRacing channel
 * values: core must not depend on the telemetry package (§3), and a second sim
 * would report the same facts under different names. The adapter translates —
 * see `toTickInput` in @exxeed/telemetry.
 */

import type { Mps } from "./units.js";

/** 30 km/h, expressed in SI as everything internal is (§3, §6.4). */
export const CRAWL_SPEED_MPS = 8.3;

/**
 * How long to keep quiet after an off-track excursion ends.
 *
 * There is no clean "four wheels off" channel; `PlayerTrackSurface == OffTrack`
 * is the closest available proxy, and it flickers as the car clips kerbs. The
 * hold stops a callout firing the instant a wheel comes back on.
 */
export const OFF_TRACK_HOLD_S = 2;

export interface SuppressionInput {
  readonly tMs: number;
  readonly speedMps: Mps;
  /** Lap number from the sim. Used only for the out-lap gate. */
  readonly lap: number;
  /** iRacing `IsOnTrack`. */
  readonly onTrack: boolean;
  /** iRacing `OnPitRoad`. */
  readonly inPitLane: boolean;
  /** iRacing `IsInGarage`. */
  readonly inGarage: boolean;
  /** iRacing `PlayerTrackSurface == OffTrack`. */
  readonly offTrack: boolean;
  /** iRacing `PlayerCarTowTime`, seconds. Non-zero means being recovered. */
  readonly towTimeS: number;
  /** iRacing `EnterExitReset`. Any change means the car was reset to the pits. */
  readonly resetCounter: number;
}

export type SuppressionReason =
  | "not_on_track"
  | "pit_lane"
  | "garage"
  | "off_track"
  | "off_track_hold"
  | "towing"
  | "reset"
  | "crawling"
  | "out_lap";

export interface SuppressionOptions {
  /**
   * Treat the out-lap as already served.
   *
   * For replaying a recording that starts mid-session — most obviously a single
   * extracted lap, where the gate would otherwise hold from the first frame to
   * the last and the engine would look broken while behaving exactly as
   * specified. §9's argument applies: waiting a full lap of real time before
   * hearing anything is the same friction as needing to drive to iterate.
   *
   * Never set this for a live session. The gate is there because a driver leaving
   * the pits has not yet seen the lap they are about to be talked through.
   */
  readonly assumeLapComplete?: boolean;
}

/**
 * Stateful because three of the rules are: the reset counter needs its previous
 * value, the off-track hold needs a deadline, and the out-lap gate needs to know
 * which lap the driver came out on.
 */
export class SuppressionGate {
  #lastResetCounter: number | null = null;
  #offTrackHoldUntilMs: number | null = null;
  #outLapUntilLap: number | null = null;
  readonly #assumeLapComplete: boolean;

  constructor(options: SuppressionOptions = {}) {
    this.#assumeLapComplete = options.assumeLapComplete ?? false;
  }

  /** The reason to stay quiet, or null to speak. */
  evaluate(input: SuppressionInput): SuppressionReason | null {
    const reset = this.#checkReset(input);

    // Leaving the track resets the out-lap gate: after a tow or a reset to pits
    // the driver is on an out-lap again whether or not the sim says so.
    if (!input.onTrack || input.inGarage || reset) {
      this.#outLapUntilLap = null;
    } else if (this.#outLapUntilLap === null) {
      // First tick back on track — require one completed lap before arming
      // anything (§6.4), unless the caller has said this recording starts
      // mid-session.
      this.#outLapUntilLap = this.#assumeLapComplete ? input.lap : input.lap + 1;
    }

    if (input.offTrack) {
      this.#offTrackHoldUntilMs = input.tMs + OFF_TRACK_HOLD_S * 1000;
    }

    if (!input.onTrack) return "not_on_track";
    if (input.inGarage) return "garage";
    if (input.inPitLane) return "pit_lane";
    if (reset) return "reset";
    if (input.towTimeS > 0) return "towing";
    if (input.offTrack) return "off_track";
    if (this.#offTrackHoldUntilMs !== null && input.tMs < this.#offTrackHoldUntilMs) {
      return "off_track_hold";
    }
    if (input.speedMps < CRAWL_SPEED_MPS) return "crawling";
    if (this.#outLapUntilLap !== null && input.lap < this.#outLapUntilLap) return "out_lap";

    return null;
  }

  #checkReset(input: SuppressionInput): boolean {
    const previous = this.#lastResetCounter;
    this.#lastResetCounter = input.resetCounter;
    return previous !== null && previous !== input.resetCounter;
  }
}
