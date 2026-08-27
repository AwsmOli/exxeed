import { describe, expect, it } from "vitest";

import { deltaSeconds, LapTimer, pct, seconds } from "@exxeed/core";

describe("LapTimer", () => {
  it("reports nothing until it has seen a start/finish crossing", () => {
    // There is no honest answer before then. A delta against a lap whose start
    // was guessed is worse than no delta.
    const timer = new LapTimer();
    expect(timer.update(100, 0.4)).toBeNull();
    expect(timer.update(101, 0.5)).toBeNull();
  });

  it("measures from the crossing once one has gone past", () => {
    const timer = new LapTimer();
    timer.update(100, 0.98);
    expect(timer.update(101, 0.01)).toBeCloseTo(0, 6);
    expect(timer.update(131, 0.4)).toBeCloseTo(30, 6);
  });

  it("ignores jitter at the line rather than counting it as a lap", () => {
    // Counting every backwards step as a crossing reported 4404 laps for a
    // six-lap session: a car parked near the line crosses it indefinitely.
    const timer = new LapTimer();
    timer.update(100, 0.99);
    timer.update(101, 0.001);
    expect(timer.update(110, 0.02)).toBeCloseTo(9, 6);

    // A small step backwards — noise, not a lap.
    expect(timer.update(111, 0.019)).toBeCloseTo(10, 6);
    expect(timer.update(112, 0.021)).toBeCloseTo(11, 6);
  });

  it("starts a fresh lap on each real crossing", () => {
    const timer = new LapTimer();
    timer.update(0, 0.9);
    timer.update(10, 0.05);
    expect(timer.update(70, 0.95)).toBeCloseTo(60, 6);
    expect(timer.update(80, 0.05)).toBeCloseTo(0, 6);
  });
});

describe("deltaSeconds", () => {
  // Elapsed time at each of four grid cells.
  const referenceElapsedS = [0, 30, 60, 90];

  it("is the driver's elapsed minus the reference at the same point", () => {
    // Only this simple because ReferenceLap is on a fixed pct grid (§4.3):
    // comparison is an array index with no time alignment.
    const d = deltaSeconds({
      lapElapsedS: seconds(64),
      lapDistPct: pct(0.5),
      referenceElapsedS,
      gridSize: 4,
    });
    expect(d).toBeCloseTo(4, 6);
  });

  it("is negative when up on the reference", () => {
    const d = deltaSeconds({
      lapElapsedS: seconds(55),
      lapDistPct: pct(0.5),
      referenceElapsedS,
      gridSize: 4,
    });
    expect(d).toBeCloseTo(-5, 6);
  });

  it("returns null before the lap timer has anything to report", () => {
    expect(
      deltaSeconds({ lapElapsedS: null, lapDistPct: pct(0.5), referenceElapsedS, gridSize: 4 }),
    ).toBeNull();
  });

  it("returns null rather than NaN when the grid and the array disagree", () => {
    // noUncheckedIndexedAccess makes this reachable rather than theoretical: a
    // reference lap cut at a different gridSize would otherwise index past the end.
    expect(
      deltaSeconds({ lapElapsedS: seconds(10), lapDistPct: pct(0.9), referenceElapsedS, gridSize: 2000 }),
    ).toBeNull();
  });
});
