import { describe, expect, it } from "vitest";

import { barFill, calibratePedals, findCrossings, pedalFills, referenceFromVideo, type Metres, type ReferenceLap } from "../src/index.js";

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

describe("pedal bars from one loose box", () => {
  // A 30×60 box: brake bar in columns 10–14, throttle in 18–22, both from
  // row 54 (empty) up to row 10 (full); a trace line passes through 2–5.
  const W = 30;
  const H = 60;
  const BOTTOM = 54;
  const TOP = 10;
  const FULL = BOTTOM - TOP + 1;
  const frame = (throttle: number, brake: number, extras: { col: number; k: number; bot: number; top: number }[] = []) => {
    const runs = new Array<number>(W * 4).fill(-1);
    const bar = (x0: number, x1: number, k: number, v: number) => {
      if (v <= 0) return;
      for (let x = x0; x <= x1; x++) {
        runs[x * 4 + k] = BOTTOM;
        runs[x * 4 + k + 1] = BOTTOM - Math.round(v * FULL) + 1;
      }
    };
    bar(18, 22, 0, throttle);
    bar(10, 14, 2, brake);
    for (const e of extras) {
      runs[e.col * 4 + e.k] = e.bot;
      runs[e.col * 4 + e.k + 1] = e.top;
    }
    return runs;
  };
  const build = (list: number[][]) => ({ width: W, height: H, times: list.map((_, i) => i / 30), runs: list.flat() });

  // A lap: mostly full throttle, some braking, a trace line flashing by, and
  // the scene (a red sleeve) behind the brake bar's top half now and then.
  const frames: number[][] = [];
  for (let i = 0; i < 600; i++) {
    const phase = i % 100;
    const braking = phase >= 60 && phase < 75;
    const extras = [];
    if (i % 37 === 0) extras.push({ col: 3, k: 0, bot: 58, top: 2 });
    if (phase >= 80 && phase < 90) extras.push(...[10, 11, 12, 13, 14].map((col) => ({ col, k: 2, bot: 30, top: 12 })));
    // A red sleeve in the right of the box most of the lap, from the box's own bottom.
    if (phase < 70) extras.push(...[25, 26, 27, 28, 29].map((col) => ({ col, k: 2, bot: 59, top: 20 })));
    frames.push(frame(braking ? 0 : phase < 60 ? 1 : 0.4, braking ? 0.7 : 0, extras));
  }
  const f = build(frames);

  it("finds each bar by its colour, not a trace line passing through or a red sleeve that is there more often than the braking", () => {
    const cal = calibratePedals(f);
    expect(cal.throttle).toEqual({ x0: 18, x1: 22 });
    expect(cal.brake).toEqual({ x0: 10, x1: 14 });
  });

  it("takes empty and full from where the throttle bar sits and reaches", () => {
    const cal = calibratePedals(f);
    expect(cal.bottom).toBe(BOTTOM);
    expect(cal.top).toBe(TOP);
  });

  it("reads the fills on that scale, and not the scene behind the bar", () => {
    const fills = pedalFills(f, calibratePedals(f));
    expect(fills[10]!.throttle).toBeCloseTo(1, 1);
    expect(fills[65]!.brake).toBeCloseTo(0.7, 1);
    expect(fills[65]!.throttle).toBe(0);
    expect(fills[78]!.throttle).toBeCloseTo(0.4, 1);
    // The sleeve: lit, but not from the bar's bottom.
    expect(fills[85]!.brake).toBe(0);
  });
});
