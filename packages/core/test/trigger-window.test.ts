import { describe, expect, it } from "vitest";

import type { Note, ReferenceLap } from "@exxeed/core";
import {
  DEFAULT_PROFILE,
  metres,
  nearestBrakeOnset,
  pct,
  triggerWindow,
} from "@exxeed/core";

import { spaGt3Notes, SPA_LENGTH_M } from "./fixtures.js";

const SPA = metres(SPA_LENGTH_M);
const GRID = 1000;

/** A lap at one constant speed, so the arithmetic is checkable by hand. */
function flatLap(speedMps: number): ReferenceLap {
  const fill = (v: number) => new Array<number>(GRID).fill(v);
  return {
    trackKey: { sim: "iracing", trackId: 266, configId: "grand_prix" },
    carId: 1,
    lapTimeS: SPA_LENGTH_M / speedMps,
    gridSize: GRID,
    channels: {
      speedMps: fill(speedMps),
      throttle: fill(1),
      brake: fill(0),
      gear: fill(6),
      steerRad: fill(0),
      elapsedS: Array.from({ length: GRID }, (_, i) => (i / GRID) * (SPA_LENGTH_M / speedMps)),
    },
    derivedForMapVersion: 3,
    perCorner: {},
    brakeChannelInferred: false,
  };
}

/** Accelerating hard through the second half — where §7.4 says cues land late. */
function acceleratingLap(): ReferenceLap {
  const base = flatLap(40);
  const speeds = Array.from({ length: GRID }, (_, i) => (i < GRID / 2 ? 25 : 70));
  return { ...base, channels: { ...base.channels, speedMps: speeds } };
}

const noteAt = (p: number, durationMs: number): Note => ({
  ...spaGt3Notes.notes[0]!,
  pct: p,
  leadAdjustS: 0,
  audio: { file: "x.wav", durationMs },
  audioShort: { file: "x_short.wav", durationMs: Math.round(durationMs / 2) },
});

describe("triggerWindow", () => {
  it("walks back the lead time along the speed profile", () => {
    // 2 s of audio + 1 s buffer = 3 s at 50 m/s = 150 m before the event.
    const window = triggerWindow(noteAt(0.5, 2000), flatLap(50), SPA, DEFAULT_PROFILE);

    expect(window.leadS).toBeCloseTo(3, 6);
    expect(window.lengthM).toBeCloseTo(150, -1);
    // Within a grid cell — the profile is sampled, so the walk lands on one.
    expect(window.startPct).toBeCloseTo(0.5 - 150 / SPA_LENGTH_M, 2);
  });

  it("is longer for a longer sentence — the cost the editor makes visible", () => {
    const lap = flatLap(50);
    const short = triggerWindow(noteAt(0.5, 1000), lap, SPA, DEFAULT_PROFILE);
    const long = triggerWindow(noteAt(0.5, 3000), lap, SPA, DEFAULT_PROFILE);

    // Two extra seconds of speech at 50 m/s is 100 m more track.
    expect(long.lengthM - short.lengthM).toBeCloseTo(100, -1);
  });

  it("wraps across start/finish rather than clamping at zero", () => {
    const window = triggerWindow(noteAt(0.01, 2000), flatLap(50), SPA, DEFAULT_PROFILE);
    expect(window.startPct).toBeGreaterThan(0.9);
  });

  it("agrees with the engine when speed is constant", () => {
    // With one speed, the runtime's instantaneous estimate is exactly right, so
    // there is nothing to correct.
    const window = triggerWindow(noteAt(0.5, 2000), flatLap(50), SPA, DEFAULT_PROFILE);

    expect(window.runtimeStartPct).toBeCloseTo(window.startPct, 2);
    expect(Math.abs(window.suggestedLeadAdjustS)).toBeLessThan(0.05);
  });

  it("suggests more lead where the car is accelerating", () => {
    // §7.4: the runtime assumes the car holds its current speed for the whole
    // callout. Accelerating, it covers more ground than that and the cue lands
    // late — so the correction has to be positive.
    // Placed just past the speed change so the callout STARTS in the slow half
    // and finishes in the fast one — which is the only case where the runtime's
    // one speed sample can be wrong about the whole window.
    const window = triggerWindow(noteAt(0.51, 2500), acceleratingLap(), SPA, DEFAULT_PROFILE);

    expect(window.suggestedLeadAdjustS).toBeGreaterThan(0.1);
    // The engine starts later than the truth wants, which is the whole problem.
    expect(window.runtimeStartPct).toBeGreaterThan(window.startPct);
  });

  it("uses the short form's own duration when asked", () => {
    const lap = flatLap(50);
    const full = triggerWindow(noteAt(0.5, 2000), lap, SPA, DEFAULT_PROFILE, "full");
    const short = triggerWindow(noteAt(0.5, 2000), lap, SPA, DEFAULT_PROFILE, "short");

    expect(short.lengthM).toBeLessThan(full.lengthM);
  });

  it("includes the driver's own lead preference", () => {
    const lap = flatLap(50);
    const plain = triggerWindow(noteAt(0.5, 2000), lap, SPA, DEFAULT_PROFILE);
    const early = triggerWindow(noteAt(0.5, 2000), lap, SPA, { leadAdjustS: 1 });

    expect(early.lengthM - plain.lengthM).toBeCloseTo(50, -1);
  });
});

describe("nearestBrakeOnset", () => {
  const lap: ReferenceLap = {
    ...flatLap(50),
    perCorner: {
      "1": { brakeOnsetPct: 0.05, throttleOnPct: 0.07, minSpeedMps: 20 },
      "2": { brakeOnsetPct: 0.5, throttleOnPct: 0.52, minSpeedMps: 30 },
      "3": { brakeOnsetPct: null, throttleOnPct: 0.8, minSpeedMps: 60 },
    },
  };

  it("snaps a roughly-placed note to where braking actually starts", () => {
    expect(nearestBrakeOnset(pct(0.505), lap, SPA)).toBeCloseTo(0.5, 6);
  });

  it("looks backwards as well as forwards", () => {
    expect(nearestBrakeOnset(pct(0.495), lap, SPA)).toBeCloseTo(0.5, 6);
  });

  it("wraps across start/finish", () => {
    // 0.998 to 0.05 is 364 m, so the default 250 m window would rightly refuse.
    expect(nearestBrakeOnset(pct(0.998), lap, SPA, 500)).toBeCloseTo(0.05, 6);
  });

  it("returns null rather than dragging a note across the track", () => {
    expect(nearestBrakeOnset(pct(0.3), lap, SPA)).toBeNull();
  });

  it("ignores corners taken flat, which have no onset", () => {
    // Corner 3's onset is null. Nothing should snap to it.
    expect(nearestBrakeOnset(pct(0.8), lap, SPA, 5000)).not.toBeCloseTo(0.8, 3);
  });
});
