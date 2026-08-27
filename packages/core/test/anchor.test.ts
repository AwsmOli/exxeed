import { describe, expect, it } from "vitest";

import type { Note } from "@exxeed/core";
import { cornerByIndex, indexLandmarks, resolveEventPct, resolveNotes } from "@exxeed/core";

import { spaGt3Notes, spaLandmarks, spaMap } from "./fixtures.js";

const landmarks = indexLandmarks(spaLandmarks);
const brakeNote = spaGt3Notes.notes[0]!;
const throttleNote = spaGt3Notes.notes[1]!;

describe("resolveEventPct", () => {
  it("resolves a landmark anchor to the landmark's own position", () => {
    expect(resolveEventPct(brakeNote, spaMap, landmarks)).toBeCloseTo(0.99781, 6);
  });

  it("resolves a corner anchor through the phase table", () => {
    // phase "throttle" aims at the apex (SPEC.md §4.7).
    expect(resolveEventPct(throttleNote, spaMap, landmarks)).toBeCloseTo(0.018, 6);
  });

  it("applies a landmark offset across start/finish without wrapping negative", () => {
    // Pull the braking point 200 m earlier: 0.99781 - 0.02855 = 0.96926.
    const earlier: Note = {
      ...brakeNote,
      anchor: { type: "landmark", id: "t1_board_100", offsetM: -200 },
    };
    const resolved = resolveEventPct(earlier, spaMap, landmarks);
    expect(resolved).not.toBeNull();
    expect(resolved!).toBeGreaterThan(0);
    expect(resolved!).toBeCloseTo(0.969255, 6);

    // Push it 200 m later: past start/finish, so it must land just above 0.
    const later: Note = {
      ...brakeNote,
      anchor: { type: "landmark", id: "t1_board_100", offsetM: 200 },
    };
    const wrapped = resolveEventPct(later, spaMap, landmarks);
    expect(wrapped).not.toBeNull();
    expect(wrapped!).toBeGreaterThan(0);
    expect(wrapped!).toBeLessThan(0.05);
    expect(wrapped!).toBeCloseTo(0.02637, 5);
  });

  it("returns null for an unknown landmark rather than throwing at 60 Hz", () => {
    const orphan: Note = {
      ...brakeNote,
      anchor: { type: "landmark", id: "t1_board_nope", offsetM: 0 },
    };
    expect(resolveEventPct(orphan, spaMap, landmarks)).toBeNull();
  });

  it("returns null for a corner index that isn't in this map version", () => {
    const stale: Note = { ...throttleNote, anchor: { type: "corner", cornerIndex: 42, offsetM: 0 } };
    expect(resolveEventPct(stale, spaMap, landmarks)).toBeNull();
  });
});

describe("cornerByIndex", () => {
  it("looks up by the corner's index field, not its array position", () => {
    // SPEC.md §4.7's listing indexes the array directly. Corner indices are
    // 1-based and a corners.override.json can renumber them (§5.2), so position
    // and index are not interchangeable — corner 1 lives at corners[0].
    expect(cornerByIndex(spaMap, 1)?.names).toEqual(["La Source"]);
    expect(cornerByIndex(spaMap, 2)?.names).toEqual(["Eau Rouge", "Raidillon"]);
    expect(cornerByIndex(spaMap, 0)).toBeUndefined();
    expect(spaMap.corners[1]?.index).toBe(2);
  });
});

describe("resolveNotes", () => {
  it("splits resolvable from unresolvable instead of silently dropping", () => {
    const orphan: Note = {
      ...brakeNote,
      id: "orphan",
      anchor: { type: "landmark", id: "missing", offsetM: 0 },
    };
    const result = resolveNotes([...spaGt3Notes.notes, orphan], spaMap, landmarks);

    expect(result.resolved).toHaveLength(2);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]?.id).toBe("orphan");
  });
});
