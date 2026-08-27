import { describe, expect, it } from "vitest";

import type { Note } from "@exxeed/core";
import {
  DEFAULT_PROFILE,
  leadDistanceM,
  leadSecondsFor,
  MIN_TAIL_S,
  mps,
  REACTION_BUFFER_S,
  seconds,
} from "@exxeed/core";

import { spaGt3Notes } from "./fixtures.js";

const brakeNote = spaGt3Notes.notes[0]!; // audio 1240 ms, leadAdjustS −0.2
const throttleNote = spaGt3Notes.notes[1]!; // audio 900 ms, leadAdjustS 0

/** 250 km/h — the speed SPEC.md §6.1 works its 207 m example at. */
const V250 = mps(69);

describe("leadSecondsFor", () => {
  it("is duration + reaction buffer + both adjustments", () => {
    // 0.9 s of audio, plus the buffer, no adjustments either side.
    expect(leadSecondsFor(throttleNote, throttleNote.audio, DEFAULT_PROFILE)).toBeCloseTo(
      0.9 + REACTION_BUFFER_S,
      6,
    );

    // 1.24 s of audio, plus the buffer, −0.2 s author adjustment.
    expect(leadSecondsFor(brakeNote, brakeNote.audio, DEFAULT_PROFILE)).toBeCloseTo(
      1.24 + REACTION_BUFFER_S - 0.2,
      6,
    );
  });

  it("adds the two adjustment layers rather than letting one win", () => {
    // SPEC.md §6.1: note.leadAdjustS is the author's fix and ships with the note
    // set; profile.leadAdjustS is one driver's preference and stays local. A
    // driver who wants more warning gets it ON TOP of the author's correction.
    const withPreference = leadSecondsFor(brakeNote, brakeNote.audio, { leadAdjustS: 0.4 });
    const withoutPreference = leadSecondsFor(brakeNote, brakeNote.audio, DEFAULT_PROFILE);

    expect(withPreference - withoutPreference).toBeCloseTo(0.4, 6);
    expect(withPreference).toBeCloseTo(1.24 + REACTION_BUFFER_S - 0.2 + 0.4, 6);
  });

  it("never schedules the voice to still be talking after its own event", () => {
    // A large negative adjustment would otherwise produce a lead shorter than the
    // callout itself — the driver would still be hearing "…hundred board" after
    // the braking point had gone by.
    const overCorrected: Note = { ...brakeNote, leadAdjustS: -5 };
    const lead = leadSecondsFor(overCorrected, overCorrected.audio, DEFAULT_PROFILE);

    expect(lead).toBeCloseTo(1.24 + MIN_TAIL_S, 6);
    expect(lead).toBeGreaterThan(1.24);
  });

  it("clamps against a hostile profile too, not just a hostile note", () => {
    const lead = leadSecondsFor(brakeNote, brakeNote.audio, { leadAdjustS: -10 });
    expect(lead).toBeCloseTo(1.24 + MIN_TAIL_S, 6);
  });

  it("uses the variant it is given, so the short form gets its own lead", () => {
    const full = leadSecondsFor(brakeNote, brakeNote.audio, DEFAULT_PROFILE);
    const short = leadSecondsFor(brakeNote, brakeNote.audioShort, DEFAULT_PROFILE);

    // 720 ms vs 1240 ms of audio — the short form needs 520 ms less warning,
    // which is exactly what lets the scheduler (§6.3) fit it when the full form
    // no longer fits.
    expect(full - short).toBeCloseTo(0.52, 6);
  });
});

describe("leadDistanceM", () => {
  it("reproduces the §6.1 worked example: a 2 s callout at 250 km/h starts 207 m early", () => {
    const twoSecondCallout: Note = {
      ...brakeNote,
      leadAdjustS: 0,
      audio: { file: "x.wav", durationMs: 2000 },
    };
    const leadS = leadSecondsFor(twoSecondCallout, twoSecondCallout.audio, DEFAULT_PROFILE);

    expect(leadS).toBeCloseTo(2 + REACTION_BUFFER_S, 6);
    expect(leadDistanceM(V250, leadS)).toBeCloseTo(207, 1);
  });

  it("scales with speed — which is why a static trigger pct would be wrong", () => {
    const leadS = seconds(2.5);

    // The same callout, at three speeds, starts at three very different places.
    expect(leadDistanceM(mps(69), leadS)).toBeCloseTo(172.5, 6); // 250 km/h
    expect(leadDistanceM(mps(25), leadS)).toBeCloseTo(62.5, 6); // 90 km/h
    expect(leadDistanceM(mps(0), leadS)).toBe(0);

    // A fixed percentage of the lap would be correct at exactly one of these.
    expect(leadDistanceM(mps(69), leadS)).toBeGreaterThan(
      leadDistanceM(mps(25), leadS) * 2,
    );
  });
});
