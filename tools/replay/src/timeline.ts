/**
 * The §9 timeline format.
 *
 *   lap  3  pct 0.9812  spd 241kph  FIRE t1_brake     lead 117m  dAhead 116m
 *   lap  3  pct 0.0203  spd  98kph  DROP t1_line      reason: no_fit_after_short
 *
 * Deliberately fixed-width and deterministic: these lines are what golden-file
 * tests diff against, so any change to the trigger math that moves a fire point
 * shows up as a one-line change rather than a re-read of the whole engine.
 */

import type { EngineEvent } from "@exxeed/core";
import { toKph } from "@exxeed/core";

const pad = (s: string | number, width: number): string => String(s).padStart(width);
const padEnd = (s: string, width: number): string => s.padEnd(width);

export function formatEvent(event: EngineEvent, lap: number): string {
  const prefix =
    `lap ${pad(lap, 2)}  pct ${event.atPct.toFixed(4)}  ` +
    `spd ${pad(toKph(event.speedMps).toFixed(0), 3)}kph  `;

  if (event.kind === "play") {
    // The variant matters: a short-form callout means the full one no longer fit,
    // which is a timing signal in itself.
    const label = event.variant === "full" ? "FIRE" : "SHORT";
    return (
      `${prefix}${padEnd(label, 5)} ${padEnd(event.noteId, 16)}` +
      ` lead ${pad(event.leadM.toFixed(0), 4)}m  dAhead ${pad(event.dAheadM.toFixed(0), 4)}m`
    );
  }

  return (
    `${prefix}${padEnd("DROP", 5)} ${padEnd(event.noteId, 16)}` +
    ` reason: ${event.reason}`
  );
}
