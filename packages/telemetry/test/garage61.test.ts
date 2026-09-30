import { describe, expect, it } from "vitest";

import { Garage61FormatError, garage61FileInfo, parseGarage61Csv } from "@exxeed/telemetry";

const HEADER =
  "Speed,LapDistPct,Lat,Lon,Brake,Throttle,RPM,SteeringWheelAngle,Gear,Clutch,ABSActive,DRSActive,LatAccel,LongAccel,VertAccel,Yaw,YawRate,PositionType";

describe("parseGarage61Csv", () => {
  it("reads a lap export into frames, timing rows at 60 Hz", () => {
    const csv = [
      HEADER,
      "45.947235,6.1507664e-05,52.46338140469176,0.9447619468076451,0,1,6307.5503,-0.002204033,4,1,false,false,-0.39,0.98,8.85,3.140085,-0.006,3",
      "45.962257,0.00022323465,52.46338086551816,0.9447506178505725,0.25,0.5,6305.4756,-0.00027590338,3,1,false,false,-0.28,1.16,9.41,3.1399918,-0.004,3",
    ].join("\n");
    const frames = parseGarage61Csv(csv);
    expect(frames).toHaveLength(2);
    expect(frames[1]!.tMs).toBe(17); // 1/60 s
    expect(frames[1]!.lat).toBeCloseTo(52.46338086551816, 12);
    expect(frames[1]!.brake).toBe(0.25);
    expect(frames[1]!.gear).toBe(3);
    expect(frames[0]!.steerRad).toBeCloseTo(-0.002204033, 9);
    expect(frames[0]!.isOnTrack).toBe(true);
  });

  it("says plainly when a file is not a lap export", () => {
    expect(() => parseGarage61Csv("Time,Speed\n1,2")).toThrow(Garage61FormatError);
    expect(() => parseGarage61Csv(HEADER)).toThrow(/no samples/);
  });
});

describe("garage61FileInfo", () => {
  it("reads driver, car, track and layout from an export's name", () => {
    expect(
      garage61FileInfo(
        "/Users/x/Downloads/Garage 61 - Lawrence Rojas - Global Mazda MX-5 Cup - Snetterton Circuit (300) - 02.08.286 - 01KVAPBNYJGZJS2CRGE892WNQK.csv",
      ),
    ).toEqual({ driver: "Lawrence Rojas", car: "Global Mazda MX-5 Cup", track: "Snetterton Circuit", layout: "300" });
  });

  it("copes with a track that has no layout in brackets", () => {
    expect(garage61FileInfo("Garage 61 - A Driver - Ferrari 296 GT3 - Okayama International Circuit - 01.30.000 - X.csv").track).toBe(
      "Okayama International Circuit",
    );
  });

  it("returns nothing for a name that is not Garage 61's pattern", () => {
    expect(garage61FileInfo("my lap.csv")).toEqual({ driver: null, car: null, track: null, layout: null });
  });
});
