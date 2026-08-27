/**
 * The sim adapter interface — SPEC.md §2.
 *
 * v1 is iRacing only, but the interface exists so a second sim is an added
 * implementation rather than a rewrite. Everything downstream — the note engine,
 * the recorder, the replay harness, the overlays — consumes `TelemetryFrame`s
 * from here and knows nothing about iRacing.
 */

import type { TelemetryFrame } from "./frame.js";

/**
 * Which track and which car — SPEC.md §9.
 *
 * A recording is only worth keeping if you can tell later what it is of. The
 * ids come from the sim's own stable identifiers (iRacing's `TrackName` and
 * `CarPath`) rather than the display names, because display names get
 * re-branded between seasons and these do not.
 */
export interface SessionIdentity {
  /** Filesystem-safe, stable, e.g. "daytona-2011-road". */
  readonly trackId: string;
  /** Human-facing, e.g. "Daytona International Speedway". */
  readonly trackName: string;
  /** Layout within the track, e.g. "Road Course". Empty when there is only one. */
  readonly trackConfig: string;
  /** Filesystem-safe, stable, e.g. "mx5-mx52016". */
  readonly carId: string;
  /** Human-facing, e.g. "Mazda MX-5 Cup". */
  readonly carName: string;
}

/** Lowercase, filesystem- and URL-safe. Used for the directory a recording lands in. */
export function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface TelemetrySource extends AsyncIterable<TelemetryFrame> {
  /** For logs and the dev overlay, e.g. "iracing" or "replay:okayama-3laps". */
  readonly name: string;

  /** True once the sim is actually producing frames. */
  readonly connected: boolean;

  /**
   * Track and car for this session, once `connect()` has resolved. Null when the
   * source cannot say — the sim had no session data yet, or the recording being
   * replayed predates this being written into the header.
   *
   * Never block recording on this: an unlabelled lap is worth more than no lap.
   */
  readonly identity: SessionIdentity | null;

  /** Resolves when the source is ready. Throws if the platform can't support it
   *  — see IRacingAdapter off Windows. */
  connect(): Promise<void>;

  close(): Promise<void>;
}

/** Thrown when a source cannot run on this machine at all, as opposed to the sim
 *  merely not being open yet. Callers should fall back rather than retry. */
export class UnsupportedPlatformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedPlatformError";
  }
}
