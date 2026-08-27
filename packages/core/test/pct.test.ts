import { describe, expect, it } from "vitest";

import { aheadM, deltaM, indexToPct, metres, offsetPct, pct, pctToIndex, wrapPct } from "@exxeed/core";

/** Spa-Francorchamps, Grand Prix layout — the worked example throughout SPEC.md. */
const SPA = metres(7004);

/** La Source's 100 board. Sits BEHIND the start/finish line (SPEC.md §4.2). */
const T1_BOARD_100 = pct(0.99781);
const T1_ENTRY = pct(0.0121);

describe("wrapPct", () => {
  it("folds negatives onto 0..1, unlike a bare % 1", () => {
    expect(wrapPct(-0.25)).toBeCloseTo(0.75, 12);
    expect(wrapPct(-1.25)).toBeCloseTo(0.75, 12);
  });

  it("folds values above 1", () => {
    expect(wrapPct(1.25)).toBeCloseTo(0.25, 12);
    expect(wrapPct(3.5)).toBeCloseTo(0.5, 12);
  });

  it("leaves in-range values alone", () => {
    expect(wrapPct(0)).toBe(0);
    expect(wrapPct(0.99781)).toBeCloseTo(0.99781, 12);
  });
});

describe("aheadM", () => {
  it("is never negative, so it can be compared to a lead distance without a sign check", () => {
    for (let i = 0; i < 100; i++) {
      const a = pct(i / 100);
      for (let j = 0; j < 100; j++) {
        expect(aheadM(a, pct(j / 100), SPA)).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("measures forward distance in the racing direction", () => {
    // A tenth of the lap ahead.
    expect(aheadM(pct(0.1), pct(0.2), SPA)).toBeCloseTo(700.4, 6);
    // A tenth BEHIND is nine tenths ahead — you have to go all the way round.
    expect(aheadM(pct(0.2), pct(0.1), SPA)).toBeCloseTo(6303.6, 6);
  });

  it("handles the start/finish wrap — the La Source case", () => {
    // Approaching the 100 board from just before it, still on the previous lap.
    const from = pct(0.973);
    expect(aheadM(from, T1_BOARD_100, SPA)).toBeCloseTo(0.02481 * 7004, 6);

    // From the 100 board forward to turn 1 entry, across start/finish.
    // Raw subtraction would give a large negative number here.
    expect(aheadM(T1_BOARD_100, T1_ENTRY, SPA)).toBeCloseTo(0.01429 * 7004, 6);
    expect(aheadM(T1_BOARD_100, T1_ENTRY, SPA)).toBeLessThan(120);
  });

  it("returns 0 for a point at the current position", () => {
    expect(aheadM(T1_BOARD_100, T1_BOARD_100, SPA)).toBe(0);
  });
});

describe("deltaM", () => {
  // SPEC.md §9 lists this as a required test, in BOTH directions.
  it("crosses the wrap boundary in both directions", () => {
    const before = pct(0.998); // just before start/finish
    const after = pct(0.002); // just after

    const forward = deltaM(after, before, SPA);
    const backward = deltaM(before, after, SPA);

    // 0.004 of a 7004 m lap = 28.016 m apart, not 0.996 of a lap.
    expect(forward).toBeCloseTo(28.016, 6);
    expect(backward).toBeCloseTo(-28.016, 6);
    expect(forward).toBeCloseTo(-backward, 12);
  });

  it("is signed: positive means `a` is later on the lap", () => {
    expect(deltaM(pct(0.6), pct(0.5), SPA)).toBeGreaterThan(0);
    expect(deltaM(pct(0.5), pct(0.6), SPA)).toBeLessThan(0);
  });

  it("never exceeds half a lap in magnitude", () => {
    for (let i = 0; i < 200; i++) {
      const a = pct(i / 200);
      for (let j = 0; j < 200; j++) {
        expect(Math.abs(deltaM(a, pct(j / 200), SPA))).toBeLessThanOrEqual(SPA / 2 + 1e-9);
      }
    }
  });

  it("agrees with naive subtraction away from the boundary, and disagrees at it", () => {
    const naive = (a: number, b: number): number => (a - b) * SPA;

    expect(deltaM(pct(0.6), pct(0.5), SPA)).toBeCloseTo(naive(0.6, 0.5), 6);

    // This is the bug SPEC.md §12 warns about: naive says the driver is 6976 m
    // behind the marker when they are 28 m past it.
    expect(naive(0.002, 0.998)).toBeCloseTo(-6975.984, 3);
    expect(deltaM(pct(0.002), pct(0.998), SPA)).toBeCloseTo(28.016, 3);
  });
});

describe("offsetPct", () => {
  it("moves a landmark backwards across start/finish", () => {
    // 100 m before La Source's entry at 0.0121 lands at 0.99781 — the exact
    // wrapping case from SPEC.md §4.2.
    const back100 = offsetPct(T1_ENTRY, metres(-100), SPA);
    expect(back100).toBeGreaterThan(0.99);
    expect(back100).toBeCloseTo(0.99782, 4);
  });

  it("moves forwards across start/finish", () => {
    expect(offsetPct(T1_BOARD_100, metres(200), SPA)).toBeCloseTo(0.02637, 4);
  });
});

describe("pct grid indexing", () => {
  it("never returns an out-of-range index, including at pct exactly 1", () => {
    expect(pctToIndex(pct(0), 2000)).toBe(0);
    expect(pctToIndex(pct(0.99999999), 2000)).toBe(1999);
    expect(pctToIndex(pct(1), 2000)).toBe(0); // wraps
    expect(pctToIndex(wrapPct(1.5), 2000)).toBe(1000);
  });

  it("round-trips through cell centres", () => {
    for (const i of [0, 1, 999, 1999]) {
      expect(pctToIndex(indexToPct(i, 2000), 2000)).toBe(i);
    }
  });
});
