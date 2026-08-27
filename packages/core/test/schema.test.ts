import { describe, expect, it } from "vitest";

import {
  LandmarkInventorySchema,
  NoteSchema,
  NoteSetSchema,
  TrackMapSchema,
  summariseNoteSet,
} from "@exxeed/core";

import { spaGt3Notes, spaLandmarks, spaMap } from "./fixtures.js";

describe("TrackMapSchema", () => {
  it("parses the Spa fixture", () => {
    expect(() => TrackMapSchema.parse(spaMap)).not.toThrow();
  });

  it("rejects a centreline whose arrays disagree with gridSize", () => {
    const broken = { ...spaMap, centreline: { ...spaMap.centreline, x: [1, 2, 3] } };
    expect(() => TrackMapSchema.parse(broken)).toThrow();
  });

  it("rejects a lap position outside 0..1 — the /100 mistake from §3", () => {
    const asPercent = {
      ...spaMap,
      corners: [{ ...spaMap.corners[0]!, entryPct: 1.21 }],
    };
    expect(() => TrackMapSchema.parse(asPercent)).toThrow();
  });
});

describe("LandmarkInventorySchema", () => {
  it("accepts a landmark that sits behind start/finish", () => {
    const parsed = LandmarkInventorySchema.parse(spaLandmarks);
    expect(parsed.landmarks[0]?.pct).toBeCloseTo(0.99781, 6);
  });

  it("rejects an unknown landmark type rather than coercing it", () => {
    const bad = {
      ...spaLandmarks,
      landmarks: [{ ...spaLandmarks.landmarks[0]!, type: "big_tree" }],
    };
    expect(() => LandmarkInventorySchema.parse(bad)).toThrow();
  });
});

describe("NoteSchema", () => {
  it("parses the fixture notes", () => {
    expect(() => NoteSetSchema.parse(spaGt3Notes)).not.toThrow();
  });

  it("requires BOTH audio variants — the short-form fallback needs a real duration", () => {
    // SPEC.md §4.4 / §6.3: the scheduler computes lead distance from
    // audioShort.durationMs, so a note without it cannot be scheduled at all.
    const { audioShort: _dropped, ...withoutShort } = spaGt3Notes.notes[0]!;
    expect(() => NoteSchema.parse(withoutShort)).toThrow();
  });

  it("rejects a zero-length audio duration", () => {
    const bad = {
      ...spaGt3Notes.notes[0]!,
      audio: { file: "x.wav", durationMs: 0 },
    };
    expect(() => NoteSchema.parse(bad)).toThrow();
  });

  it("defaults leadAdjustS, fadeable and dirty", () => {
    const {
      leadAdjustS: _a,
      fadeable: _b,
      dirty: _c,
      ...bare
    } = spaGt3Notes.notes[1]!;
    const parsed = NoteSchema.parse(bare);
    expect(parsed.leadAdjustS).toBe(0);
    expect(parsed.fadeable).toBe(true);
    expect(parsed.dirty).toBe(false);
  });

  it("discriminates landmark and corner anchors", () => {
    expect(NoteSchema.parse(spaGt3Notes.notes[0]!).anchor.type).toBe("landmark");
    expect(NoteSchema.parse(spaGt3Notes.notes[1]!).anchor.type).toBe("corner");
  });
});

describe("summariseNoteSet", () => {
  it("drops the notes but keeps the count, so a picker can list without loading", () => {
    const summary = summariseNoteSet(spaGt3Notes);
    expect(summary.noteCount).toBe(2);
    expect(summary.trackRef.mapVersion).toBe(3);
    expect(summary).not.toHaveProperty("notes");
  });
});
