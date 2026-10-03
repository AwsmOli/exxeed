/**
 * The race around the car — the field, the fuel, the tyres, the weather.
 *
 * Deliberately NOT part of `TelemetryFrame`. That frame is the driver's own car
 * at 60 Hz, it is what gets recorded (§9), and it is what the engine ticks on.
 * Sixty-four cars' worth of positions and lap times per sample would multiply
 * the size of every recording for data no callout ever reads, and none of it
 * changes fast enough to need 60 Hz on screen. So this is a separate, slower
 * snapshot a source MAY offer: the live sim can, a replay of an older
 * recording cannot, and every overlay that draws from it has to cope with it
 * being absent.
 *
 * SI throughout, like the frame (§3): seconds, metres, m/s, litres, °C, kPa.
 * The one exception is that fuel use comes off the SDK in kg/h and is converted
 * here, at the boundary, using the car's own fuel density.
 */

/** One entrant, from the session YAML. Changes when someone joins or leaves. */
export interface RaceDriver {
  readonly carIdx: number;
  readonly name: string;
  /** "K. Estre" — what fits in a row. Falls back to `name`. */
  readonly shortName: string;
  readonly carNumber: string;
  readonly carName: string;
  readonly iRating: number;
  /** "A 3.45" — the SDK's own string. */
  readonly license: string;
  /** #rrggbb. */
  readonly licenseColor: string;
  readonly classId: number;
  readonly className: string;
  /** #rrggbb. */
  readonly classColor: string;
  /** The class's estimated lap time, seconds — what relative gaps wrap on. */
  readonly classEstLapS: number;
}

/** One car's live state, from the `CarIdx*` arrays. */
export interface RaceCar {
  readonly carIdx: number;
  /** Overall position, 1-based. 0 means the sim has not classified it yet. */
  readonly position: number;
  readonly classPosition: number;
  readonly lap: number;
  readonly lapDistPct: number;
  /** Null until the car has set one. */
  readonly lastLapS: number | null;
  readonly bestLapS: number | null;
  readonly onPitRoad: boolean;
  /** Seconds the car is estimated to take to reach where it is on this lap. */
  readonly estTimeS: number;
  /** Race time behind the leader (the SDK's F2Time). */
  readonly gapToLeaderS: number;
  /** In the world at all — false for a car in the garage or disconnected. */
  readonly inWorld: boolean;
}

export interface TyreCorner {
  /** Carcass temperatures across the tread, °C — left, middle, right. */
  readonly tempC: readonly [number, number, number];
  /** Tread remaining, 0..1 — left, middle, right. */
  readonly wear: readonly [number, number, number];
  readonly coldPressureKpa: number;
}

export interface TyreSet {
  readonly lf: TyreCorner;
  readonly rf: TyreCorner;
  readonly lr: TyreCorner;
  readonly rr: TyreCorner;
}

/** `irsdk_TrackWetness`, 0..7. */
export const TRACK_WETNESS = [
  "unknown",
  "dry",
  "mostly dry",
  "very lightly wet",
  "lightly wet",
  "moderately wet",
  "very wet",
  "extremely wet",
] as const;

/** `irsdk_Skies`, 0..3. */
export const SKIES = ["clear", "partly cloudy", "mostly cloudy", "overcast"] as const;

export interface Weather {
  readonly airC: number;
  readonly trackC: number;
  /** 0..1. */
  readonly humidity: number;
  /** 0..1. */
  readonly precipitation: number;
  readonly windMps: number;
  /** Radians, the direction the wind blows FROM, clockwise from north. */
  readonly windDirRad: number;
  /** Index into `TRACK_WETNESS`. */
  readonly wetness: number;
  /** Index into `SKIES`. */
  readonly skies: number;
  readonly declaredWet: boolean;
}

/**
 * `irsdk_CarLeftRight` — the spotter. The one lateral fact the sim gives about
 * other cars: it knows someone is alongside, and on which side, but never how
 * far over.
 */
export const SPOTTER = {
  off: 0,
  clear: 1,
  left: 2,
  right: 3,
  both: 4,
  twoLeft: 5,
  twoRight: 6,
} as const;

/**
 * `irsdk_Flags` — the bits of `SessionFlags`. Several can be set at once
 * (green and blue, yellow and one-to-green); `flagShown` picks the one a
 * driver needs to see.
 */
export const FLAG_BITS = {
  checkered: 0x00000001,
  white: 0x00000002,
  green: 0x00000004,
  yellow: 0x00000008,
  red: 0x00000010,
  blue: 0x00000020,
  debris: 0x00000040,
  crossed: 0x00000080,
  yellowWaving: 0x00000100,
  oneLapToGreen: 0x00000200,
  greenHeld: 0x00000400,
  caution: 0x00004000,
  cautionWaving: 0x00008000,
  black: 0x00010000,
  disqualify: 0x00020000,
  repair: 0x00100000,
  startGo: 0x80000000,
} as const;

export type FlagKind =
  | "disqualify"
  | "black"
  | "meatball"
  | "red"
  | "checkered"
  | "white"
  | "yellow"
  | "blue"
  | "debris"
  | "green";

export interface FlagShown {
  readonly kind: FlagKind;
  /** Waved, not just shown: a local yellow waving, a full-course caution waving. */
  readonly waving: boolean;
}

/**
 * The one flag that matters most right now, or null for none. Your own
 * flags first (disqualified, black, the meatball for repairs), then the
 * session's in order of how much they change what you do. A plain green is
 * the normal state of a race, so it only counts at the start.
 */
export function flagShown(bits: number): FlagShown | null {
  const b = bits >>> 0;
  const on = (bit: number): boolean => (b & bit) >>> 0 !== 0;
  if (on(FLAG_BITS.disqualify)) return { kind: "disqualify", waving: false };
  if (on(FLAG_BITS.black)) return { kind: "black", waving: false };
  if (on(FLAG_BITS.repair)) return { kind: "meatball", waving: false };
  if (on(FLAG_BITS.red)) return { kind: "red", waving: false };
  if (on(FLAG_BITS.checkered)) return { kind: "checkered", waving: true };
  if (on(FLAG_BITS.caution) || on(FLAG_BITS.cautionWaving) || on(FLAG_BITS.yellow) || on(FLAG_BITS.yellowWaving)) {
    return { kind: "yellow", waving: on(FLAG_BITS.cautionWaving) || on(FLAG_BITS.yellowWaving) };
  }
  if (on(FLAG_BITS.white)) return { kind: "white", waving: false };
  if (on(FLAG_BITS.blue)) return { kind: "blue", waving: true };
  if (on(FLAG_BITS.debris)) return { kind: "debris", waving: false };
  if (on(FLAG_BITS.startGo) || on(FLAG_BITS.oneLapToGreen)) return { kind: "green", waving: on(FLAG_BITS.startGo) };
  return null;
}

/**
 * The dash inputs that change every frame but are not worth recording: engine
 * speed for the shift lights, the clutch pedal, and force-feedback load. Read
 * at 60 Hz alongside the frame, never written to a recording (§9), and absent
 * from a replay — the input panels simply draw without them.
 */
export interface DashState {
  readonly rpm: number;
  /** Pedal travel, 0 released .. 1 pressed — the SDK's own is the other way up. */
  readonly clutch: number;
  /** Share of the wheel's maximum torque, 0..1. */
  readonly ffb: number;
}

/** The car's shift-light points, from the session YAML. RPM. */
export interface ShiftLights {
  readonly firstRpm: number;
  readonly shiftRpm: number;
  readonly lastRpm: number;
  readonly blinkRpm: number;
}

export interface RaceSnapshot {
  /** "Race", "Practice", "Lone Qualify"... the SDK's own words. */
  readonly sessionType: string;
  /** "moderate usage" — the sim's word for how rubbered-in the track is. */
  readonly rubber: string;
  /** Null for a car the sim gives no shift points for. */
  readonly shiftLights: ShiftLights | null;
  /** Null for a session with no clock (a lap-limited race). */
  readonly sessionTimeRemainS: number | null;
  readonly sessionLapsRemain: number | null;
  readonly sessionLapsTotal: number | null;
  readonly playerCarIdx: number;
  readonly drivers: readonly RaceDriver[];
  readonly cars: readonly RaceCar[];
  /** Metres, from the session YAML. Null if the sim did not say. */
  readonly trackLengthM: number | null;
  /** Where each timing sector starts, 0..1, ascending, first is 0. */
  readonly sectorStartPcts: readonly number[];
  readonly fuel: {
    readonly levelL: number;
    /** 0..1 of the tank. */
    readonly levelPct: number;
    /** Litres per hour — converted from the SDK's kg/h. */
    readonly useLph: number;
    readonly tankL: number;
  };
  /** Only updated by the sim while the car is in the pit stall. */
  readonly tyres: TyreSet;
  readonly weather: Weather;
  /** Index into `SPOTTER`. */
  readonly spotter: number;
  /** `SessionFlags`: `FLAG_BITS`, as the sim sets them. */
  readonly sessionFlags: number;
  /** Percent front, as the car's own dash shows it. Null when the car has none. */
  readonly brakeBiasPct: number | null;
  readonly incidents: number;
  /** Seconds of mandatory and optional repair — the only damage the SDK reports. */
  readonly repairS: number;
  readonly optionalRepairS: number;
  readonly playerLastLapS: number | null;
  readonly playerBestLapS: number | null;
}

/** Signed distance in pct, −0.5..0.5, so comparisons work across start/finish. */
export const pctDelta = (a: number, b: number): number => ((((a - b) % 1) + 1.5) % 1) - 0.5;

/**
 * Seconds between two cars on track, positive when `other` is ahead.
 *
 * From the SDK's per-car estimated time rather than lap distance: a car 100 m
 * up the road is two seconds away through a hairpin and one on a straight, and
 * EstTime already knows which. Wrapped by the lap time so a car just across the
 * line reads as just ahead, not a lap behind.
 */
export function relativeGapS(
  meEstS: number,
  otherEstS: number,
  lapS: number,
): number {
  if (!(lapS > 0)) return otherEstS - meEstS;
  let gap = (otherEstS - meEstS) % lapS;
  if (gap > lapS / 2) gap -= lapS;
  if (gap < -lapS / 2) gap += lapS;
  return gap;
}

/**
 * How many laps apart two cars really are, from laps plus distance.
 *
 * Positive when `other` is ahead on the road by more than half a lap — lapping
 * you — which is what a relative colours differently.
 */
export function lapsApart(me: RaceCar, other: RaceCar): number {
  return other.lap + other.lapDistPct - (me.lap + me.lapDistPct);
}

/**
 * Strength of field — iRacing's own formula, as every results page prints it.
 *
 * Per class, because a GTP's iRating and a GT3's are not the same race.
 */
export function strengthOfField(iRatings: readonly number[]): number | null {
  const valid = iRatings.filter((r) => r > 0);
  if (valid.length === 0) return null;
  const base = 1600 / Math.LN2;
  const sum = valid.reduce((acc, r) => acc + Math.exp(-r / base), 0);
  return Math.round(base * Math.log(valid.length / sum));
}

export interface FuelEstimate {
  /** Average over the laps the tracker has seen, litres. */
  readonly perLapL: number | null;
  readonly lastLapL: number | null;
  readonly maxLapL: number | null;
  /** How far what is in the tank goes at the average. */
  readonly lapsLeft: number | null;
  /** Litres to finish, when the session length is known. */
  readonly toFinishL: number | null;
  /** Spare (positive) or short (negative) at the finish. */
  readonly marginL: number | null;
  readonly lapsSampled: number;
}

/**
 * Per-lap fuel use, learned by watching the level fall.
 *
 * `FuelUsePerHour` alone cannot answer "how much per lap" — it is an
 * instantaneous rate, and a lap is not a constant throttle. The level at each
 * start/finish crossing can. A lap spent partly in the pits is discarded, and
 * so is one where the level went UP: that is refuelling, not negative use.
 */
export class FuelTracker {
  #lastLap: number | null = null;
  #levelAtLapStart: number | null = null;
  #pitThisLap = false;
  #laps: number[] = [];
  readonly #keep: number;

  constructor(keep = 5) {
    this.#keep = keep;
  }

  update(lap: number, levelL: number, onPitRoad: boolean): void {
    if (onPitRoad) this.#pitThisLap = true;

    if (this.#lastLap === null) {
      this.#lastLap = lap;
      this.#levelAtLapStart = levelL;
      return;
    }

    if (lap !== this.#lastLap) {
      const start = this.#levelAtLapStart;
      const used = start === null ? null : start - levelL;
      // Only a lap that followed on from the last one, was driven clean of the
      // pits, and burned something is a sample. A jump of several laps is a
      // reset or a tow, not one lap of fuel.
      if (lap === this.#lastLap + 1 && !this.#pitThisLap && used !== null && used > 0) {
        this.#laps = [...this.#laps, used].slice(-this.#keep);
      }
      this.#lastLap = lap;
      this.#levelAtLapStart = levelL;
      this.#pitThisLap = onPitRoad;
    }
  }

  estimate(levelL: number, lapsRemaining: number | null): FuelEstimate {
    const n = this.#laps.length;
    const perLapL = n === 0 ? null : this.#laps.reduce((a, b) => a + b, 0) / n;
    const lapsLeft = perLapL === null || perLapL <= 0 ? null : levelL / perLapL;
    const toFinishL =
      perLapL === null || lapsRemaining === null ? null : Math.max(0, lapsRemaining * perLapL);
    return {
      perLapL,
      lastLapL: this.#laps[n - 1] ?? null,
      maxLapL: n === 0 ? null : Math.max(...this.#laps),
      lapsLeft,
      toFinishL,
      marginL: toFinishL === null ? null : levelL - toFinishL,
      lapsSampled: n,
    };
  }

  reset(): void {
    this.#lastLap = null;
    this.#levelAtLapStart = null;
    this.#pitThisLap = false;
    this.#laps = [];
  }
}

/**
 * Laps left in the session, whichever way it is limited.
 *
 * A lap-limited race says so directly. A timed one does not, so it is the
 * clock divided by a lap — rounded up, because the lap you are on when the
 * clock runs out still has to be finished.
 */
export function lapsRemaining(
  snapshot: Pick<RaceSnapshot, "sessionLapsRemain" | "sessionTimeRemainS">,
  lapS: number | null,
): number | null {
  if (snapshot.sessionLapsRemain !== null && snapshot.sessionLapsRemain < 10_000) {
    return snapshot.sessionLapsRemain;
  }
  if (snapshot.sessionTimeRemainS === null || lapS === null || !(lapS > 0)) return null;
  return Math.ceil(snapshot.sessionTimeRemainS / lapS);
}
