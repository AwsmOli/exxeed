import { describe, expect, it } from "vitest";

import type { Note, NoteSet } from "@exxeed/core";
import { describeDiff, diffNoteSets, isEmptyDiff } from "@exxeed/core";

import { SPA_LENGTH_M, spaGt3Notes } from "./fixtures.js";

const withNotes = (notes: Note[]): NoteSet => ({ ...spaGt3Notes, notes });
const [brake, throttle] = spaGt3Notes.notes as [Note, Note];

describe("diffNoteSets", () => {
  it("finds nothing between a set and itself", () => {
    const d = diffNoteSets(spaGt3Notes, spaGt3Notes);
    expect(isEmptyDiff(d)).toBe(true);
    expect(describeDiff(d)).toEqual([]);
  });

  it("matches notes by id, so a rewrite is a rewording and not a remove plus an add", () => {
    const after = withNotes([{ ...brake, text: "Brake at the marker board" }, throttle]);
    const d = diffNoteSets(spaGt3Notes, after);
    expect(d.reworded).toEqual([{ id: "t1_brake", from: "Brake at the hundred board", to: "Brake at the marker board" }]);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  it("counts a short-form change as a rewording too — it is heard", () => {
    const after = withNotes([{ ...brake, textShort: "Board" }, throttle]);
    expect(diffNoteSets(spaGt3Notes, after).reworded).toHaveLength(1);
  });

  it("reports moves in metres along the track, across start/finish", () => {
    // t1_brake sits at 0.99781, behind the line. 30 m later crosses it.
    const later = (brake.pct + 30 / SPA_LENGTH_M) % 1;
    const after = withNotes([{ ...brake, pct: later }, throttle]);
    const d = diffNoteSets(spaGt3Notes, after);
    expect(d.moved).toEqual([{ id: "t1_brake", text: brake.text, metres: 30 }]);
    expect(describeDiff(d)).toEqual(['Moved "Brake at the hundred board" 30 m later']);
  });

  it("ignores a move too small to hear", () => {
    const after = withNotes([{ ...brake, pct: brake.pct + 0.1 / SPA_LENGTH_M }, throttle]);
    expect(diffNoteSets(spaGt3Notes, after).moved).toEqual([]);
  });

  it("lists added and removed notes", () => {
    const added: Note = { ...throttle, id: "abc123", text: "Stay flat through Eau Rouge" };
    const d = diffNoteSets(spaGt3Notes, withNotes([brake, added]));
    expect(d.added).toEqual([{ id: "abc123", text: "Stay flat through Eau Rouge" }]);
    expect(d.removed).toEqual([{ id: "t1_throttle", text: "Kerb — throttle" }]);
    expect(describeDiff(d)).toEqual(['Added "Stay flat through Eau Rouge"', 'Removed "Kerb — throttle"']);
  });
});
