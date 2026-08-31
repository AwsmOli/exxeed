/**
 * The car registry — which car is which, and which class it belongs to.
 *
 * SPEC.md §13 Q2. Three car identifiers existed and none of them mapped to the
 * others: the sim reports a slug (`SessionIdentity.carId`, e.g. "mx5-mx52016"),
 * a `ReferenceLap` was keyed by a hand-typed integer, and a `NoteSet` names a
 * free-text `carClass`. Reference laps are now keyed by the sim's own slug, so
 * the car being driven finds its lap with no lookup at all. This table is what
 * is left: **slug to class**, the one mapping that genuinely needs a human,
 * because no amount of string handling decides whether a Porsche 992 GT3 R and a
 * Ferrari 296 GT3 are the same class for callout purposes.
 *
 * That is also the answer to §13's granularity question: it is data, not code.
 * Split "gt3" into "gt3-porsche" by editing this file, and nothing recompiles.
 *
 * ## Why the class matters at all
 *
 * §1: "A GT3 brakes at the 100 board where an LMP2 brakes at the 50 and an MX-5
 * at the 150." A note set carrying the wrong class is not a cosmetic mismatch,
 * it is wrong braking points delivered confidently. The registry exists so that
 * can be *noticed*, which it previously could not be — `listForTrack`'s
 * `carClass` filter had no caller outside its own tests.
 *
 * An unknown car is not an error. New cars appear constantly and a driver in one
 * should still get callouts; they simply lose the class check, and are told so.
 */

import { z } from "zod";

export const CarEntrySchema = z.object({
  /** The class a note set would name, e.g. "mx5", "gt3". */
  class: z.string().min(1),
  /** Human-facing, for warnings a driver has to make sense of mid-session. */
  name: z.string().min(1),
});

export const CarRegistrySchema = z.object({
  schema: z.literal(1),
  sim: z.string().min(1),
  /** Keyed by the sim's own car slug. */
  cars: z.record(z.string(), CarEntrySchema),
});

export type CarEntry = z.infer<typeof CarEntrySchema>;
export type CarRegistry = z.infer<typeof CarRegistrySchema>;

/** The registry entry for a car, or null when the car is not in the table. */
export const carEntry = (registry: CarRegistry | null, carId: string): CarEntry | null =>
  registry?.cars[carId] ?? null;

/** The class a car belongs to, or null when it is not in the table. */
export const classOf = (registry: CarRegistry | null, carId: string): string | null =>
  carEntry(registry, carId)?.class ?? null;

export type ClassMatch =
  /** The car is in the table and its class is the one the note set names. */
  | { readonly kind: "match"; readonly carClass: string }
  /** The car is in the table and its class is NOT the one the note set names. */
  | { readonly kind: "mismatch"; readonly carClass: string; readonly expected: string }
  /** No registry, or a car not in it. Nothing can be said either way. */
  | { readonly kind: "unknown" };

/**
 * Whether a note set suits the car being driven.
 *
 * Deliberately three-valued. Collapsing "unknown" into "mismatch" would warn
 * every time someone drives a car nobody has added yet, and a warning that fires
 * when nothing is wrong stops being read — which costs more than the check buys.
 */
export function matchesClass(
  registry: CarRegistry | null,
  carId: string | null,
  noteSetClass: string,
): ClassMatch {
  if (carId === null) return { kind: "unknown" };
  const actual = classOf(registry, carId);
  if (actual === null) return { kind: "unknown" };
  return actual === noteSetClass
    ? { kind: "match", carClass: actual }
    : { kind: "mismatch", carClass: actual, expected: noteSetClass };
}
