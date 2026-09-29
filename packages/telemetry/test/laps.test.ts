import { describe, expect, it } from "vitest";

import { metres, mps, pct, radians, seconds } from "@exxeed/core";
import { LapCollector, splitLaps, TRK_LOC, type TelemetryFrame } from "@exxeed/telemetry";

const HZ = 30;

/** A lap of `n` frames from the line to just short of it, on track throughout. */
function lap(lapNo: number, startMs: number, n = 300, edit: (f: TelemetryFrame, i: number) => TelemetryFrame = (f) => f): TelemetryFrame[] {
  return Array.from({ length: n }, (_, i) =>
    edit(
      {
        tMs: startMs + (i * 1000) / HZ,
        sessionTimeS: seconds((startMs + (i * 1000) / HZ) / 1000),
        lap: lapNo,
        lapDistPct: pct((i / n) * 0.999),
        speedMps: mps(40),
        throttle: 1,
        brake: 0,
        gear: 4,
        steerRad: radians(0),
        lat: 0,
        lon: 0,
        velocityXMps: mps(40),
        velocityYMps: mps(0),
        yawNorthRad: radians(0),
        lapDistM: metres(i * 10),
        isOnTrack: true,
        onPitRoad: false,
        isInGarage: false,
        playerTrackSurface: TRK_LOC.OnTrack,
        playerCarTowTime: 0,
        enterExitReset: 0,
      },
      i,
    ),
  );
}

const session = (...laps: TelemetryFrame[][]): TelemetryFrame[] => laps.flat();

describe("splitLaps", () => {
  it("emits a lap when the next one starts, with its time", () => {
    const laps = splitLaps(session(lap(1, 0), lap(2, 10_000)));
    expect(laps).toHaveLength(1);
    expect(laps[0]).toMatchObject({ lap: 1, dirty: null });
    expect(laps[0]!.lapTimeS).toBeCloseTo(299 / HZ, 3);
  });

  it("does not count a lap that did not start at the line", () => {
    const joinedLate = lap(1, 0).slice(100);
    expect(splitLaps(session(joinedLate, lap(2, 10_000)))[0]!.dirty).toMatch(/started at/);
  });

  it.each([
    ["off track", { playerTrackSurface: TRK_LOC.OffTrack }, /off track at/],
    ["pit road", { onPitRoad: true }, /on pit road/],
    ["towed", { playerCarTowTime: 12 }, /towed/],
    ["not on track", { isOnTrack: false }, /not on track/],
  ])("marks a lap with a moment %s as dirty", (_, patch, reason) => {
    const dirty = lap(1, 0, 300, (f, i) => (i === 150 ? { ...f, ...patch } : f));
    expect(splitLaps(session(dirty, lap(2, 10_000)))[0]!.dirty).toMatch(reason);
  });

  it("catches a pause and a reset backwards", () => {
    const paused = lap(1, 0, 300, (f, i) => (i >= 150 ? { ...f, tMs: f.tMs + 5000 } : f));
    expect(splitLaps(session(paused, lap(2, 20_000)))[0]!.dirty).toMatch(/gap in telemetry/);

    const reset = lap(1, 0, 300, (f, i) => (i === 200 ? { ...f, lapDistPct: pct(0.3) } : f));
    expect(splitLaps(session(reset, lap(2, 20_000)))[0]!.dirty).toMatch(/went backwards/);
  });

  it("ignores a lap abandoned by a jump in the lap counter", () => {
    expect(splitLaps(session(lap(1, 0), lap(5, 10_000)))).toEqual([]);
  });

  it("works incrementally", () => {
    const collector = new LapCollector();
    const out = session(lap(1, 0), lap(2, 10_000), lap(3, 20_000)).map((f) => collector.push(f)).filter((l) => l !== null);
    expect(out.map((l) => l!.lap)).toEqual([1, 2]);
  });
});
