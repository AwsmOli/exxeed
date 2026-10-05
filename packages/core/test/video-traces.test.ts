import { describe, expect, it } from "vitest";

import {
  barFill,
  calibratePedals,
  cleanGears,
  cleanSpeeds,
  clusterGlyphs,
  findCrossings,
  GLYPH_DIMS,
  pedalFills,
  readNumbers,
  referenceFromVideo,
  referenceFromVideoSpeed,
  type Metres,
  type ReferenceLap,
} from "../src/index.js";

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

describe("reading the overlay's speed", () => {
  const glyph = (seed: number, noise = 0) =>
    Array.from({ length: GLYPH_DIMS }, (_, i) => Math.max(0, Math.min(1, ((i * (seed + 3)) % 7 > 3 ? 1 : 0) + (noise ? (((i * 13 + noise) % 5) - 2) * 0.03 : 0))));

  it("groups the same digit drawn again and again, apart from the others", () => {
    const vectors: number[] = [];
    for (let k = 0; k < 30; k++) vectors.push(...glyph(1, k), ...glyph(2, k), ...glyph(5, k));
    const c = clusterGlyphs(vectors);
    expect(c.centroids).toHaveLength(3);
    expect(c.counts).toEqual([30, 30, 30]);
    expect(c.ids[0]).not.toBe(c.ids[1]);
    expect(c.ids[0]).toBe(c.ids[3]);
  });

  it("reads each frame's number from its named digits, and gives up on an unnamed one", () => {
    // Frame 0: glyphs of groups 1, 2, 0 → "1","5","5"; frame 1: group 3 is unnamed.
    const n = readNumbers(2, [0, 0, 0, 1, 1], [1, 2, 0, 1, 3], ["5", "1", "5", null]);
    expect(n).toEqual([155, null]);
  });

  it("drops a misread far from its neighbours and fills short gaps", () => {
    const times = Array.from({ length: 12 }, (_, i) => i / 10);
    const v = [100, 101, 102, 103, 999, 105, null, null, 108, 109, 110, 111];
    const out = cleanSpeeds(times, v);
    expect(out[4]).toBeCloseTo(104);
    expect(out[6]).toBeCloseTo(106);
  });

  it("places the lap by how far the car went, not by the time", () => {
    // 1,000 m: 500 m at 72 km/h (25 s), then 500 m at 36 km/h (50 s). Braking 24–26 s in.
    const grid = 100;
    const base = {
      trackKey: { sim: "iracing", trackId: 1, configId: "1" },
      carId: "mx5-mx52016",
      lapTimeS: 90,
      gridSize: grid,
      channels: {
        speedMps: Array.from({ length: grid }, () => 15),
        throttle: Array.from({ length: grid }, () => 1),
        brake: Array.from({ length: grid }, () => 0),
        gear: Array.from({ length: grid }, () => 3),
        steerRad: Array.from({ length: grid }, () => 0),
        elapsedS: Array.from({ length: grid }, (_, i) => i * 0.9),
      },
      derivedForMapVersion: 1,
      perCorner: {},
      brakeChannelInferred: false,
    } as ReferenceLap;
    const samples = Array.from({ length: 751 }, (_, i) => {
      const t = i / 10;
      const braking = t >= 24 && t < 26;
      return { t, speedKph: t < 25 ? 72 : 36, throttle: braking ? 0 : 1, brake: braking ? 1 : 0 };
    });
    const lap = referenceFromVideoSpeed({ base, samples, lapStartS: 0, lapEndS: 75, lengthM: 1000 as Metres, corners: [] });
    // Halfway round is 25 s in — a third of the time, not half.
    expect(lap.channels.elapsedS[50]).toBeCloseTo(25, 0);
    expect(lap.channels.speedMps[25]).toBeCloseTo(20, 0);
    expect(lap.channels.speedMps[75]).toBeCloseTo(10, 0);
    // The braking sits at the halfway mark, where the car was when it braked.
    expect(lap.channels.brake[49]).toBe(1);
    expect(lap.channels.brake[46]).toBe(0);
    expect(lap.lapTimeS).toBe(75);
    // No gear was read: the base lap's.
    expect(lap.channels.gear[10]).toBe(3);

    // Fourth gear for the fast half, second after the braking.
    const geared = samples.map((s) => ({ ...s, gear: s.t < 25 ? 4 : 2 }));
    const withGear = referenceFromVideoSpeed({ base, samples: geared, lapStartS: 0, lapEndS: 75, lengthM: 1000 as Metres, corners: [] });
    expect(withGear.channels.gear[25]).toBe(4);
    expect(withGear.channels.gear[75]).toBe(2);
  });

  it("takes a gear's one-frame blips out and holds it over frames not read", () => {
    const times = Array.from({ length: 10 }, (_, i) => i / 30);
    expect(cleanGears(times, [null, 3, 3, 8, 3, null, null, 4, 4, 4])).toEqual([null, 3, 3, 3, 3, 3, 3, 4, 4, 4]);
    // Through neutral on the way down to second; a long neutral stays.
    expect(cleanGears(times, [3, 3, 0, 0, 0, 2, 2, 2, 2, 2])).toEqual([3, 3, 2, 2, 2, 2, 2, 2, 2, 2]);
    expect(cleanGears([0, 1, 2, 3, 4], [3, 0, 0, 0, 2])).toEqual([3, 0, 0, 0, 2]);
  });
});
