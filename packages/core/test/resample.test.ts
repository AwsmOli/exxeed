import { describe, expect, it } from "vitest";

import { LapResampleError, metres, pct, resampleLap, type LapSample } from "@exxeed/core";

const LENGTH = metres(5687.3);

/** A lap of `n` evenly spaced samples, with per-channel generators. */
const lap = (
  n: number,
  fn: (i: number, p: number) => Partial<LapSample> = () => ({}),
): LapSample[] =>
  Array.from({ length: n }, (_, i) => {
    const p = i / (n - 1);
    return {
      tMs: i * 16,
      lapDistPct: pct(p),
      speedMps: 40,
      throttle: 1,
      brake: 0,
      gear: 4,
      steerRad: 0,
      ...fn(i, p),
    };
  });

describe("resampleLap", () => {
  it("puts every channel on the requested grid", () => {
    const { lap: r } = resampleLap(lap(500), 200, LENGTH);

    expect(r.gridSize).toBe(200);
    for (const ch of [r.speedMps, r.throttle, r.brake, r.gear, r.steerRad, r.elapsedS]) {
      expect(ch).toHaveLength(200);
      expect(ch.every(Number.isFinite)).toBe(true);
    }
  });

  it("refuses a lap whose position goes backwards", () => {
    const samples = lap(100);
    // A reset, a spin, or two laps concatenated. Sorting this into place would
    // turn a lap that must be rejected into one that looks fine.
    samples[50] = { ...samples[50]!, lapDistPct: pct(0.1) };

    expect(() => resampleLap(samples, 100, LENGTH)).toThrow(LapResampleError);
    expect(() => resampleLap(samples, 100, LENGTH)).toThrow(/goes backwards/);
  });

  it("rejects too few samples and a nonsense grid", () => {
    expect(() => resampleLap(lap(1), 100, LENGTH)).toThrow(/at least 2 samples/);
    expect(() => resampleLap(lap(10), 1, LENGTH)).toThrow(/gridSize/);
    expect(() => resampleLap(lap(10), 2.5, LENGTH)).toThrow(/gridSize/);
  });

  it("interpolates between samples rather than snapping to the nearest", () => {
    // Speed ramps linearly with position, so every grid cell has an exactly
    // predictable value — snapping would show up as a staircase.
    const { lap: r } = resampleLap(lap(21, (_, p) => ({ speedMps: 100 * p })), 100, LENGTH);

    for (let i = 0; i < 100; i++) {
      expect(r.speedMps[i]!).toBeCloseTo(100 * ((i + 0.5) / 100), 4);
    }
  });

  it("does not interpolate gear — there is no gear 3.4", () => {
    const { lap: r } = resampleLap(lap(200, (_, p) => ({ gear: p < 0.5 ? 3 : 4 })), 100, LENGTH);
    expect(new Set(r.gear)).toEqual(new Set([3, 4]));
  });

  it("reports elapsed time that rises to the lap time", () => {
    const { lap: r } = resampleLap(lap(601), 200, LENGTH); // 600 * 16 ms

    expect(r.lapTimeS).toBeCloseTo(9.6, 3);
    expect(r.elapsedS[0]!).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < r.elapsedS.length; i++) {
      expect(r.elapsedS[i]!).toBeGreaterThanOrEqual(r.elapsedS[i - 1]!);
    }
  });

  it("warns rather than throws on a partial lap", () => {
    const partial = lap(200).map((s) => ({ ...s, lapDistPct: pct(s.lapDistPct * 0.6) }));
    const { warnings } = resampleLap(partial, 100, LENGTH);

    expect(warnings.join(" ")).toMatch(/partial lap/);
  });

  it("warns when the sim dropped a chunk of the lap", () => {
    // 5% of the lap missing — a stall, a pause, or dropped frames.
    const samples = lap(200).filter((s) => s.lapDistPct < 0.4 || s.lapDistPct > 0.45);
    const { warnings, coverage } = resampleLap(samples, 200, LENGTH);

    expect(warnings.join(" ")).toMatch(/widest sample gap/);
    expect(coverage).toBeLessThan(1);
  });

  it("reports full coverage for a dense lap", () => {
    const { coverage, warnings } = resampleLap(lap(4000), 2000, LENGTH);
    expect(coverage).toBe(1);
    expect(warnings).toEqual([]);
  });
});
