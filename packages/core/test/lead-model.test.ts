import { describe, expect, it } from "vitest";

import type { EngineEvent, LeadModel, Note, ReferenceLap } from "@exxeed/core";
import {
  constantSpeedLead,
  DEFAULT_PROFILE,
  metres,
  mps,
  NoteEngine,
  pct,
  referenceLead,
  triggerWindow,
} from "@exxeed/core";

import { spaGt3Notes, SPA_LENGTH_M } from "./fixtures.js";

const SPA = metres(SPA_LENGTH_M);
const GRID = 1000;

/** Slow first half, fast second half: a braking point at the end of an accelerating run. */
function acceleratingLap(): ReferenceLap {
  const speeds = Array.from({ length: GRID }, (_, i) => (i < GRID / 2 ? 25 : 25 + ((i - GRID / 2) / (GRID / 2)) * 50));
  const fill = (v: number) => new Array<number>(GRID).fill(v);
  return {
    trackKey: { sim: "iracing", trackId: 266, configId: "grand_prix" },
    carId: "ferrari296gt3",
    lapTimeS: 200,
    gridSize: GRID,
    channels: {
      speedMps: speeds,
      throttle: fill(1),
      brake: fill(0),
      gear: fill(4),
      steerRad: fill(0),
      elapsedS: fill(0),
    },
    derivedForMapVersion: 1,
    perCorner: {},
    brakeChannelInferred: false,
  };
}

const note: Note = {
  ...spaGt3Notes.notes[0]!,
  id: "brake",
  pct: 0.9,
  leadAdjustS: 0,
  audio: { file: "x.wav", durationMs: 2000 },
  audioShort: { file: "x_short.wav", durationMs: 1000 },
};

/** Drive the lap at the reference lap's own speeds and return where the note started. */
function firedAt(lap: ReferenceLap, lead: LeadModel, pace = 1): number {
  const engine = new NoteEngine([note], SPA, DEFAULT_PROFILE, { assumeLapComplete: true }, lead);
  const stepM = 1;
  let p = 0.5;
  let tMs = 0;
  for (let i = 0; i < SPA_LENGTH_M * 0.45; i++) {
    const speed = lap.channels.speedMps[Math.floor(p * GRID) % GRID]! * pace;
    const { events } = engine.tick({
      tMs,
      lapDistPct: pct(p),
      speedMps: mps(speed),
      lap: 3,
      onTrack: true,
      inPitLane: false,
      inGarage: false,
      offTrack: false,
      towTimeS: 0,
      resetCounter: 0,
    });
    const play = events.find((e: EngineEvent) => e.kind === "play");
    if (play !== undefined) return play.atPct;
    p += stepM / SPA_LENGTH_M;
    tMs += (stepM / speed) * 1000;
  }
  throw new Error("never fired");
}

describe("referenceLead", () => {
  const lap = acceleratingLap();
  const window = triggerWindow(note, lap, SPA, DEFAULT_PROFILE);
  const cellM = SPA_LENGTH_M / GRID;

  it("at reference pace, starts the callout where the editor's blue arc starts", () => {
    const at = firedAt(lap, referenceLead(lap, SPA));
    expect(Math.abs(at - window.startPct) * SPA_LENGTH_M).toBeLessThan(2 * cellM);
  });

  it("where constant speed would start late on an accelerating approach", () => {
    const at = firedAt(lap, constantSpeedLead);
    // Later = closer to the event than the blue arc's start.
    expect((at - window.startPct) * SPA_LENGTH_M).toBeGreaterThan(10);
  });

  it("starts later, in track terms, for a car slower than the reference", () => {
    const reference = firedAt(lap, referenceLead(lap, SPA));
    const slower = firedAt(lap, referenceLead(lap, SPA), 0.8);
    expect(slower).toBeGreaterThan(reference);
  });

  it("wraps across the line", () => {
    const flat = { ...lap, channels: { ...lap.channels, speedMps: new Array<number>(GRID).fill(50) } };
    const model = referenceLead(flat, SPA);
    // 100 m before the line to 100 m after it, at 50 m/s: 4 s.
    const s = model.secondsAhead(pct(1 - 100 / SPA_LENGTH_M), pct(100 / SPA_LENGTH_M), metres(200), mps(50));
    expect(s).toBeCloseTo(4, 1);
  });
});
