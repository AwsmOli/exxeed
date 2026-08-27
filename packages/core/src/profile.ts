/**
 * Per-driver preferences — SPEC.md §6.1.
 *
 * This is one half of a deliberately split pair, and the split matters:
 *
 *   note.leadAdjustS     the AUTHOR saying "this note is mistimed". Ships inside
 *                        the note set, applies for everyone who loads it.
 *   profile.leadAdjustS  ONE DRIVER saying "I like more warning than most".
 *                        Never leaves their machine.
 *
 * They add. Conflating them means one person's preference gets baked into a note
 * set that other people then download.
 *
 * Persisted under /data/profile/ by the repository layer — not from here, since
 * core does no I/O.
 */

export interface DriverProfile {
  /**
   * Seconds added to every callout's lead, positive for earlier.
   *
   * In SECONDS, not metres. "It's a little late" is a complaint about reaction
   * time, and reaction time has to scale with speed the same way the rest of the
   * lead does. A metre offset would be right at one speed and wrong everywhere
   * else.
   */
  readonly leadAdjustS: number;
}

export const DEFAULT_PROFILE: DriverProfile = { leadAdjustS: 0 };
