/**
 * IRacingAdapter — the live SDK path. SPEC.md §3, §6.4, and milestone M0b.
 *
 * ## Why the import is lazy
 *
 * `@irsdk-node/native` ships prebuilds for `win32-x64` and `win32-arm64` only —
 * there is no darwin or linux build. A top-level `import "irsdk-node"` would
 * therefore make this module, and everything that transitively imports it,
 * unloadable off Windows. That would take the schemas, the engine, the replay
 * harness and the entire test suite down with it.
 *
 * So the SDK is imported inside `connect()`, behind a platform guard. The whole
 * tree stays importable, typecheckable and testable anywhere; only actually
 * talking to the sim needs Windows. Callers that want to run elsewhere use
 * `ReplayAdapter` against a recording.
 *
 * ## Why the guard stays even though the package installs fine
 *
 * `@irsdk-node/native`'s install script prints "only usable on windows, a mocked
 * SDK will be used" and installs a mock. So importing it off Windows does NOT
 * throw — it quietly hands back fabricated telemetry. That is worse than a hard
 * failure: an app that appears to connect and streams plausible-looking garbage
 * is exactly how you end up debugging a track map that was never real. The guard
 * fails loudly instead, and points at ReplayAdapter.
 *
 * The upside of `irsdk-node` specifically is that its native addon is N-API built
 * with `prebuildify --napi --electron-compat`, so there is no `electron-rebuild`
 * step — the single biggest source of pain with Electron plus native modules.
 */

import { metres, mps, pct, radians, seconds } from "@exxeed/core";

import { isTrkLoc, TRK_LOC, type TelemetryFrame, type TrkLoc } from "./frame.js";
import type { DashState, RaceCar, RaceDriver, RaceSnapshot, TyreCorner } from "./race.js";
import {
  slug,
  UnsupportedPlatformError,
  type SessionIdentity,
  type TelemetrySource,
} from "./source.js";

export const IRACING_SUPPORTED_PLATFORMS = ["win32"] as const;

export const isIRacingSupported = (): boolean =>
  (IRACING_SUPPORTED_PLATFORMS as readonly string[]).includes(process.platform);

export interface IRacingOptions {
  /** Telemetry poll rate. 60 Hz is the sim's own update rate. */
  readonly hz?: number;
}

/**
 * The subset of the SDK's telemetry map this adapter reads. Names are the SDK's,
 * verified against the header vendored in `@irsdk-node/native` (SPEC.md §6.4).
 */
interface IRacingTelemetry {
  readonly SessionTime?: { value?: number[] | number };
  readonly Lap?: { value?: number[] | number };
  readonly LapDistPct?: { value?: number[] | number };
  readonly Speed?: { value?: number[] | number };
  readonly Throttle?: { value?: number[] | number };
  readonly Brake?: { value?: number[] | number };
  readonly Gear?: { value?: number[] | number };
  readonly SteeringWheelAngle?: { value?: number[] | number };
  // Absent in practice — see the note on TelemetryFrame.lat. Read anyway, so the
  // day a sim does populate them the centreline gets the better source for free.
  readonly Lat?: { value?: number[] | number };
  readonly Lon?: { value?: number[] | number };
  readonly VelocityX?: { value?: number[] | number };
  readonly VelocityY?: { value?: number[] | number };
  readonly YawNorth?: { value?: number[] | number };
  readonly LapDist?: { value?: number[] | number };
  readonly IsOnTrack?: { value?: boolean[] | boolean };
  readonly OnPitRoad?: { value?: boolean[] | boolean };
  readonly IsInGarage?: { value?: boolean[] | boolean };
  readonly PlayerTrackSurface?: { value?: number[] | number };
  readonly PlayerCarTowTime?: { value?: number[] | number };
  readonly EnterExitReset?: { value?: number[] | number };
}

type Var = { value?: number[] | number | boolean[] | boolean } | undefined;

/**
 * The rest of the SDK's map — everything `race()` reads. Kept apart from
 * `IRacingTelemetry` because none of it reaches a `TelemetryFrame`: it is the
 * field, the fuel and the weather, read at a few hertz for the race overlays
 * and never recorded. Looked up by name, since there are sixty of them and each
 * is read in exactly one place.
 */
export type IRacingRaceTelemetry = Readonly<Record<string, Var>>;

/** Minimal shape of the `irsdk-node` instance this adapter needs. Hand-written
 *  rather than `any`-cast at the call site, per SPEC.md §3. */
interface IRacingSdk {
  startSDK(): boolean;
  stopSDK(): void;
  waitForData(timeoutMs: number): boolean;
  getTelemetry(): (IRacingTelemetry & IRacingRaceTelemetry) | null;
  getSessionData(): Promise<IRacingSessionData | null>;
  readonly sessionStatusOK: boolean;
}

/** Only the corners of the session YAML this adapter reads. */
export interface IRacingSessionData {
  readonly WeekendInfo?: {
    readonly TrackName?: string;
    readonly TrackDisplayName?: string;
    readonly TrackConfigName?: string;
    /** iRacing's own id, unique per track AND layout. This is §4.0's trackId. */
    readonly TrackID?: number;
    /** "5.51 km" — a string, units and all. */
    readonly TrackLength?: string;
  };
  readonly DriverInfo?: {
    readonly DriverCarIdx?: number;
    readonly DriverCarFuelKgPerLtr?: number;
    readonly DriverCarFuelMaxLtr?: number;
    readonly DriverCarMaxFuelPct?: number;
    readonly DriverCarEstLapTime?: number;
    readonly DriverCarSLFirstRPM?: number;
    readonly DriverCarSLShiftRPM?: number;
    readonly DriverCarSLLastRPM?: number;
    readonly DriverCarSLBlinkRPM?: number;
    readonly Drivers?: readonly {
      readonly CarIdx?: number;
      readonly CarPath?: string;
      readonly CarScreenName?: string;
      readonly UserName?: string;
      readonly CarNumber?: string;
      readonly IRating?: number;
      readonly LicString?: string;
      readonly LicColor?: number;
      readonly CarClassID?: number;
      readonly CarClassShortName?: string;
      readonly CarClassColor?: number;
      readonly CarClassEstLapTime?: number;
      readonly CarIsPaceCar?: number;
      readonly IsSpectator?: number;
    }[];
  };
  readonly SessionInfo?: {
    readonly Sessions?: readonly {
      readonly SessionNum?: number;
      readonly SessionType?: string;
      readonly SessionTrackRubberState?: string;
      /** "unlimited", or a count as a string. */
      readonly SessionLaps?: string | number;
    }[];
  };
  readonly SplitTimeInfo?: {
    readonly Sectors?: readonly { readonly SectorNum?: number; readonly SectorStartPct?: number }[];
  };
}

const first = <T>(v: T[] | T | undefined, fallback: T): T => {
  if (v === undefined) return fallback;
  return Array.isArray(v) ? (v[0] ?? fallback) : v;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How many polls connect() gives the sim to produce session data before deciding
 * it is not there. At 60 Hz this is about a second and a half — long enough to
 * ride out the gap while a session loads, short enough that a supervisor polling
 * for the sim stays responsive.
 */
const READY_ATTEMPTS = 90;

export class IRacingAdapter implements TelemetrySource {
  readonly name = "iracing";
  readonly #intervalMs: number;
  #sdk: IRacingSdk | null = null;
  #connected = false;
  #startedAtMs = 0;
  #identity: SessionIdentity | null = null;
  /** The last telemetry read, kept for `race()` — which builds from it on demand
   *  rather than on every 60 Hz tick, since nothing needs the field that often. */
  #latest: (IRacingTelemetry & IRacingRaceTelemetry) | null = null;
  #session: IRacingSessionData | null = null;
  #sessionRefresh: NodeJS.Timeout | null = null;

  constructor(options: IRacingOptions = {}) {
    this.#intervalMs = 1000 / (options.hz ?? 60);
  }

  get connected(): boolean {
    return this.#connected;
  }

  get identity(): SessionIdentity | null {
    return this.#identity;
  }

  async connect(): Promise<void> {
    if (!isIRacingSupported()) {
      throw new UnsupportedPlatformError(
        `iRacing telemetry requires Windows (@irsdk-node/native ships prebuilds for ` +
          `win32-x64 and win32-arm64 only); this is ${process.platform}. ` +
          `Use ReplayAdapter against a recording instead — see SPEC.md §9.`,
      );
    }

    // Imported here, not at module scope, so this file loads on any platform.
    const mod: unknown = await import("irsdk-node");
    const sdk = resolveSdk(mod);

    if (!sdk.startSDK()) {
      throw new Error("iRacing SDK did not start — is the sim running?");
    }

    // startSDK() succeeding does NOT mean the sim is running. It maps the shared
    // memory and returns true whether or not anything is on the other end, so an
    // app that trusts it "connects" to nothing, reports no track, and records a
    // file of pure header. The session data is the real handshake: it only
    // appears once the sim has a session mapped.
    this.#identity = await readIdentity(sdk, this.#intervalMs, READY_ATTEMPTS);
    if (this.#identity === null) {
      sdk.stopSDK();
      throw new Error(
        "the iRacing SDK is there but no session is — the sim is not running, " +
          "or it is still at the menu",
      );
    }

    this.#sdk = sdk;
    this.#connected = true;
    this.#startedAtMs = Date.now();

    // The session YAML is where the entry list lives, and entrants come and go
    // mid-session. It is parsed YAML, not a memory read, so it is refreshed on a
    // slow timer rather than alongside telemetry.
    const refresh = async (): Promise<void> => {
      try {
        this.#session = (await this.#sdk?.getSessionData()) ?? this.#session;
      } catch {
        // Keep the last good copy — a stale entry list beats none.
      }
    };
    void refresh();
    this.#sessionRefresh = setInterval(() => void refresh(), 2000);
  }

  /** The field, fuel, tyres and weather, or null before the first read. */
  /** RPM, clutch and FFB load off the last read — cheap enough for every frame. */
  dash(): DashState | null {
    const t = this.#latest;
    if (t === null) return null;
    return {
      rpm: num(t["RPM"]),
      // The SDK's Clutch is 1 fully engaged, 0 pedal to the floor.
      clutch: 1 - num(t["Clutch"], 1),
      ffb: Math.min(1, Math.abs(num(t["SteeringWheelPctTorque"]))),
    };
  }

  race(): RaceSnapshot | null {
    if (this.#latest === null || this.#session === null) return null;
    return toRaceSnapshot(this.#latest, this.#session);
  }

  async close(): Promise<void> {
    if (this.#sessionRefresh !== null) clearInterval(this.#sessionRefresh);
    this.#sessionRefresh = null;
    this.#latest = null;
    this.#connected = false;
    this.#sdk?.stopSDK();
    this.#sdk = null;
    await Promise.resolve();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<TelemetryFrame> {
    if (this.#sdk === null) throw new Error("connect() before iterating");

    while (this.#connected) {
      // waitForData is what refreshes sessionStatusOK, and getTelemetry aborts the
      // whole process (not throws) when the session data is not yet mapped — so the
      // wait must come first and the status must gate the read.
      //
      // The timeout is 0 because waitForData blocks the calling thread, and in
      // Electron that thread also pumps Chromium's message loop: a blocking wait
      // here starves IPC to the renderer, so frames reach the recorder but never
      // reach the window. Poll with sleep instead and let the wait return at once.
      const hasData = this.#sdk.waitForData(0);
      if (hasData && this.#sdk.sessionStatusOK) {
        const telemetry = this.#sdk.getTelemetry();
        if (telemetry !== null) {
          this.#latest = telemetry;
          yield toFrame(telemetry, Date.now() - this.#startedAtMs);
        }
      }
      await sleep(this.#intervalMs);
    }
  }
}

/**
 * Track and car from the session YAML, for the recording header (§9).
 *
 * Best-effort by design. The session data only appears once the sim has mapped
 * it, which is not necessarily the moment connect() is called, so this waits a
 * short while and then gives up. An unlabelled recording is a nuisance; a lap
 * that was never recorded because we insisted on a label is a lost lap.
 */
async function readIdentity(
  sdk: IRacingSdk,
  intervalMs: number,
  attempts = 20,
): Promise<SessionIdentity | null> {
  try {
    for (let i = 0; i < attempts; i++) {
      sdk.waitForData(0);
      if (sdk.sessionStatusOK) {
        const data = await sdk.getSessionData();
        const weekend = data?.WeekendInfo;
        const info = data?.DriverInfo;
        const me = info?.Drivers?.find((d) => d.CarIdx === info.DriverCarIdx);

        const trackName = weekend?.TrackName;
        if (trackName !== undefined && trackName !== "") {
          return {
            // §4.0's TrackKey, straight from the sim. configId is slugged so it
            // is stable and filesystem-safe; iRacing gives each layout its own
            // TrackID anyway, so the pair is doubly unambiguous.
            trackKey: {
              sim: "iracing",
              trackId: weekend?.TrackID ?? 0,
              configId: slug(weekend?.TrackConfigName ?? ""),
            },
            trackId: slug(trackName),
            trackName: weekend?.TrackDisplayName ?? trackName,
            trackConfig: weekend?.TrackConfigName ?? "",
            carId: slug(me?.CarPath ?? "unknown-car"),
            carName: me?.CarScreenName ?? "unknown car",
          };
        }
      }
      await sleep(intervalMs);
    }
  } catch {
    // Fall through — see the doc comment. Never let this stop a session.
  }
  return null;
}

function resolveSdk(mod: unknown): IRacingSdk {
  type Ctor = new () => IRacingSdk;
  const candidate = mod as { default?: { IRacingSDK?: Ctor }; IRacingSDK?: Ctor };
  const Sdk = candidate.IRacingSDK ?? candidate.default?.IRacingSDK;
  if (typeof Sdk !== "function") {
    throw new Error("irsdk-node did not expose IRacingSDK");
  }
  return new Sdk();
}

/**
 * SDK values → a `TelemetryFrame`. This is the I/O boundary, so it is one of the
 * few places allowed to call the unit constructors (SPEC.md §3).
 */
export function toFrame(t: IRacingTelemetry, tMs: number): TelemetryFrame {
  const surface = first(t.PlayerTrackSurface?.value, TRK_LOC.NotInWorld as number);
  const trkLoc: TrkLoc = isTrkLoc(surface) ? surface : TRK_LOC.NotInWorld;

  return {
    tMs,
    sessionTimeS: seconds(first(t.SessionTime?.value, 0)),
    lap: first(t.Lap?.value, 0),
    // LapDistPct's unit string is "%" but the value is genuinely 0..1. Do not
    // divide by 100 (SPEC.md §3).
    lapDistPct: pct(first(t.LapDistPct?.value, 0)),
    speedMps: mps(first(t.Speed?.value, 0)),
    throttle: first(t.Throttle?.value, 0),
    brake: first(t.Brake?.value, 0),
    gear: first(t.Gear?.value, 0),
    steerRad: radians(first(t.SteeringWheelAngle?.value, 0)),
    lat: first(t.Lat?.value, 0),
    lon: first(t.Lon?.value, 0),
    velocityXMps: mps(first(t.VelocityX?.value, 0)),
    velocityYMps: mps(first(t.VelocityY?.value, 0)),
    yawNorthRad: radians(first(t.YawNorth?.value, 0)),
    lapDistM: metres(first(t.LapDist?.value, 0)),
    isOnTrack: first(t.IsOnTrack?.value, false),
    onPitRoad: first(t.OnPitRoad?.value, false),
    isInGarage: first(t.IsInGarage?.value, false),
    playerTrackSurface: trkLoc,
    playerCarTowTime: first(t.PlayerCarTowTime?.value, 0),
    enterExitReset: first(t.EnterExitReset?.value, 0),
  };
}

const num = (v: Var, fallback = 0): number => {
  const raw = v?.value;
  const x = Array.isArray(raw) ? raw[0] : raw;
  return typeof x === "number" && Number.isFinite(x) ? x : fallback;
};

const at = (v: Var, i: number): number | boolean | undefined => {
  const raw = v?.value;
  return Array.isArray(raw) ? raw[i] : undefined;
};

const hex = (n: number | undefined): string =>
  `#${((n ?? 0xffffff) & 0xffffff).toString(16).padStart(6, "0")}`;

/** The SDK marks "no lap yet" as -1 or 0; either means null here. */
const lapTime = (v: number): number | null => (v > 0 ? v : null);

/** Some `%` channels arrive 0..1 and some 0..100, whatever the header says. */
const unit = (v: number): number => (v > 1 ? v / 100 : v);

/** "K. Estre" out of "Kevin Estre" — what fits in a row. */
export function shortName(full: string): string {
  const parts = full.trim().split(/\s+/);
  if (parts.length < 2) return full.trim();
  return `${parts[0]!.charAt(0)}. ${parts.slice(1).join(" ")}`;
}

/** "5.51 km" or "3.42 mi" → metres. */
export function parseTrackLength(s: string | undefined): number | null {
  if (s === undefined) return null;
  const m = /([\d.]+)\s*(km|mi)/i.exec(s);
  if (m === null) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  return m[2]!.toLowerCase() === "mi" ? value * 1609.344 : value * 1000;
}

function tyre(t: IRacingRaceTelemetry, corner: "LF" | "RF" | "LR" | "RR"): TyreCorner {
  return {
    tempC: [num(t[`${corner}tempCL`]), num(t[`${corner}tempCM`]), num(t[`${corner}tempCR`])],
    wear: [num(t[`${corner}wearL`], 1), num(t[`${corner}wearM`], 1), num(t[`${corner}wearR`], 1)],
    coldPressureKpa: num(t[`${corner}coldPressure`]),
  };
}

/**
 * SDK telemetry and session YAML → a `RaceSnapshot`. The I/O boundary for the
 * race data, as `toFrame` is for the car: every unit and every SDK quirk is
 * settled here so nothing downstream has to know about them.
 */
export function toRaceSnapshot(
  t: IRacingRaceTelemetry,
  session: IRacingSessionData,
): RaceSnapshot {
  const info = session.DriverInfo;
  const playerCarIdx = num(t["PlayerCarIdx"], info?.DriverCarIdx ?? 0);

  const drivers: RaceDriver[] = (info?.Drivers ?? [])
    // The pace car and anyone spectating are in the list but not in the race.
    .filter((d) => d.CarIsPaceCar !== 1 && d.IsSpectator !== 1 && d.CarIdx !== undefined)
    .map((d) => {
      const name = d.UserName ?? `car ${String(d.CarIdx)}`;
      return {
        carIdx: d.CarIdx!,
        name,
        shortName: shortName(name),
        carNumber: d.CarNumber ?? "",
        carName: d.CarScreenName ?? "",
        iRating: d.IRating ?? 0,
        license: d.LicString ?? "",
        licenseColor: hex(d.LicColor),
        classId: d.CarClassID ?? 0,
        className: d.CarClassShortName ?? "",
        classColor: hex(d.CarClassColor),
        classEstLapS: d.CarClassEstLapTime ?? info?.DriverCarEstLapTime ?? 0,
      };
    });

  const cars: RaceCar[] = drivers.map(({ carIdx: i }) => {
    const surface = at(t["CarIdxTrackSurface"], i);
    return {
      carIdx: i,
      position: Number(at(t["CarIdxPosition"], i) ?? 0),
      classPosition: Number(at(t["CarIdxClassPosition"], i) ?? 0),
      lap: Number(at(t["CarIdxLap"], i) ?? 0),
      lapDistPct: Number(at(t["CarIdxLapDistPct"], i) ?? 0),
      lastLapS: lapTime(Number(at(t["CarIdxLastLapTime"], i) ?? -1)),
      bestLapS: lapTime(Number(at(t["CarIdxBestLapTime"], i) ?? -1)),
      onPitRoad: at(t["CarIdxOnPitRoad"], i) === true,
      estTimeS: Number(at(t["CarIdxEstTime"], i) ?? 0),
      gapToLeaderS: Number(at(t["CarIdxF2Time"], i) ?? 0),
      inWorld: typeof surface === "number" ? surface >= 0 : false,
    };
  });

  const sessionNum = num(t["SessionNum"]);
  const current = session.SessionInfo?.Sessions?.find((s) => s.SessionNum === sessionNum);
  const lapsTotalRaw = Number(current?.SessionLaps);

  // Both "remaining" channels carry a sentinel rather than a null: 32767 laps
  // for a timed session, 604800 seconds (a week) for a lap-limited one.
  const timeRemain = num(t["SessionTimeRemain"], -1);
  const lapsRemain = num(t["SessionLapsRemainEx"], -1);

  const kgPerL = info?.DriverCarFuelKgPerLtr ?? 0.75;
  const tankL = (info?.DriverCarFuelMaxLtr ?? 0) * (info?.DriverCarMaxFuelPct ?? 1);

  const sectors = (session.SplitTimeInfo?.Sectors ?? [])
    .map((s) => s.SectorStartPct)
    .filter((p): p is number => typeof p === "number")
    .sort((a, b) => a - b);

  const bias = num(t["dcBrakeBias"], -1);

  return {
    sessionType: current?.SessionType ?? "",
    rubber: current?.SessionTrackRubberState ?? "",
    shiftLights:
      (info?.DriverCarSLShiftRPM ?? 0) > 0
        ? {
            firstRpm: info?.DriverCarSLFirstRPM ?? 0,
            shiftRpm: info?.DriverCarSLShiftRPM ?? 0,
            lastRpm: info?.DriverCarSLLastRPM ?? info?.DriverCarSLShiftRPM ?? 0,
            blinkRpm: info?.DriverCarSLBlinkRPM ?? info?.DriverCarSLShiftRPM ?? 0,
          }
        : null,
    sessionTimeRemainS: timeRemain >= 0 && timeRemain < 604_000 ? timeRemain : null,
    sessionLapsRemain: lapsRemain >= 0 && lapsRemain < 32_000 ? lapsRemain : null,
    sessionLapsTotal: Number.isFinite(lapsTotalRaw) && lapsTotalRaw > 0 ? lapsTotalRaw : null,
    playerCarIdx,
    drivers,
    cars,
    trackLengthM: parseTrackLength(session.WeekendInfo?.TrackLength),
    sectorStartPcts: sectors.length > 0 ? sectors : [0],
    fuel: {
      levelL: num(t["FuelLevel"]),
      levelPct: num(t["FuelLevelPct"]),
      useLph: num(t["FuelUsePerHour"]) / (kgPerL > 0 ? kgPerL : 0.75),
      tankL,
    },
    tyres: { lf: tyre(t, "LF"), rf: tyre(t, "RF"), lr: tyre(t, "LR"), rr: tyre(t, "RR") },
    weather: {
      airC: num(t["AirTemp"]),
      trackC: num(t["TrackTempCrew"], num(t["TrackTemp"])),
      humidity: unit(num(t["RelativeHumidity"])),
      precipitation: unit(num(t["Precipitation"])),
      windMps: num(t["WindVel"]),
      windDirRad: num(t["WindDir"]),
      wetness: num(t["TrackWetness"]),
      skies: num(t["Skies"]),
      declaredWet: num(t["WeatherDeclaredWet"]) !== 0,
    },
    spotter: num(t["CarLeftRight"]),
    // A car with no adjustable bias reports 0, which no real car runs.
    brakeBiasPct: bias > 0 ? bias : null,
    incidents: num(t["PlayerCarMyIncidentCount"]),
    repairS: num(t["PitRepairLeft"]),
    optionalRepairS: num(t["PitOptRepairLeft"]),
    playerLastLapS: lapTime(num(t["LapLastLapTime"], -1)),
    playerBestLapS: lapTime(num(t["LapBestLapTime"], -1)),
  };
}
