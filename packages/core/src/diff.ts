/**
 * What changed between two versions of a note set — TODO.md M8 step 3b.
 *
 * Exact, not guessed: note ids are opaque handles that survive a move and a
 * rewrite (note-id.ts), so two versions line up by id with no matching
 * heuristics. The changelog shown to installers is this, plus the author's
 * one line.
 */

import type { NoteSet } from "./schema.js";
import { deltaM } from "./pct.js";
import { metres, pct } from "./units.js";

export interface NoteSetDiff {
  /** Ids and text of notes only in the newer version. */
  readonly added: readonly { readonly id: string; readonly text: string }[];
  readonly removed: readonly { readonly id: string; readonly text: string }[];
  /** Full or short text changed. */
  readonly reworded: readonly { readonly id: string; readonly from: string; readonly to: string }[];
  /** Moved along the track: positive is later in the lap, wrap-safe. */
  readonly moved: readonly { readonly id: string; readonly text: string; readonly metres: number }[];
}

/**
 * Below this a move is noise — a drag that ended where it started, or float
 * dust — and not worth telling anyone about.
 */
const MIN_MOVE_M = 0.5;

export function diffNoteSets(before: NoteSet, after: NoteSet): NoteSetDiff {
  const old = new Map(before.notes.map((n) => [n.id, n]));
  const next = new Map(after.notes.map((n) => [n.id, n]));
  const lengthM = metres(after.lengthM);

  const added: NoteSetDiff["added"][number][] = [];
  const reworded: NoteSetDiff["reworded"][number][] = [];
  const moved: NoteSetDiff["moved"][number][] = [];

  for (const note of after.notes) {
    const was = old.get(note.id);
    if (was === undefined) {
      added.push({ id: note.id, text: note.text });
      continue;
    }
    if (was.text !== note.text || was.textShort !== note.textShort) {
      reworded.push({ id: note.id, from: was.text, to: note.text });
    }
    const by = deltaM(pct(note.pct), pct(was.pct), lengthM);
    if (Math.abs(by) >= MIN_MOVE_M) {
      moved.push({ id: note.id, text: note.text, metres: Math.round(by) });
    }
  }

  const removed = before.notes
    .filter((n) => !next.has(n.id))
    .map((n) => ({ id: n.id, text: n.text }));

  return { added, removed, reworded, moved };
}

export const isEmptyDiff = (d: NoteSetDiff): boolean =>
  d.added.length === 0 && d.removed.length === 0 && d.reworded.length === 0 && d.moved.length === 0;

/** One line per change, for the update prompt and the changelog tab. */
export function describeDiff(d: NoteSetDiff): string[] {
  const quote = (text: string): string => `"${text.length > 60 ? `${text.slice(0, 57)}…` : text}"`;
  return [
    ...d.added.map((n) => `Added ${quote(n.text)}`),
    ...d.removed.map((n) => `Removed ${quote(n.text)}`),
    ...d.reworded.map((n) => `Reworded ${quote(n.from)} → ${quote(n.to)}`),
    ...d.moved.map((n) => `Moved ${quote(n.text)} ${Math.abs(n.metres)} m ${n.metres > 0 ? "later" : "earlier"}`),
  ];
}
