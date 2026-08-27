import { describe, expect, it } from "vitest";

import { buildCentreline, CentrelineError, metres, pct, type CentrelineSample } from "@exxeed/core";

const LENGTH = metres(2000);

/**
 * A car driving a closed loop at constant speed.
 *
 * `turn` is the steering the driver is holding; the heading is swept in the
 * direction that steering implies, so the samples are internally consistent.
 * With `steerSignRight = -1`, a positive steer is a left, and a left is a
 * counter-clockwise loop, which is a *decreasing* compass bearing.
 */
const loop = (turn: "left" | "right", n = 1200): CentrelineSample[] => {
  const speed = 30;
  const dtS = 0.05;
  const circumference = speed * dtS * n;
  const omega = (2 * Math.PI) / (n * dtS); // one full revolution over the lap
  const sense = turn === "left" ? -1 : 1;

  return Array.from({ length: n }, (_, i) => ({
    tMs: i * dtS * 1000,
    lapDistPct: pct(i / n),
    velocityXMps: speed,
    velocityYMps: 0,
    yawNorthRad: sense * omega * i * dtS,
    steerRad: turn === "left" ? 0.5 : -0.5,
    _circumference: circumference,
  })) as CentrelineSample[];
};

describe("buildCentreline", () => {
  it("draws a closed loop on the requested grid", () => {
    const r = buildCentreline(loop("left"), 500, LENGTH, { steerSignRight: -1 });

    expect(r.centreline.gridSize).toBe(500);
    expect(r.centreline.x).toHaveLength(500);
    expect(r.centreline.y).toHaveLength(500);
    expect(r.centreline.x.every(Number.isFinite)).toBe(true);
    expect(r.centreline.y.every(Number.isFinite)).toBe(true);
  });

  it("integrates a path length close to the real one", () => {
    const r = buildCentreline(loop("left"), 500, LENGTH, { steerSignRight: -1 });
    // 1200 samples * 0.05 s * 30 m/s, minus the first interval.
    expect(r.pathLengthM).toBeGreaterThan(1750);
    expect(r.pathLengthM).toBeLessThan(1850);
  });

  it("agrees with the steering whichever way the lap turns", () => {
    const left = buildCentreline(loop("left"), 500, LENGTH, { steerSignRight: -1 });
    const right = buildCentreline(loop("right"), 500, LENGTH, { steerSignRight: -1 });

    // Both are internally consistent laps, so both resolve at the same yaw sense.
    // A left-hand circuit does not imply a different convention from a right-hand
    // one — that was the mistake the closure heuristic made.
    expect(left.orientationAgreement).toBeGreaterThan(0.95);
    expect(right.orientationAgreement).toBeGreaterThan(0.95);
    expect(left.yawSign).toBe(right.yawSign);
  });

  it("flips the yaw sense when the sim reports heading the other way round", () => {
    // Same driving, opposite heading convention — which is exactly the ambiguity
    // this is here to resolve, and what would otherwise mirror the map.
    const flipped = loop("left").map((s) => ({ ...s, yawNorthRad: -s.yawNorthRad }));

    const normal = buildCentreline(loop("left"), 500, LENGTH, { steerSignRight: -1 });
    const other = buildCentreline(flipped, 500, LENGTH, { steerSignRight: -1 });

    expect(other.yawSign).toBe(normal.yawSign === 1 ? -1 : 1);
    expect(other.orientationAgreement).toBeGreaterThan(0.95);
  });

  it("refuses to emit a mirrored map", () => {
    // Heading sweeps one way while the driver holds lock the other — no yaw sense
    // can reconcile that, and the honest answer is to refuse rather than draw a
    // plausible circuit with every left turned into a right (§12).
    const contradictory = loop("left").map((s, i) => ({
      ...s,
      // Alternate the claimed steering so neither sense can agree.
      steerRad: i % 2 === 0 ? 0.5 : -0.5,
    }));

    expect(() => buildCentreline(contradictory, 500, LENGTH, { steerSignRight: -1 })).toThrow(
      CentrelineError,
    );
    expect(() => buildCentreline(contradictory, 500, LENGTH, { steerSignRight: -1 })).toThrow(
      /may be\s+mirrored/,
    );
  });

  it("rejects a lap recorded before the velocity channels existed", () => {
    // These parse fine and integrate to a single point — a centreline of 2000
    // identical points is a valid-looking artefact that draws nothing.
    const old = loop("left").map((s) => ({ ...s, velocityXMps: 0, velocityYMps: 0 }));

    expect(() => buildCentreline(old, 500, LENGTH, { steerSignRight: -1 })).toThrow(CentrelineError);
    expect(() => buildCentreline(old, 500, LENGTH, { steerSignRight: -1 })).toThrow(
      /predates them|velocity channels/,
    );
  });

  it("rejects a nonsense grid or too few samples", () => {
    expect(() => buildCentreline(loop("left"), 1, LENGTH, { steerSignRight: -1 })).toThrow(/gridSize/);
    expect(() => buildCentreline([], 100, LENGTH, { steerSignRight: -1 })).toThrow(/at least 2/);
  });

  it("closes the loop it returns, whatever the raw drift was", () => {
    const r = buildCentreline(loop("left"), 500, LENGTH, { steerSignRight: -1 });
    const { x, y } = r.centreline;

    // After the correction the last grid point sits near the first. The gap is
    // one grid cell of travel, not accumulated drift.
    const gap = Math.hypot(x[x.length - 1]! - x[0]!, y[y.length - 1]! - y[0]!);
    expect(gap).toBeLessThan(LENGTH / 100);
  });
});
