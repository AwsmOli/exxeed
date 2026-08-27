/**
 * Trigger timing — SPEC.md §6.1.
 *
 * The rule that shapes everything here: do NOT precompute a static trigger
 * percentage. It moves with speed. At 250 km/h (69 m/s) a 2.0 s callout plus
 * buffer has to start 207 m before its event; at 90 km/h the same callout starts
 * 75 m before it. A fixed pct would be right at exactly one speed.
 *
 * So each tick computes distance remaining to the event and compares it against
 * a lead distance derived from current speed.
 */

import type { AudioVariant, Note } from "./schema.js";
import type { DriverProfile } from "./profile.js";
import type { Metres, Mps, Seconds } from "./units.js";
import { metres, seconds } from "./units.js";

/**
 * Time between the voice stopping and the event arriving. SPEC.md §6.1.
 *
 * This is the gap the driver actually hears, so it is the number to reason about
 * when a callout feels rushed — not the clip length. Shortening the words does
 * NOT widen this gap: the lead is derived from the duration, so a shorter clip
 * simply starts later and lands in the same place. Measured at Daytona, halving
 * every clip moved the gap by 0.02-0.08 s. This constant is the only lever.
 */
export const REACTION_BUFFER_S = 1.0;

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
 * it assumes the car holds this speed for the whole callout. Whenever the car is
 * accelerating it covers more ground than this estimates and the cue lands late,
 * which is what `leadAdjustS` is for.
 *
 * That is not only true of throttle and exit cues, as this comment used to claim.
 * A brake cue fires while the car is still accelerating down the straight *at*
 * the braking point, so it is subject to the same error: measured at Daytona in
 * the MX-5, the car gains 14-15 km/h during the T4 and T7 callouts and arrives
 * 0.22 s early against a 1.0 s buffer. Those two notes carry a `leadAdjustS` to
 * absorb it. Only a corner taken at genuinely steady speed is exempt.
 */
export const leadDistanceM = (speedMps: Mps, leadS: Seconds): Metres =>
  metres(speedMps * leadS);
