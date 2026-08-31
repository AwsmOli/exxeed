import { describe, expect, it } from "vitest";

import type { ImportProfile, TrackMap } from "@exxeed/core";
import { ImportProfileSchema, NOTE_ID_PATTERN, resolveProfile } from "@exxeed/core";

import { spaMap } from "./fixtures.js";

/** A map numbered the way a coach would number it — four turns. */
const map: TrackMap = {
  ...spaMap,
  lengthM: 5687.29,
  corners: [
    { index: 1, names: [], entryPct: 0.05, apexPct: 0.06, exitPct: 0.07, direction: "left", severity: 4 },
    { index: 2, names: [], entryPct: 0.14, apexPct: 0.15, exitPct: 0.16, direction: "right", severity: 5 },
    { index: 3, names: [], entryPct: 0.30, apexPct: 0.31, exitPct: 0.32, direction: "left", severity: 2 },
    { index: 4, names: [], entryPct: 0.64, apexPct: 0.66, exitPct: 0.68, direction: "right", severity: 3 },
  ],
};

const profile = (callouts: ImportProfile["callouts"]): ImportProfile => ({
  schema: 1,
  source: { type: "youtube", videoId: "abc", channel: "Samba Racing" },
  carClass: "mx5",
  callouts,
});

describe("resolveProfile", () => {
  it("puts a callout at the turn it names, and nothing cleverer", () => {
    // Corner entry, not the reference lap's braking point. A note is a point and
    // a message: it is not a brake note, and a resolver that anchors on braking
    // is wrong for every note that is about something else — an overtaking spot,
    // a gear to stay in. The author moves it in the editor; that is the offset.
    const { notes } = resolveProfile(
      profile([{ turn: 2, text: "Turn two, brake at the lamp post", priority: 1 }]),
      map,
    );

    expect(notes).toHaveLength(1);
    expect(notes[0]!.pct).toBeCloseTo(0.14, 6);
    // The id is a handle, not a description. Nothing about the turn reaches it.
    expect(notes[0]!.id).toMatch(NOTE_ID_PATTERN);
    expect(notes[0]!.id).not.toMatch(/2/);
  });

  it("anchors a range at its first turn", () => {
    // Corners close enough together get one callout, not one each (§4.4), and
    // the sequence starts where the first of them does.
    const { notes } = resolveProfile(
      profile([{ turn: 4, throughTurn: 4, text: "Chicane, brake at the one marker", priority: 1 }]),
      map,
    );

    expect(notes[0]!.pct).toBeCloseTo(0.64, 6);
  });

  it("places a note about nothing in particular exactly like any other", () => {
    // The point of the model: this one is not about braking at all, and needs no
    // special case, because the resolver never asked what it was about.
    const { notes, warnings } = resolveProfile(
      profile([{ turn: 3, text: "Stay in fourth here, fifth is slower", priority: 2 }]),
      map,
    );

    expect(notes[0]!.pct).toBeCloseTo(0.3, 6);
    expect(warnings.join(" ")).not.toMatch(/brak/i);
  });

  it("refuses a turn the map does not have, rather than guessing", () => {
    // The failure this catches is the one that is otherwise silent: a track whose
    // corners were never renumbered to the convention, so every mapping is off.
    const { notes, unresolved } = resolveProfile(
      profile([{ turn: 9, text: "Turn nine", priority: 1 }]),
      map,
    );

    expect(notes).toHaveLength(0);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.reason).toMatch(/corners\.override\.json/);
  });

  it("rejects a backwards range", () => {
    const { unresolved } = resolveProfile(
      profile([{ turn: 4, throughTurn: 2, text: "Backwards", priority: 1 }]),
      map,
    );
    expect(unresolved[0]!.reason).toMatch(/ends before it begins/);
  });

  it("needs only a track map, so a track nobody has driven can still be imported", () => {
    // resolveProfile takes no reference lap at all. Notes can be imported for a
    // track that has a map but no recorded lap in that car — which is most of
    // them, when a backlog of guides arrives before the driving does.
    const { notes } = resolveProfile(
      profile([{ turn: 2, text: "Turn two, brake at the lamp post", priority: 1 }]),
      map,
    );

    expect(notes[0]!.pct).toBeCloseTo(0.14, 6);
  });

  it("marks everything dirty — nothing has been spoken yet", () => {
    const { notes } = resolveProfile(
      profile([{ turn: 1, text: "Turn one", priority: 1 }]),
      map,
    );
    expect(notes[0]!.dirty).toBe(true);
  });

  it("derives a short form when none was given, and flags it", () => {
    const { notes, warnings } = resolveProfile(
      profile([{ turn: 1, text: "Turn one, brake at the black seam", priority: 1 }]),
      map,
    );

    expect(notes[0]!.textShort).toBe("Turn one");
    expect(warnings.join(" ")).toMatch(/no short form/);
  });

  it("warns when two callouts land on the same turn", () => {
    const { warnings } = resolveProfile(
      profile([
        { turn: 1, text: "First thing", priority: 1 },
        { turn: 1, text: "Second thing", priority: 1 },
      ]),
      map,
    );
    expect(warnings.join(" ")).toMatch(/will collide/);
  });

  it("returns notes in track order", () => {
    const { notes } = resolveProfile(
      profile([
        { turn: 4, text: "Last", priority: 1 },
        { turn: 1, text: "First", priority: 1 },
        { turn: 2, text: "Middle", priority: 1 },
      ]),
      map,
    );
    expect(notes.map((n) => n.text)).toEqual(["First", "Middle", "Last"]);
  });
});

describe("ImportProfileSchema", () => {
  it("rejects a profile with no schema version", () => {
    expect(() => ImportProfileSchema.parse({ source: {}, carClass: "mx5", callouts: [] })).toThrow();
  });

  it("defaults priority so a helper need not think about it", () => {
    const parsed = ImportProfileSchema.parse({
      schema: 1,
      source: { type: "manual" },
      carClass: "mx5",
      callouts: [{ turn: 1, text: "Turn one" }],
    });
    expect(parsed.callouts[0]!.priority).toBe(1);
  });
});
