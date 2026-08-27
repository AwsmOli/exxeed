/**
 * Trigger timing — SPEC.md §6.1.
 *
 * The rule that shapes everything here: do NOT precompute a static trigger
 * percentage. It moves with speed. At 250 km/h (69 m/s) a 2.0 s callout plus
 * buffer has to start 173 m before its event; at 90 km/h the same callout starts
 * 62 m before it. A fixed pct would be right at exactly one speed.
 *
 * So each tick computes distance remaining to the event and compares it against
 * a lead distance derived from current speed.
 */

import type { AudioVariant, Note } from "./schema.js";
import type { DriverProfile } from "./profile.js";
import type { Metres, Mps, Seconds } from "./units.js";
import { metres, seconds } from "./units.js";

/** Time to let the driver react after the voice stops. SPEC.md §6.1. */
export const REACTION_BUFFER_S = 0.5;

/**
 * Smallest gap allowed between a callout finishing and its event arriving.
 * Adjustments can be negative, and without this floor a large enough negative
 * adjustment would schedule the voice to still be talking after the braking
 * point has passed.
 */
export const MIN_TAIL_S = 0.1;

/**
 * Single source of truth for lead time. The scheduler (§6.3) calls this too, with
 * the short variant, which is why it takes the variant rather than reading
 * `note.audio` itself — the short-form fallback needs the same arithmetic over a
 * different duration.
 */
export function leadSecondsFor(
  note: Note,
  variant: AudioVariant,
  profile: DriverProfile,
): Seconds {
  const durationS = variant.durationMs / 1000;

  const raw =
    durationS +
    REACTION_BUFFER_S +
    // Author's fix, travels with the note set.
    note.leadAdjustS +
    // This driver's preference, stays on this machine.
    profile.leadAdjustS;

  // Never let adjustments push the callout to finish after its own event.
  return seconds(Math.max(raw, durationS + MIN_TAIL_S));
}

/**
 * How far before the event the callout has to start, at the current speed.
 *
 * This is the constant-speed approximation the note editor corrects for (§7.4):
 * it assumes the car holds this speed for the whole callout. Near enough for a
 * brake cue, where speed is steady right up to the braking point. For a throttle
 * or exit cue the car is accelerating, covers more ground than this estimates,
 * and the cue lands late — which is what `leadAdjustS` is for.
 */
export const leadDistanceM = (speedMps: Mps, leadS: Seconds): Metres =>
  metres(speedMps * leadS);
