import { describe, expect, it } from "vitest";

import { barFill, findCrossings, referenceFromVideo, type Metres, type ReferenceLap } from "../src/index.js";

describe("barFill", () => {
  it("is the lit run from the empty end", () => {
    expect(barFill([1, 1, 0.9, 0.2, 0, 0, 0, 0, 0, 0])).toBeCloseTo(0.3);
    expect(barFill([])).toBe(0);
    expect(barFill([0, 0, 0, 0, 0])).toBe(0);
  });

  it("steps over a thin dark edge at the bottom of the box", () => {
    expect(barFill([0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBeCloseTo(0.4);
  });

  it("is not ended by a line or two of noise", () => {
    expect(barFill([1, 1, 1, 0, 1, 1, 0, 0, 0, 0])).toBeCloseTo(0.6);
  });

  it("does not count what shows through above the fill", () => {
    // A quarter filled, then a red sleeve behind the see-through top half.
    expect(barFill([1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1])).toBeCloseTo(3 / 16);
  });
});

describe("findCrossings", () => {
  const noise = (t: number) => ({ t, diff: 0.01 + 0.005 * Math.sin(t * 7) });

  it("finds the frames where a quiet box suddenly changes", () => {
    const frames = Array.from({ length: 300 * 30 }, (_, i) => noise(i / 30));
    frames[30 * 12] = { t: 12, diff: 0.4 };
    frames[30 * 140] = { t: 140, diff: 0.35 };
    expect(findCrossings(frames)).toEqual([12, 140]);
  });

  it("treats a change spread over a few frames as one crossing, at its strongest", () => {
    const frames = Array.from({ length: 60 * 30 }, (_, i) => noise(i / 30));
    frames[300] = { t: 10, diff: 0.2 };
    frames[301] = { t: 10 + 1 / 30, diff: 0.5 };
    frames[302] = { t: 10 + 2 / 30, diff: 0.3 };
    expect(findCrossings(frames)).toEqual([10 + 1 / 30]);
  });
});

describe("referenceFromVideo", () => {
  const grid = 100;
  const base: ReferenceLap = {
    trackKey: { sim: "iracing", trackId: 1, configId: "1" },
    carId: "mx5-mx52016",
    lapTimeS: 100,
    gridSize: grid,
    channels: {
      speedMps: Array.from({ length: grid }, () => 40),
      throttle: Array.from({ length: grid }, () => 1),
      brake: Array.from({ length: grid }, () => 0),
      gear: Array.from({ length: grid }, () => 3),
      steerRad: Array.from({ length: grid }, () => 0),
      elapsedS: Array.from({ length: grid }, (_, i) => i),
    },
    derivedForMapVersion: 1,
    perCorner: {},
    brakeChannelInferred: true,
  };
  // Brake from 30 s to 40 s into the video's lap, which starts 5 s in and lasts 110 s.
  const samples = Array.from({ length: 1200 }, (_, i) => {
    const t = i / 10;
    const inLap = t - 5;
    const braking = inLap >= 30 && inLap < 40;
    return { t, throttle: braking ? 0 : 1, brake: braking ? 0.8 : 0 };
  });

  it("stretches the base lap's time and speed to the video's lap", () => {
    const lap = referenceFromVideo({ base, samples, lapStartS: 5, lapEndS: 115, lengthM: 4000 as Metres, corners: [] });
    expect(lap.lapTimeS).toBeCloseTo(110);
    expect(lap.channels.elapsedS[50]).toBeCloseTo(55);
    expect(lap.channels.speedMps[0]).toBeCloseTo(40 / 1.1);
    expect(lap.channels.gear[0]).toBe(3);
    expect(lap.brakeChannelInferred).toBe(false);
  });

  it("puts the video's braking where the video brakes", () => {
    const lap = referenceFromVideo({ base, samples, lapStartS: 5, lapEndS: 115, lengthM: 4000 as Metres, corners: [] });
    // 30–40 s of a 110 s lap: grid cells 27.3–36.4.
    expect(lap.channels.brake[26]).toBe(0);
    expect(lap.channels.brake[30]).toBeCloseTo(0.8);
    expect(lap.channels.throttle[30]).toBe(0);
    expect(lap.channels.brake[40]).toBe(0);
  });

  it("refuses a lap that ends before it starts", () => {
    expect(() => referenceFromVideo({ base, samples, lapStartS: 50, lapEndS: 10, lengthM: 4000 as Metres, corners: [] })).toThrow();
  });
});
