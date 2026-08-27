/**
 * Resolving a note's anchor to the lap position its callout is aimed at —
 * SPEC.md §4.7.
 *
 * Note on a deviation from the spec listing: §4.7 writes the corner branch as
 * `map.corners[note.anchor.cornerIndex]`, which indexes the array by POSITION.
 * Corner indices are 1-based and can be renumbered by a `corners.override.json`
 * that inserts or merges corners (§5.2), so array position and corner index are
 * not the same thing. Look up by the `index` field instead — see `cornerByIndex`.
 */

import { offsetPct, wrapPct } from "./pct.js";
import type { Corner, Landmark, LandmarkInventory, Note, Phase, TrackMap } from "./schema.js";
import type { Metres, Pct } from "./units.js";
import { metres, pct } from "./units.js";

/** Which point of a corner each phase aims at (SPEC.md §4.7). */
export const PHASE_PCT: Readonly<Record<Phase, (c: Corner) => Pct>> = {
  approach: (c) => pct(c.entryPct),
  brake: (c) => pct(c.entryPct),
  turn_in: (c) => pct(c.entryPct),
  apex: (c) => pct(c.apexPct),
  throttle: (c) => pct(c.apexPct),
  exit: (c) => pct(c.exitPct),
  line: (c) => pct(c.exitPct),
};

export type LandmarkIndex = ReadonlyMap<string, Landmark>;

export const indexLandmarks = (inventory: LandmarkInventory): LandmarkIndex =>
  new Map(inventory.landmarks.map((lm) => [lm.id, lm]));

/** Corner lookup by its `index` field, not by array position. */
export const cornerByIndex = (map: TrackMap, index: number): Corner | undefined =>
  map.corners.find((c) => c.index === index);

/**
 * The lap position a note's callout is aimed at, or `null` when the anchor cannot
 * be resolved — a landmark id that isn't in the inventory, or a corner index from
 * a note set cut against a different `mapVersion` (§4.0).
 *
 * Resolve every note once at load time and drop the unresolvable ones there. The
 * runtime does no work at 60 Hz that could have been done at load time (§1), and
 * a note that fails to resolve is a data problem, not a per-tick condition.
 */
export function resolveEventPct(
  note: Note,
  map: TrackMap,
  landmarks: LandmarkIndex,
): Pct | null {
  const lengthM = metres(map.lengthM);

  if (note.anchor.type === "landmark") {
    const lm = landmarks.get(note.anchor.id);
    if (lm === undefined) return null;
    return offsetPct(pct(lm.pct), metres(note.anchor.offsetM), lengthM);
  }

  const corner = cornerByIndex(map, note.anchor.cornerIndex);
  if (corner === undefined) return null;
  const base = PHASE_PCT[note.phase](corner);
  return note.anchor.offsetM === 0
    ? base
    : offsetPct(base, metres(note.anchor.offsetM), lengthM);
}

export interface ResolvedNote {
  readonly note: Note;
  readonly eventPct: Pct;
}

export interface ResolveResult {
  readonly resolved: readonly ResolvedNote[];
  /** Notes whose anchor could not be resolved. Surface these in the editor's flag
   *  queue (§7.4) rather than swallowing them. */
  readonly unresolved: readonly Note[];
}

export function resolveNotes(
  notes: readonly Note[],
  map: TrackMap,
  landmarks: LandmarkIndex,
): ResolveResult {
  const resolved: ResolvedNote[] = [];
  const unresolved: Note[] = [];

  for (const note of notes) {
    const eventPct = resolveEventPct(note, map, landmarks);
    if (eventPct === null) unresolved.push(note);
    else resolved.push({ note, eventPct });
  }

  return { resolved, unresolved };
}

/** Track length as branded metres. Convenience so callers stop re-wrapping it. */
export const trackLength = (map: TrackMap): Metres => metres(map.lengthM);

/** Re-export for callers building anchors by hand in tests and the editor. */
export { wrapPct };
