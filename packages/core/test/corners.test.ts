import { describe, expect, it } from "vitest";

import {
  detectCorners,
  metres,
  percentile,
  resampleLap,
  seconds,
  severityOf,
  smoothWrapped,
  type LapSample,
  type ResampledLap,
} from "@exxeed/core";
import { pct } from "@exxeed/core";

const LENGTH = metres(4000);
const GRID = 1000;

/** Build a lap on the grid directly, from a steering and speed function of pct. */
const gridLap = (
  steerAt: (p: number) => number,
  speedAt: (p: number) => number = () => 40,
): ResampledLap => ({
  gridSize: GRID,
  lengthM: LENGTH,
  speedMps: Array.from({ length: GRID }, (_, i) => speedAt((i + 0.5) / GRID)),
  throttle: new Array<number>(GRID).fill(1),
  brake: new Array<number>(GRID).fill(0),
  gear: new Array<number>(GRID).fill(4),
  steerRad: Array.from({ length: GRID }, (_, i) => steerAt((i + 0.5) / GRID)),
  elapsedS: Array.from({ length: GRID }, (_, i) => i * 0.1),
  lapTimeS: seconds(100),
});

/** A corner as a smooth bump of `width` in pct centred on `at`. */
const bump = (p: number, at: number, width: number, amp: number): number => {
  const d = Math.abs(((p - at + 0.5 + 1) % 1) - 0.5);
  return d > width / 2 ? 0 : amp * Math.cos((d / (width / 2)) * (Math.PI / 2)) ** 2;
};

describe("smoothWrapped", () => {
  it("averages across the start/finish join, not off the end of the array", () => {
    const v = new Array<number>(100).fill(0);
    v[0] = 10;
    v[99] = 10;

    const s = smoothWrapped(v, 2);
    // Index 0 sees 98, 99, 0, 1, 2 — two of which are 10.
    expect(s[0]!).toBeCloseTo(4, 6);
    expect(s[50]!).toBe(0);
  });
});

describe("percentile", () => {
  it("takes the nearest rank", () => {
    const v = Array.from({ length: 100 }, (_, i) => i);
    expect(percentile(v, 0.98)).toBe(98);
    expect(percentile(v, 0)).toBe(0);
    expect(percentile(v, 1)).toBe(99);
  });
});

describe("severityOf", () => {
  it("puts a hairpin at the top and a flat kink at the bottom", () => {
    expect(severityOf(10, 1.4)).toBe(6);
    expect(severityOf(70, 0.1)).toBe(1);
  });

  it("stays inside 1..6 for anything it is handed", () => {
    for (const speed of [0, 5, 25, 60, 120]) {
      for (const steer of [0, 0.2, 0.8, 3]) {
        const s = severityOf(speed, steer);
        expect(s).toBeGreaterThanOrEqual(1);
        expect(s).toBeLessThanOrEqual(6);
      }
    }
  });
});

describe("detectCorners", () => {
  const threeCorners = () =>
    gridLap(
      (p) => bump(p, 0.2, 0.06, 0.8) - bump(p, 0.5, 0.06, 0.9) + bump(p, 0.8, 0.06, 0.7),
      (p) => 40 - 22 * (bump(p, 0.2, 0.06, 1) + bump(p, 0.5, 0.06, 1) + bump(p, 0.8, 0.06, 1)),
    );

  it("finds the corners that are there, numbered from start/finish", () => {
    const corners = detectCorners(threeCorners(), { steerSignRight: -1 });

    expect(corners).toHaveLength(3);
    expect(corners.map((c) => c.index)).toEqual([1, 2, 3]);
    expect(corners[0]!.apexPct).toBeCloseTo(0.2, 1);
    expect(corners[1]!.apexPct).toBeCloseTo(0.5, 1);
    expect(corners[2]!.apexPct).toBeCloseTo(0.8, 1);
  });

  it("reads direction off the measured sign, and inverts when the sign does", () => {
    const lap = threeCorners();

    const asMeasured = detectCorners(lap, { steerSignRight: -1 });
    const inverted = detectCorners(lap, { steerSignRight: 1 });

    // The middle corner is the negative-steer one.
    expect(asMeasured.map((c) => c.direction)).toEqual(["left", "right", "left"]);
    // This is the §12 failure: same lap, same corners, every direction flipped,
    // and nothing else about the output changes to give it away.
    expect(inverted.map((c) => c.direction)).toEqual(["right", "left", "right"]);
  });

  it("treats a corner sitting on start/finish as one corner, not two", () => {
    // Spa's turn 1 (§4.2) is exactly this, so it is not an edge case to skip.
    const lap = gridLap(
      (p) => bump(p, 0.0, 0.08, 0.9) + bump(p, 0.5, 0.06, 0.8),
      (p) => 40 - 22 * (bump(p, 0.0, 0.08, 1) + bump(p, 0.5, 0.06, 1)),
    );

    const corners = detectCorners(lap, { steerSignRight: -1 });

    expect(corners).toHaveLength(2);
    const wrapping = corners.find((c) => c.entryPct > 0.9);
    expect(wrapping).toBeDefined();
    expect(wrapping!.exitPct).toBeLessThan(0.1);
  });

  it("discards a blip too short to be a corner", () => {
    const lap = gridLap(
      (p) => bump(p, 0.3, 0.06, 0.9) + bump(p, 0.7, 0.002, 0.9),
      () => 40,
    );

    const corners = detectCorners(lap, { steerSignRight: -1, minLengthM: 20 });
    expect(corners).toHaveLength(1);
    expect(corners[0]!.apexPct).toBeCloseTo(0.3, 1);
  });

  it("merges two regions separated by less than the gap", () => {
    // One corner briefly dipping under threshold in the middle — a driver
    // easing off mid-corner, not two corners. The two humps are 80 m apart on
    // this 4 km lap, so the merge gap decides which reading you get.
    const lap = gridLap((p) => bump(p, 0.28, 0.03, 0.9) + bump(p, 0.33, 0.03, 0.9));

    const wide = detectCorners(lap, { steerSignRight: -1, mergeGapM: 200 });
    const narrow = detectCorners(lap, { steerSignRight: -1, mergeGapM: 10 });

    expect(wide).toHaveLength(1);
    expect(narrow).toHaveLength(2);
  });

  it("carries the diagnostics an override author needs to judge a region", () => {
    const [corner] = detectCorners(threeCorners(), { steerSignRight: -1 });

    expect(corner!.lengthM).toBeGreaterThan(20);
    expect(corner!.minSpeedMps).toBeLessThan(40);
    expect(corner!.peakSteerRad).toBeGreaterThan(0.5);
    expect(corner!.severity).toBeGreaterThanOrEqual(1);
  });

  it("runs on a lap that came through the resampler", () => {
    const samples: LapSample[] = Array.from({ length: 3000 }, (_, i) => {
      const p = i / 2999;
      return {
        tMs: i * 16,
        lapDistPct: pct(p),
        speedMps: 40 - 22 * bump(p, 0.4, 0.06, 1),
        throttle: 1,
        brake: 0,
        gear: 4,
        steerRad: bump(p, 0.4, 0.06, 0.9),
      };
    });

    const { lap } = resampleLap(samples, 2000, LENGTH);
    const corners = detectCorners(lap, { steerSignRight: -1 });

    expect(corners).toHaveLength(1);
    expect(corners[0]!.apexPct).toBeCloseTo(0.4, 1);
    expect(corners[0]!.direction).toBe("left");
  });
});
