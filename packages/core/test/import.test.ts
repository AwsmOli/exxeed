import { describe, expect, it } from "vitest";

import type { ImportProfile, ReferenceLap, TrackMap } from "@exxeed/core";
import { ImportProfileSchema, resolveProfile } from "@exxeed/core";

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

const lap: ReferenceLap = {
  trackKey: { sim: "iracing", trackId: 192, configId: "road_course" },
  carId: "mx5-mx52016",
  lapTimeS: 135.4,
  gridSize: 4,
  channels: {
    speedMps: [50, 50, 50, 50], throttle: [1, 1, 1, 1], brake: [0, 0, 0, 0],
    gear: [4, 4, 4, 4], steerRad: [0, 0, 0, 0], elapsedS: [0, 33, 66, 99],
  },
  derivedForMapVersion: 1,
  perCorner: {
    "1": { brakeOnsetPct: 0.0513, throttleOnPct: 0.058, minSpeedMps: 24 },
    "2": { brakeOnsetPct: 0.1482, throttleOnPct: 0.152, minSpeedMps: 20 },
    // Turn 3 is taken flat — no braking to point at.
    "3": { brakeOnsetPct: null, throttleOnPct: 0.30, minSpeedMps: 45 },
    "4": { brakeOnsetPct: 0.6492, throttleOnPct: 0.66, minSpeedMps: 30 },
  },
  brakeChannelInferred: false,
};

const profile = (callouts: ImportProfile["callouts"]): ImportProfile => ({
  schema: 1,
  source: { type: "youtube", videoId: "abc", channel: "Samba Racing" },
  carClass: "mx5",
  callouts,
});

describe("resolveProfile", () => {
  it("puts a callout where the braking actually starts", () => {
    // The words say "brake", so that is the moment they are about — and it is
    // what §10 stage 4 validates against.
    const { notes } = resolveProfile(
      profile([{ turn: 2, text: "Turn two, brake at the lamp post", priority: 1 }]),
      map,
      lap,
    );

    expect(notes).toHaveLength(1);
    expect(notes[0]!.pct).toBeCloseTo(0.1482, 6);
    expect(notes[0]!.id).toBe("t2");
  });

  it("anchors a range at its first turn", () => {
    // Corners sharing a braking zone report the same onset, which is why a
    // sequence gets one callout rather than one each (§4.4).
    const { notes } = resolveProfile(
      profile([{ turn: 4, throughTurn: 4, text: "Chicane, brake at the one marker", priority: 1 }]),
      map,
      lap,
    );

    expect(notes[0]!.id).toBe("t4_4");
    expect(notes[0]!.pct).toBeCloseTo(0.6492, 6);
  });

  it("falls back to corner entry where nothing brakes, and says so", () => {
    const { notes, warnings } = resolveProfile(
      profile([{ turn: 3, text: "Turn three, flat", priority: 2 }]),
      map,
      lap,
    );

    expect(notes[0]!.pct).toBeCloseTo(0.3, 6);
    expect(warnings.join(" ")).toMatch(/no measured braking point/);
  });

  it("refuses a turn the map does not have, rather than guessing", () => {
    // The failure this catches is the one that is otherwise silent: a track whose
    // corners were never renumbered to the convention, so every mapping is off.
    const { notes, unresolved } = resolveProfile(
      profile([{ turn: 9, text: "Turn nine", priority: 1 }]),
      map,
      lap,
    );

    expect(notes).toHaveLength(0);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.reason).toMatch(/corners\.override\.json/);
  });

  it("rejects a backwards range", () => {
    const { unresolved } = resolveProfile(
      profile([{ turn: 4, throughTurn: 2, text: "Backwards", priority: 1 }]),
      map,
      lap,
    );
    expect(unresolved[0]!.reason).toMatch(/ends before it begins/);
  });

  it("works with no reference lap, and warns that every position is weaker", () => {
    const { notes, warnings } = resolveProfile(
      profile([{ turn: 2, text: "Turn two, brake at the lamp post", priority: 1 }]),
      map,
      null,
    );

    expect(notes[0]!.pct).toBeCloseTo(0.14, 6); // corner entry, not the onset
    expect(warnings.join(" ")).toMatch(/no reference lap/);
  });

  it("marks everything dirty — nothing has been spoken yet", () => {
    const { notes } = resolveProfile(
      profile([{ turn: 1, text: "Turn one", priority: 1 }]),
      map,
      lap,
    );
    expect(notes[0]!.dirty).toBe(true);
  });

  it("derives a short form when none was given, and flags it", () => {
    const { notes, warnings } = resolveProfile(
      profile([{ turn: 1, text: "Turn one, brake at the black seam", priority: 1 }]),
      map,
      lap,
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
      lap,
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
      lap,
    );
    expect(notes.map((n) => n.id)).toEqual(["t1", "t2", "t4"]);
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
