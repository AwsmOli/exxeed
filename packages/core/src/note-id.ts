/**
 * Note ids — SPEC.md §4.4.
 *
 * ## Why these are meaningless on purpose
 *
 * A note is a point and a message. It is not a brake note or a throttle note,
 * and it is not "the turn 7 note" either: it can be a line about an overtaking
 * spot coming up, or about staying in fourth on the limiter up the hill because
 * shifting to fifth is slower. Ids like `t7_gas` smuggled both claims back in —
 * a corner number the note does not carry, and a category it never had.
 *
 * They were also actively wrong as handles. An id names the audio file, so it
 * has to survive the two things authors do most: moving a note, and rewriting
 * its words. `t7_gas` moved to turn 8 is a lie that still resolves; renumber the
 * corners in `corners.override.json` and every id in the set is quietly stale.
 *
 * So an id is a random handle and nothing else. It says which WAV, it stays put
 * when the note moves, and it makes no claim that can go out of date. What a
 * note is *for* is the text — the only place that can say it accurately, because
 * it is the thing a driver actually hears.
 *
 * Six base-36 characters: 2.1 billion values against note sets of a few dozen.
 * `taken` makes the collision question disappear rather than be argued about.
 */

const ID_LENGTH = 6;
const SPACE = 36 ** ID_LENGTH;

/** Matches an id this module would mint. Not a validator for stored ids — old
 *  sets carry hand-written ones, and those stay valid. */
export const NOTE_ID_PATTERN = /^[0-9a-z]{6}$/;

export function newNoteId(
  taken: ReadonlySet<string> = new Set(),
  random: () => number = Math.random,
): string {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const id = Math.floor(random() * SPACE)
      .toString(36)
      .padStart(ID_LENGTH, "0");
    if (!taken.has(id)) return id;
  }
  // Only reachable if `random` is not random — a stub in a test, say. Worth
  // saying out loud rather than returning a duplicate that overwrites a WAV.
  throw new Error("could not mint an unused note id in 1000 attempts");
}
