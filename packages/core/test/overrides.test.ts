import { describe, expect, it } from "vitest";

import {
  applyOverrides,
  CornerOverrideError,
  CornerOverridesSchema,
  metres,
  pct,
  type DetectedCorner,
} from "@exxeed/core";

const corner = (
  index: number,
  entry: number,
  apex: number,
  exit: number,
  direction: "left" | "right" = "left",
  peak = 0.5,
): DetectedCorner => ({
  index,
  entryPct: pct(entry),
  apexPct: pct(apex),
  exitPct: pct(exit),
  direction,
  severity: 3,
  lengthM: metres((exit - entry) * 4000),
  minSpeedMps: 30,
  peakSteerRad: peak,
  meanSteerRad: direction === "right" ? -peak : peak,
});

const parse = (ops: unknown[]) => CornerOverridesSchema.parse({ schema: 1, operations: ops });
const none = parse([]);

const three = [corner(1, 0.1, 0.12, 0.15), corner(2, 0.3, 0.32, 0.35), corner(3, 0.6, 0.62, 0.65)];

describe("applyOverrides", () => {
  it("passes detection through untouched when there is nothing to correct", () => {
    const out = applyOverrides(three, none);

    expect(out).toHaveLength(3);
    expect(out.map((c) => c.index)).toEqual([1, 2, 3]);
    expect(out[0]!.entryPct).toBeCloseTo(0.1, 6);
  });

  it("merges regions into one corner spanning entry to exit", () => {
    const out = applyOverrides(three, parse([{ op: "merge", indices: [1, 2] }]));

    expect(out).toHaveLength(2);
    expect(out[0]!.entryPct).toBeCloseTo(0.1, 6);
    expect(out[0]!.exitPct).toBeCloseTo(0.35, 6);
  });

  it("keeps the direction of the part that turned hardest when merging", () => {
    // Daytona's T6: a small left flick immediately before a hard right. The
    // merged corner is a right — the flick is its entry, not its character.
    const flickThenRight = [corner(1, 0.28, 0.288, 0.289, "left", 0.15), corner(2, 0.294, 0.31, 0.325, "right", 1.03)];

    const out = applyOverrides(flickThenRight, parse([{ op: "merge", indices: [1, 2] }]));

    expect(out).toHaveLength(1);
    expect(out[0]!.direction).toBe("right");
    expect(out[0]!.apexPct).toBeCloseTo(0.31, 6);
    expect(out[0]!.entryPct).toBeCloseTo(0.28, 6);
  });

  it("splits one region into several at the given points", () => {
    const out = applyOverrides(three, parse([{ op: "split", index: 2, atPct: [0.32] }]));

    expect(out).toHaveLength(4);
    expect(out[1]!.entryPct).toBeCloseTo(0.3, 6);
    expect(out[1]!.exitPct).toBeCloseTo(0.32, 6);
    expect(out[2]!.entryPct).toBeCloseTo(0.32, 6);
    expect(out[2]!.exitPct).toBeCloseTo(0.35, 6);
  });

  it("reads each split piece's direction off its own steering", () => {
    // Daytona's T9/T10: detection averaged a left and a right into one "right".
    // Splitting has to recover both, or the split is pointless.
    const GRID = 1000;
    const steerRad = new Array<number>(GRID).fill(0);
    const speedMps = new Array<number>(GRID).fill(40);
    for (let i = 650; i < 674; i++) steerRad[i] = 0.47; // left
    for (let i = 674; i < 700; i++) steerRad[i] = -0.68; // right
    speedMps[660] = 30;
    speedMps[690] = 28;

    const merged = [corner(1, 0.65, 0.6837, 0.6995, "right", 0.68)];
    const out = applyOverrides(merged, parse([{ op: "split", index: 1, atPct: [0.674] }]), {
      gridSize: GRID,
      speedMps,
      steerRad,
    });

    expect(out).toHaveLength(2);
    expect(out[0]!.direction).toBe("left");
    expect(out[1]!.direction).toBe("right");
  });

  it("drops a region that is not a corner", () => {
    const out = applyOverrides(three, parse([{ op: "drop", index: 2 }]));

    expect(out).toHaveLength(2);
    expect(out.map((c) => c.entryPct.toFixed(2))).toEqual(["0.10", "0.60"]);
  });

  it("renames without otherwise touching the corner", () => {
    const out = applyOverrides(three, parse([{ op: "rename", index: 1, names: ["International Horseshoe"] }]));

    expect(out[0]!.names).toEqual(["International Horseshoe"]);
    expect(out[0]!.entryPct).toBeCloseTo(0.1, 6);
  });

  it("inserts a corner detection missed entirely", () => {
    const out = applyOverrides(
      three,
      parse([
        { op: "insert", entryPct: 0.45, apexPct: 0.46, exitPct: 0.47, direction: "right", severity: 2, names: ["kink"] },
      ]),
    );

    expect(out).toHaveLength(4);
    expect(out[2]!.names).toEqual(["kink"]);
    expect(out[2]!.direction).toBe("right");
  });

  it("renumbers 1..n in track order whatever the operations did", () => {
    const out = applyOverrides(
      three,
      parse([
        { op: "split", index: 3, atPct: [0.62] },
        { op: "merge", indices: [1, 2] },
      ]),
    );

    expect(out.map((c) => c.index)).toEqual([1, 2, 3]);
    // Ascending in track order, not in the order the operations were written.
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.entryPct).toBeGreaterThan(out[i - 1]!.entryPct);
    }
  });

  it("refuses an operation naming a corner detection did not produce", () => {
    // The common way to break an override file is to retune detection and leave
    // the indices pointing at nothing. Better to fail than to silently skip.
    expect(() => applyOverrides(three, parse([{ op: "merge", indices: [3, 9] }]))).toThrow(CornerOverrideError);
    expect(() => applyOverrides(three, parse([{ op: "drop", index: 42 }]))).toThrow(/detection produced/);
  });

  it("refuses two operations claiming the same corner", () => {
    expect(() =>
      applyOverrides(three, parse([{ op: "merge", indices: [1, 2] }, { op: "drop", index: 2 }])),
    ).toThrow(/more than one operation/);
  });

  it("refuses a split point outside the region it names", () => {
    expect(() => applyOverrides(three, parse([{ op: "split", index: 1, atPct: [0.5] }]))).toThrow(/outside/);
  });
});
