import { describe, expect, it } from "vitest";

import { GapHistory, type GapTrend } from "@exxeed/assistant";

import { rel, view, withGaps } from "./fixture.js";

const LAP_S = 100;

/**
 * Feed `seconds` of views at 5 Hz, the gaps a function of time. With `onTrack`
 * the views say where on a 100 s lap the player is, as live ones do.
 */
function run(
  history: GapHistory,
  seconds: number,
  gaps: (t: number) => { ahead: number; behind: number },
  options: { from?: number; onTrack?: boolean } = {},
): void {
  const from = options.from ?? 0;
  for (let i = 0; i <= seconds * 5; i++) {
    const t = from + i / 5;
    const g = gaps(t - from);
    history.record(t, withGaps(g.ahead, g.behind, options.onTrack === true ? 3 + t / LAP_S : null));
  }
}

const perLap = (t: GapTrend | null): number | null =>
  t === null ? null : t.basis === "lap" ? t.closingPerLapS : t.closingPerS * LAP_S;

describe("GapHistory, under a lap of history", () => {
  it("says nothing until there is enough to call it a trend", () => {
    const history = new GapHistory();
    run(history, 10, () => ({ ahead: 2, behind: 1.5 }));
    expect(history.trend(2)).toBeNull();
  });

  it("reads a car behind catching up as closing", () => {
    const history = new GapHistory();
    run(history, 60, (t) => ({ ahead: 2, behind: 3 - 0.002 * t }));
    const trend = history.trend(2);
    expect(trend?.basis).toBe("window");
    expect(perLap(trend)).toBeCloseTo(0.2, 5);
    expect(trend?.gapS).toBeCloseTo(-2.88, 5);
  });

  it("reads a car ahead being caught as closing too", () => {
    const history = new GapHistory();
    run(history, 60, (t) => ({ ahead: 4 - 0.005 * t, behind: 1.5 }));
    expect(perLap(history.trend(0))).toBeCloseTo(0.5, 5);
  });

  it("reads a growing gap as negative, either side", () => {
    const history = new GapHistory();
    run(history, 60, (t) => ({ ahead: 2 + 0.01 * t, behind: 1.5 + 0.01 * t }));
    expect(perLap(history.trend(0))).toBeCloseTo(-1, 5);
    expect(perLap(history.trend(2))).toBeCloseTo(-1, 5);
  });

  it("still works from a view that does not say where on the lap the player is", () => {
    const history = new GapHistory();
    run(history, 250, (t) => ({ ahead: 2, behind: 5 - 0.002 * t }));
    expect(history.trend(2)?.basis).toBe("window");
  });
});

describe("GapHistory, lap over lap", () => {
  /** ±0.3 s through the lap, the same every lap: one car quicker in the fast half. */
  const breathing = (t: number): number => 0.3 * Math.sin((t / LAP_S) * 2 * Math.PI);

  it("is not fooled by a gap that breathes within the lap", () => {
    const history = new GapHistory();
    run(history, 130, (t) => ({ ahead: 2, behind: 1.5 + breathing(t) }), { onTrack: true });
    const trend = history.trend(2);
    expect(trend?.basis).toBe("lap");
    expect(perLap(trend)).toBeCloseTo(0, 5);
  });

  it("finds the real change underneath the breathing", () => {
    const history = new GapHistory();
    run(history, 130, (t) => ({ ahead: 4 - 0.003 * t + breathing(t), behind: 5 - 0.002 * t + breathing(t) }), {
      onTrack: true,
    });
    expect(perLap(history.trend(2))).toBeCloseTo(0.2, 5);
    expect(perLap(history.trend(0))).toBeCloseTo(0.3, 5);
  });

  it("the fitted line over the same data would have got it wrong", () => {
    // The reason lap-over-lap exists: before a lap is up, the same steady gap
    // reads as a trend. Pinned so the fallback's weakness stays a known one.
    const history = new GapHistory();
    run(history, 60, (t) => ({ ahead: 2, behind: 1.5 + breathing(t) }), { onTrack: true });
    const trend = history.trend(2);
    expect(trend?.basis).toBe("window");
    expect(Math.abs(perLap(trend) ?? 0)).toBeGreaterThan(0.3);
  });

  it("keeps a lap of history however long the lap is", () => {
    // An eight-minute lap: far longer than the time-based keep.
    const history = new GapHistory();
    for (let i = 0; i <= 520 * 5; i++) {
      const t = i / 5;
      history.record(t, withGaps(2, 6 - 0.001 * t, 3 + t / 480));
    }
    const trend = history.trend(2);
    expect(trend?.basis).toBe("lap");
    expect(perLap(trend)).toBeCloseTo(0.48, 5);
  });
});

describe("GapHistory, discontinuities", () => {
  it("starts again after a jump rather than measuring across it", () => {
    const history = new GapHistory();
    run(history, 30, () => ({ ahead: 2, behind: 1.5 }));
    // The car behind spins: 1.5 s becomes 9 s between two samples.
    run(history, 5, () => ({ ahead: 2, behind: 9 }), { from: 30.2 });
    expect(history.trend(2)).toBeNull();
    expect(history.trend(0)).not.toBeNull();
  });

  it("starts again when the player goes backwards along the lap", () => {
    const history = new GapHistory();
    run(history, 30, () => ({ ahead: 2, behind: 1.5 }), { onTrack: true });
    history.record(30.2, withGaps(2, 1.5, 3.05));
    expect(history.trend(2)).toBeNull();
  });

  it("forgets everything when the clock goes backwards", () => {
    const history = new GapHistory();
    run(history, 30, () => ({ ahead: 2, behind: 1.5 }));
    history.record(0, withGaps(2, 1.5));
    expect(history.trend(0)).toBeNull();
  });

  it("does not track a car in the pits, or anyone while the player is", () => {
    const history = new GapHistory();
    const pitted = view({
      relatives: [
        rel({ carIdx: 0, gapS: 2, onPitRoad: true }),
        rel({ carIdx: 1, gapS: 0, isPlayer: true }),
        rel({ carIdx: 2, gapS: -1.5 }),
      ],
    });
    for (let i = 0; i <= 150; i++) history.record(i / 5, pitted);
    expect(history.trend(0)).toBeNull();
    expect(history.trend(2)).not.toBeNull();

    history.record(31, view({ relatives: [rel({ carIdx: 1, gapS: 0, isPlayer: true, onPitRoad: true })] }));
    expect(history.trend(2)).toBeNull();
  });

  it("forgets on a null view", () => {
    const history = new GapHistory();
    run(history, 30, () => ({ ahead: 2, behind: 1.5 }));
    history.record(31, null);
    expect(history.trend(0)).toBeNull();
  });
});
