/**
 * Garage 61 lap exports — one lap of iRacing telemetry as CSV.
 *
 * Garage 61 builds these from iRacing's disk telemetry, which is why they carry
 * `Lat` and `Lon`: the live SDK never does (§4.1.1, M0b). That makes an export
 * the most direct source of a map there is — positions, not integrated velocity
 * — and a full reference lap besides (speed, pedals, gear, steering).
 *
 * Columns used: Speed (m/s), LapDistPct (0..1), Lat, Lon, Brake, Throttle,
 * Gear, SteeringWheelAngle (radians, iRacing's sign), Yaw. Anything else is
 * ignored. There is no time column; samples are at a fixed rate (60 Hz as
 * exported — a 2:08.286 lap has 7,697 rows), so time is the row number over
 * that rate.
 */

import { metres, mps, pct, radians, seconds } from "@exxeed/core";

import { TRK_LOC, type TelemetryFrame } from "./frame.js";

export interface Garage61Options {
  /** Samples per second. Garage 61 exports at 60. */
  readonly hz?: number;
}

export class Garage61FormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Garage61FormatError";
  }
}

const REQUIRED = ["Speed", "LapDistPct", "Lat", "Lon", "Brake", "Throttle", "Gear", "SteeringWheelAngle"] as const;

/** One lap from a Garage 61 CSV, as frames the map builder and replay understand. */
export function parseGarage61Csv(text: string, options: Garage61Options = {}): TelemetryFrame[] {
  const hz = options.hz ?? 60;
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const header = lines[0]?.split(",").map((h) => h.trim()) ?? [];
  const col = new Map(header.map((h, i) => [h, i]));
  const missing = REQUIRED.filter((name) => !col.has(name));
  if (missing.length > 0) {
    throw new Garage61FormatError(`not a Garage 61 lap export: missing ${missing.join(", ")}`);
  }

  const at = (cells: string[], name: string): number => {
    const i = col.get(name);
    return i === undefined ? Number.NaN : Number(cells[i]);
  };

  const frames: TelemetryFrame[] = [];
  for (let row = 1; row < lines.length; row++) {
    const cells = lines[row]!.split(",");
    const speed = at(cells, "Speed");
    const lapDistPct = at(cells, "LapDistPct");
    if (!Number.isFinite(speed) || !Number.isFinite(lapDistPct)) {
      throw new Garage61FormatError(`row ${row + 1} is not numeric`);
    }
    const tS = (row - 1) / hz;
    const yaw = at(cells, "Yaw");
    frames.push({
      tMs: Math.round(tS * 1000),
      sessionTimeS: seconds(tS),
      lap: 1,
      lapDistPct: pct(lapDistPct),
      speedMps: mps(speed),
      throttle: at(cells, "Throttle"),
      brake: at(cells, "Brake"),
      gear: Math.round(at(cells, "Gear")),
      steerRad: radians(at(cells, "SteeringWheelAngle")),
      lat: at(cells, "Lat"),
      lon: at(cells, "Lon"),
      // Forward speed with no slip: only used if a lap somehow had no
      // positions, since the map is drawn from Lat/Lon.
      velocityXMps: mps(speed),
      velocityYMps: mps(0),
      yawNorthRad: radians(Number.isFinite(yaw) ? yaw : 0),
      // Unknown here; the map builder measures the length from the positions.
      lapDistM: metres(0),
      // An exported lap is a lap driven on track.
      isOnTrack: true,
      onPitRoad: false,
      isInGarage: false,
      playerTrackSurface: TRK_LOC.OnTrack,
      playerCarTowTime: 0,
      enterExitReset: 0,
    });
  }
  if (frames.length < 2) throw new Garage61FormatError("the export has no samples");
  return frames;
}

export interface Garage61FileInfo {
  readonly driver: string | null;
  readonly car: string | null;
  readonly track: string | null;
  readonly layout: string | null;
}

/**
 * What a Garage 61 export's file name says:
 * "Garage 61 - driver - car - track (layout) - 02.08.286 - id.csv". All null
 * for a name that does not follow the pattern — it is a hint for pre-filling a
 * form, never trusted as the answer.
 */
export function garage61FileInfo(fileName: string): Garage61FileInfo {
  const base = fileName.replace(/^.*[\\/]/, "").replace(/\.csv$/i, "");
  const parts = base.split(" - ");
  if (parts.length < 5 || !/garage\s*61/i.test(parts[0] ?? "")) {
    return { driver: null, car: null, track: null, layout: null };
  }
  const trackPart = (parts[3] ?? "").trim();
  const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(trackPart);
  return {
    driver: parts[1]?.trim() || null,
    car: parts[2]?.trim() || null,
    track: (m ? m[1] : trackPart)?.trim() || null,
    layout: m ? m[2]?.trim() || null : null,
  };
}
