/**
 * §9 lists "brakeOnsetPct returns the onset, not a sample near corner entry" as
 * a required test, not an optional one. That case is `finds where braking began`
 * below — everything else here is around it.
 */

import { describe, expect, it } from "vitest";

import {
  brakeOnsetPct,
  metres,
  minSpeedBetween,
  pct,
  perCornerMetrics,
  seconds,
  throttleOnPct,
  type ResampledLap,
} from "@exxeed/core";

const GRID = 1000;
const LENGTH = metres(4000);

/** A lap where each channel is a function of lap position. */
const lapWith = (fn: (p: number) => Partial<{ brake: number; throttle: number; speed: number }>): ResampledLap => {
  const brake = new Array<number>(GRID);
  const throttle = new Array<number>(GRID);
  const speedMps = new Array<number>(GRID);
  for (let i = 0; i < GRID; i++) {
    const v = fn((i + 0.5) / GRID);
    brake[i] = v.brake ?? 0;
    throttle[i] = v.throttle ?? 0;
    speedMps[i] = v.speed ?? 50;
  }
  return {
    gridSize: GRID,
    lengthM: LENGTH,
    speedMps,
    throttle,
    brake,
    gear: new Array<number>(GRID).fill(4),
    steerRad: new Array<number>(GRID).fill(0),
    elapsedS: Array.from({ length: GRID }, (_, i) => i * 0.1),
    lapTimeS: seconds(100),
  };
};

/** Whether `p` is inside `from..to`, going in the racing direction. */
const near = (a: number, b: number, tol: number): boolean => Math.abs(((a - b + 1.5) % 1) - 0.5) < tol;

describe("brakeOnsetPct", () => {
  it("finds where braking began, not where the car still happens to be braking", () => {
    // §5.1: "a driver is still hard on the brakes at corner entry, so a naive
    // backwards scan returns something ~= entryPct and the metric becomes
    // meaningless." Braking runs 0.17..0.20 — 120 m on this 4 km lap — and the
    // corner starts at 0.20.
    const lap = lapWith((p) => ({ brake: p >= 0.17 && p < 0.2 ? 0.9 : 0 }));

    const onset = brakeOnsetPct(lap, pct(0.2), LENGTH);

    expect(onset).not.toBeNull();
    expect(onset!).toBeCloseTo(0.17, 2);
    // The failure this test exists to catch would return ~0.199.
    expect(onset!).toBeLessThan(0.18);
  });

  it("stops at its 300 m window rather than running back forever", () => {
    // Braking from 0.10 to 0.20 is 400 m, longer than §5.1's search window. The
    // answer is clamped to the window edge, so a pathological trace cannot walk
    // back across half a lap — but it does mean the value is the window, not a
    // real onset. Worth knowing before trusting one on a very long braking zone.
    const lap = lapWith((p) => ({ brake: p >= 0.1 && p < 0.2 ? 0.9 : 0 }));

    const onset = brakeOnsetPct(lap, pct(0.2), LENGTH);

    expect(onset).not.toBeNull();
    // 300 m back from 0.20 on a 4 km lap is 0.125.
    expect(onset!).toBeGreaterThan(0.12);
    expect(onset!).toBeLessThan(0.13);
  });

  it("returns null when the car never braked for the corner", () => {
    const lap = lapWith(() => ({ brake: 0 }));
    expect(brakeOnsetPct(lap, pct(0.2), LENGTH)).toBeNull();
  });

  it("ignores a brush of the pedal below the threshold", () => {
    const lap = lapWith((p) => ({ brake: p >= 0.1 && p < 0.2 ? 0.05 : 0 }));
    expect(brakeOnsetPct(lap, pct(0.2), LENGTH)).toBeNull();
  });

  it("finds an onset that sits before the start/finish line", () => {
    // §4.2's La Source case: the corner is just past the line, the braking point
    // is just before it. Raw subtraction gets this wrong; the search must wrap.
    const lap = lapWith((p) => ({ brake: p >= 0.97 || p < 0.01 ? 0.9 : 0 }));

    const onset = brakeOnsetPct(lap, pct(0.01), LENGTH);

    expect(onset).not.toBeNull();
    expect(near(onset!, 0.97, 0.02)).toBe(true);
  });

  it("does not look further back than its search window", () => {
    // Braking 1000 m before entry, well outside the 300 m window.
    const lap = lapWith((p) => ({ brake: p >= 0.4 && p < 0.45 ? 0.9 : 0 }));
    expect(brakeOnsetPct(lap, pct(0.7), LENGTH)).toBeNull();
  });
});

describe("throttleOnPct", () => {
  it("finds the first pickup after the apex", () => {
    const lap = lapWith((p) => ({ throttle: p >= 0.55 ? 1 : 0 }));

    const on = throttleOnPct(lap, pct(0.5), LENGTH);

    expect(on).not.toBeNull();
    expect(on!).toBeCloseTo(0.55, 2);
  });

  it("ignores a trickle of throttle below the threshold", () => {
    const lap = lapWith((p) => ({ throttle: p >= 0.55 ? 0.2 : 0 }));
    expect(throttleOnPct(lap, pct(0.5), LENGTH)).toBeNull();
  });

  it("wraps past start/finish looking forward", () => {
    const lap = lapWith((p) => ({ throttle: p >= 0.01 && p < 0.2 ? 1 : 0 }));

    const on = throttleOnPct(lap, pct(0.98), LENGTH);

    expect(on).not.toBeNull();
    expect(near(on!, 0.01, 0.02)).toBe(true);
  });
});

describe("minSpeedBetween", () => {
  it("takes the minimum across the corner, wrapping if it has to", () => {
    const lap = lapWith((p) => ({ speed: p > 0.98 || p < 0.02 ? 12 : 50 }));
    expect(minSpeedBetween(lap, pct(0.97), pct(0.03))).toBeCloseTo(12, 5);
  });
});

describe("perCornerMetrics", () => {
  it("returns all three §4.3 fields for one corner", () => {
    const lap = lapWith((p) => ({
      brake: p >= 0.17 && p < 0.2 ? 0.9 : 0,
      throttle: p >= 0.25 ? 1 : 0,
      speed: p >= 0.2 && p < 0.25 ? 15 : 50,
    }));

    const m = perCornerMetrics(lap, { entryPct: 0.2, apexPct: 0.22, exitPct: 0.28 }, LENGTH);

    expect(m.brakeOnsetPct!).toBeCloseTo(0.17, 2);
    expect(m.throttleOnPct!).toBeCloseTo(0.25, 2);
    expect(m.minSpeedMps).toBeCloseTo(15, 5);
  });
});
