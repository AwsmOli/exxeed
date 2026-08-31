import { describe, expect, it } from "vitest";

import { newNoteId, NOTE_ID_PATTERN } from "../src/note-id.js";

describe("newNoteId", () => {
  it("mints an opaque six-character handle", () => {
    expect(newNoteId()).toMatch(NOTE_ID_PATTERN);
  });

  /**
   * The point of the whole exercise: nothing about the note reaches the id, so
   * there is nothing in it to go stale when the note moves or is rewritten.
   */
  it("says nothing about position, turn or purpose", () => {
    const ids = Array.from({ length: 200 }, () => newNoteId());
    expect(ids.every((id) => NOTE_ID_PATTERN.test(id))).toBe(true);
    // A thousand notes would collide sometimes; a few hundred should not.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never returns an id already in use", () => {
    // A random source stuck on one value: without the `taken` check this
    // returns a duplicate, and rendering then overwrites another note's WAV.
    const stuck = (): number => 0.5;
    const first = newNoteId(new Set(), stuck);
    expect(() => newNoteId(new Set([first]), stuck)).toThrow(/could not mint/);
  });

  it("pads a small value rather than emitting a short id", () => {
    expect(newNoteId(new Set(), () => 0)).toBe("000000");
  });
});
