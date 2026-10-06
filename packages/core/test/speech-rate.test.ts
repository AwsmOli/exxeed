import { describe, expect, it } from "vitest";

import {
  atSpeechRate,
  clampSpeechRate,
  leadSecondsFor,
  metres,
  NoteEngine,
  NoteSchema,
  pct,
  mps,
  type Note,
} from "../src/index.js";

const note = (over: Partial<Note> = {}): Note =>
  NoteSchema.parse({
    id: "abc123",
    pct: 0.5,
    text: "Brake at the 100 board, third gear.",
    textShort: "100, third",
    priority: 1,
    audio: { file: "abc123.wav", durationMs: 4000 },
    audioShort: { file: "abc123_short.wav", durationMs: 1000 },
    ...over,
  });

describe("clampSpeechRate", () => {
  it("keeps a sane rate and brings the rest into range", () => {
    expect(clampSpeechRate(1.25)).toBe(1.25);
    expect(clampSpeechRate(5)).toBe(2);
    expect(clampSpeechRate(0.1)).toBe(0.5);
  });

  it("is 1 for anything that is not a number — a settings file from before the setting", () => {
    expect(clampSpeechRate(undefined)).toBe(1);
    expect(clampSpeechRate("1.5")).toBe(1);
    expect(clampSpeechRate(Number.NaN)).toBe(1);
  });
});

describe("atSpeechRate", () => {
  it("shortens both variants and nothing else", () => {
    const [fast] = atSpeechRate([note()], 1.25);
    expect(fast?.audio.durationMs).toBeCloseTo(3200);
    expect(fast?.audioShort.durationMs).toBeCloseTo(800);
    expect(fast).toMatchObject({ id: "abc123", pct: 0.5, text: "Brake at the 100 board, third gear." });
    expect(fast?.audio.file).toBe("abc123.wav");
  });

  it("leaves the notes as rendered at a rate of 1, and does not touch the originals", () => {
    const original = note();
    expect(atSpeechRate([original], 1)[0]).toEqual(original);
    atSpeechRate([original], 2);
    expect(original.audio.durationMs).toBe(4000);
  });

  it("moves the trigger later by exactly the time saved", () => {
    const profile = { leadAdjustS: 0 };
    const slow = note();
    const fast = atSpeechRate([slow], 1.25)[0]!;
    // 4 s of speech becomes 3.2 s: the callout can start 0.8 s later.
    expect(leadSecondsFor(slow, slow.audio, profile) - leadSecondsFor(fast, fast.audio, profile)).toBeCloseTo(0.8);
  });

  it("is what makes the engine start a faster callout later on track", () => {
    const lengthM = metres(4000);
    const firstPlayAt = (notes: Note[]): number | null => {
      const engine = new NoteEngine(notes, lengthM, { leadAdjustS: 0 }, { assumeLapComplete: true });
      // 50 m/s round a 4 km lap, sampled at 60 Hz.
      for (let i = 0; i < 80 * 60; i++) {
        const tMs = (i * 1000) / 60;
        const result = engine.tick({
          tMs,
          lap: 1,
          lapDistPct: pct(((tMs / 1000) * 50) / 4000),
          speedMps: mps(50),
          onTrack: true,
          inPitLane: false,
          inGarage: false,
          offTrack: false,
          towTimeS: 0,
          resetCounter: 0,
        });
        const play = result.events.find((e) => e.kind === "play");
        if (play !== undefined) return tMs / 1000;
      }
      return null;
    };

    const asRendered = firstPlayAt([note()]);
    const faster = firstPlayAt(atSpeechRate([note()], 1.25));
    expect(asRendered).not.toBeNull();
    expect(faster).not.toBeNull();
    expect((faster ?? 0) - (asRendered ?? 0)).toBeCloseTo(0.8, 1);
  });
});
