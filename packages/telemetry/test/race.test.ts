import { describe, expect, it } from "vitest";

import {
  FuelTracker,
  lapsRemaining,
  parseTrackLength,
  pctDelta,
  relativeGapS,
  shortName,
  SPOTTER,
  strengthOfField,
  toRaceSnapshot,
  type IRacingRaceTelemetry,
  type IRacingSessionData,
} from "@exxeed/telemetry";

const v = (value: number | boolean | (number | boolean)[]) => ({ value } as never);

describe("relativeGapS", () => {
  it("is positive for a car ahead", () => {
    expect(relativeGapS(10, 12.5, 90)).toBeCloseTo(2.5);
  });

  it("wraps across the line, so a car just over it reads as just ahead", () => {
    // Me at 89 s into a 90 s lap, them at 1 s into the next: 2 s ahead, not 88 behind.
    expect(relativeGapS(89, 1, 90)).toBeCloseTo(2);
    expect(relativeGapS(1, 89, 90)).toBeCloseTo(-2);
  });
});

describe("pctDelta", () => {
  it("takes the short way round", () => {
    expect(pctDelta(0.02, 0.98)).toBeCloseTo(0.04);
    expect(pctDelta(0.98, 0.02)).toBeCloseTo(-0.04);
  });
});

describe("strengthOfField", () => {
  it("is the field's rating when everyone has the same one", () => {
    expect(strengthOfField([2000, 2000, 2000])).toBe(2000);
  });

  it("ignores unrated entries rather than dragging the number to zero", () => {
    expect(strengthOfField([3000, 0, 3000])).toBe(3000);
    expect(strengthOfField([0])).toBeNull();
  });

  it("sits between the extremes, below the mean — iRacing's formula weights the field's weaker end", () => {
    // 1600/ln2 · ln(2 / (e^(−1000/2308.3) + e^(−5000/2308.3))) ≈ 2224.
    expect(strengthOfField([1000, 5000])).toBe(2224);
  });
});

describe("FuelTracker", () => {
  it("learns per-lap use from the level at each crossing", () => {
    const t = new FuelTracker();
    t.update(1, 50, false);
    t.update(2, 47, false);
    t.update(3, 44.2, false);
    const e = t.estimate(44.2, 10);
    expect(e.lapsSampled).toBe(2);
    expect(e.perLapL).toBeCloseTo(2.9);
    expect(e.lastLapL).toBeCloseTo(2.8);
    expect(e.maxLapL).toBeCloseTo(3);
    expect(e.toFinishL).toBeCloseTo(29);
    expect(e.marginL).toBeCloseTo(15.2);
  });

  it("does not count a lap that touched the pits", () => {
    const t = new FuelTracker();
    t.update(1, 50, false);
    t.update(1, 49, true);
    t.update(2, 60, true); // refuelled
    t.update(3, 57, false);
    expect(t.estimate(57, null).lapsSampled).toBe(0);
    t.update(4, 54, false);
    expect(t.estimate(54, null).perLapL).toBeCloseTo(3);
  });

  it("does not count a jump of several laps", () => {
    const t = new FuelTracker();
    t.update(1, 50, false);
    t.update(4, 41, false);
    expect(t.estimate(41, null).lapsSampled).toBe(0);
  });

  it("says nothing before it has a lap", () => {
    const e = new FuelTracker().estimate(40, 12);
    expect(e.perLapL).toBeNull();
    expect(e.toFinishL).toBeNull();
    expect(e.marginL).toBeNull();
  });
});

describe("lapsRemaining", () => {
  it("uses the lap count when the session has one", () => {
    expect(lapsRemaining({ sessionLapsRemain: 12, sessionTimeRemainS: null }, 90)).toBe(12);
  });

  it("divides the clock by a lap, rounding up, when it does not", () => {
    expect(lapsRemaining({ sessionLapsRemain: null, sessionTimeRemainS: 1000 }, 90)).toBe(12);
  });

  it("gives up without a lap time", () => {
    expect(lapsRemaining({ sessionLapsRemain: null, sessionTimeRemainS: 1000 }, null)).toBeNull();
  });
});

describe("parsing", () => {
  it("reads iRacing's track length strings", () => {
    expect(parseTrackLength("5.51 km")).toBeCloseTo(5510);
    expect(parseTrackLength("3.56 mi")).toBeCloseTo(5729.26, 1);
    expect(parseTrackLength(undefined)).toBeNull();
    expect(parseTrackLength("far")).toBeNull();
  });

  it("shortens names to what fits in a row", () => {
    expect(shortName("Kevin Estre")).toBe("K. Estre");
    expect(shortName("Antonio Pier Guidi")).toBe("A. Pier Guidi");
    expect(shortName("Cher")).toBe("Cher");
  });
});

describe("toRaceSnapshot", () => {
  const session: IRacingSessionData = {
    WeekendInfo: { TrackName: "spa", TrackLength: "7.00 km" },
    DriverInfo: {
      DriverCarIdx: 1,
      DriverCarFuelKgPerLtr: 0.75,
      DriverCarFuelMaxLtr: 100,
      DriverCarMaxFuelPct: 1,
      DriverCarEstLapTime: 138,
      Drivers: [
        { CarIdx: 0, UserName: "Pace Car", CarIsPaceCar: 1 },
        {
          CarIdx: 1,
          UserName: "Ada Lovelace",
          CarNumber: "7",
          IRating: 2850,
          LicString: "A 3.12",
          LicColor: 0x0153db,
          CarClassID: 11,
          CarClassShortName: "GT3",
          CarClassColor: 0xffda59,
          CarClassEstLapTime: 138,
        },
        { CarIdx: 2, UserName: "Grace Hopper", CarNumber: "12", IRating: 3100, CarClassID: 11 },
        { CarIdx: 3, UserName: "Spectator", IsSpectator: 1 },
      ],
    },
    SessionInfo: { Sessions: [{ SessionNum: 2, SessionType: "Race", SessionLaps: "20" }] },
    SplitTimeInfo: { Sectors: [{ SectorStartPct: 0.5 }, { SectorStartPct: 0 }] },
  };

  const telemetry: IRacingRaceTelemetry = {
    PlayerCarIdx: v(1),
    SessionNum: v(2),
    SessionTimeRemain: v(604800),
    SessionLapsRemainEx: v(14),
    CarIdxPosition: v([0, 2, 1, 0]),
    CarIdxClassPosition: v([0, 2, 1, 0]),
    CarIdxLap: v([0, 6, 6, 0]),
    CarIdxLapDistPct: v([0, 0.4, 0.45, 0]),
    CarIdxLastLapTime: v([0, 139.2, 138.8, 0]),
    CarIdxBestLapTime: v([0, -1, 138.1, 0]),
    CarIdxOnPitRoad: v([false, false, true, false]),
    CarIdxEstTime: v([0, 55, 62, 0]),
    CarIdxF2Time: v([0, 3.2, 0, 0]),
    CarIdxTrackSurface: v([-1, 3, 3, -1]),
    FuelLevel: v(40),
    FuelLevelPct: v(0.4),
    FuelUsePerHour: v(75),
    RelativeHumidity: v(46),
    AirTemp: v(21),
    TrackTempCrew: v(31),
    CarLeftRight: v(SPOTTER.left),
    dcBrakeBias: v(0),
    PitRepairLeft: v(12),
    LFtempCM: v(88),
    LFwearL: v(0.9),
  };

  const snapshot = toRaceSnapshot(telemetry, session);

  it("drops the pace car and spectators from the field", () => {
    expect(snapshot.drivers.map((d) => d.carIdx)).toEqual([1, 2]);
    expect(snapshot.cars.map((c) => c.carIdx)).toEqual([1, 2]);
  });

  it("reads each car's slot out of the CarIdx arrays", () => {
    const grace = snapshot.cars.find((c) => c.carIdx === 2)!;
    expect(grace.position).toBe(1);
    expect(grace.onPitRoad).toBe(true);
    expect(grace.bestLapS).toBeCloseTo(138.1);
    expect(grace.inWorld).toBe(true);
    // -1 is the SDK's "no lap yet", not a lap time.
    expect(snapshot.cars.find((c) => c.carIdx === 1)!.bestLapS).toBeNull();
  });

  it("formats the colours and names a row needs", () => {
    const ada = snapshot.drivers.find((d) => d.carIdx === 1)!;
    expect(ada.classColor).toBe("#ffda59");
    expect(ada.licenseColor).toBe("#0153db");
    expect(ada.shortName).toBe("A. Lovelace");
  });

  it("turns the SDK's sentinels into nulls", () => {
    // 604800 s is "no clock" — this session is lap-limited.
    expect(snapshot.sessionTimeRemainS).toBeNull();
    expect(snapshot.sessionLapsRemain).toBe(14);
    expect(snapshot.sessionLapsTotal).toBe(20);
    // A car with no adjustable bias reports 0.
    expect(snapshot.brakeBiasPct).toBeNull();
  });

  it("settles units at the boundary", () => {
    // kg/h → L/h, at the car's own density.
    expect(snapshot.fuel.useLph).toBeCloseTo(100);
    expect(snapshot.fuel.tankL).toBe(100);
    // A "%" channel that arrived as 0..100.
    expect(snapshot.weather.humidity).toBeCloseTo(0.46);
    expect(snapshot.trackLengthM).toBeCloseTo(7000);
  });

  it("sorts the sectors and keeps the spotter", () => {
    expect(snapshot.sectorStartPcts).toEqual([0, 0.5]);
    expect(snapshot.spotter).toBe(SPOTTER.left);
    expect(snapshot.repairS).toBe(12);
    expect(snapshot.tyres.lf.tempC[1]).toBe(88);
  });
});
