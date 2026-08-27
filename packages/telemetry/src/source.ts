/**
 * The sim adapter interface — SPEC.md §2.
 *
 * v1 is iRacing only, but the interface exists so a second sim is an added
 * implementation rather than a rewrite. Everything downstream — the note engine,
 * the recorder, the replay harness, the overlays — consumes `TelemetryFrame`s
 * from here and knows nothing about iRacing.
 */

import type { TelemetryFrame } from "./frame.js";

export interface TelemetrySource extends AsyncIterable<TelemetryFrame> {
  /** For logs and the dev overlay, e.g. "iracing" or "replay:okayama-3laps". */
  readonly name: string;

  /** True once the sim is actually producing frames. */
  readonly connected: boolean;

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
