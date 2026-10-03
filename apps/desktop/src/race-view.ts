/**
 * RaceSnapshot → RaceView: what the race overlays draw.
 *
 * The same split as map-view.ts and reference-view.ts — the source says what
 * the sim knows, this says what the panels need, and the renderer only draws.
 * Ordering the field, gaps, who counts as "near" on the radar and how far the
 * fuel goes are all decided here, in main, so every window agrees about them.
 */

import type { RaceClass, RaceRow, RaceView, RelativeRow, SpotterState } from "@exxeed/overlays";
import {
  flagShown,
  FuelTracker,
  lapsApart,
  lapsRemaining,
  pctDelta,
  relativeGapS,
  SKIES,
  SPOTTER,
  strengthOfField,
  TRACK_WETNESS,
  type RaceCar,
  type RaceDriver,
  type RaceSnapshot,
} from "@exxeed/telemetry";

/** Cars either side of the player in the relative. */
const RELATIVE_EACH_SIDE = 4;

/** How far along the road the radar looks, metres. About five car lengths. */
const RADAR_RANGE_M = 24;

const SPOTTER_NAMES: Readonly<Record<number, SpotterState>> = {
  [SPOTTER.off]: "off",
  [SPOTTER.clear]: "clear",
  [SPOTTER.left]: "left",
  [SPOTTER.right]: "right",
  [SPOTTER.both]: "both",
  [SPOTTER.twoLeft]: "twoLeft",
  [SPOTTER.twoRight]: "twoRight",
};

/**
 * Stateful only for the fuel: per-lap use has to be learned by watching laps
 * go by, so one of these lives as long as a session and is fed every snapshot.
 */
export class RaceViewBuilder {
  readonly #fuel = new FuelTracker();

  build(s: RaceSnapshot): RaceView {
    const byIdx = new Map<number, RaceDriver>(s.drivers.map((d) => [d.carIdx, d]));
    const me = s.cars.find((c) => c.carIdx === s.playerCarIdx) ?? null;
    const myDriver = byIdx.get(s.playerCarIdx) ?? null;

    if (me !== null) this.#fuel.update(me.lap, s.fuel.levelL, me.onPitRoad);

    const lapS = myDriver?.classEstLapS ?? null;
    const fuel = this.#fuel.estimate(s.fuel.levelL, lapsRemaining(s, s.playerBestLapS ?? lapS));

    return {
      sessionType: s.sessionType,
      rubber: s.rubber,
      shiftLights: s.shiftLights,
      lap: me?.lap ?? 0,
      lapsTotal: s.sessionLapsTotal,
      lapsRemain: s.sessionLapsRemain,
      timeRemainS: s.sessionTimeRemainS,
      trackLengthM: s.trackLengthM,
      classes: standings(s, byIdx),
      relatives: me === null ? [] : relatives(s, me, byIdx),
      cars: s.cars
        .filter((c) => c.inWorld)
        .map((c) => ({
          carIdx: c.carIdx,
          lapDistPct: c.lapDistPct,
          classColor: byIdx.get(c.carIdx)?.classColor ?? "#ffffff",
          isPlayer: c.carIdx === s.playerCarIdx,
          onPitRoad: c.onPitRoad,
        })),
      flag: flagShown(s.sessionFlags),
      radar: {
        spotter: SPOTTER_NAMES[s.spotter] ?? "off",
        nearby:
          me === null || s.trackLengthM === null
            ? []
            : nearby(s, me, s.trackLengthM, byIdx),
      },
      fuel: {
        levelL: s.fuel.levelL,
        levelPct: s.fuel.levelPct,
        tankL: s.fuel.tankL,
        useLph: s.fuel.useLph,
        perLapL: fuel.perLapL,
        lastLapL: fuel.lastLapL,
        maxLapL: fuel.maxLapL,
        lapsLeft: fuel.lapsLeft,
        toFinishL: fuel.toFinishL,
        marginL: fuel.marginL,
      },
      tyres: s.tyres,
      weather: {
        ...s.weather,
        wetness: TRACK_WETNESS[s.weather.wetness] ?? "unknown",
        skies: SKIES[s.weather.skies] ?? "",
      },
      repairS: s.repairS,
      optionalRepairS: s.optionalRepairS,
      brakeBiasPct: s.brakeBiasPct,
      incidents: s.incidents,
      sectorStartPcts: s.sectorStartPcts,
      lastLapS: s.playerLastLapS,
      bestLapS: s.playerBestLapS,
    };
  }
}

/** Grouped by class, fastest class first, each in class-position order. */
function standings(s: RaceSnapshot, byIdx: ReadonlyMap<number, RaceDriver>): RaceClass[] {
  const groups = new Map<number, { driver: RaceDriver; car: RaceCar }[]>();
  for (const car of s.cars) {
    const driver = byIdx.get(car.carIdx);
    if (driver === undefined) continue;
    const list = groups.get(driver.classId) ?? [];
    list.push({ driver, car });
    groups.set(driver.classId, list);
  }

  const classes = [...groups.values()].map((entries) => {
    // Unclassified cars (position 0 — not yet taken the start, or practice
    // with no laps) go to the bottom rather than the top.
    const ordered = [...entries].sort(
      (a, b) => (a.car.classPosition || 999) - (b.car.classPosition || 999),
    );
    const fastest = Math.min(
      ...ordered.map((e) => e.car.bestLapS ?? Number.POSITIVE_INFINITY),
    );
    const leader = ordered[0]?.car ?? null;

    const rows: RaceRow[] = ordered.map(({ driver, car }, i) => {
      const ahead = i === 0 ? null : ordered[i - 1]!.car;
      return {
        carIdx: car.carIdx,
        position: car.position,
        classPosition: car.classPosition || i + 1,
        carNumber: driver.carNumber,
        name: driver.shortName,
        iRating: driver.iRating,
        license: driver.license,
        licenseColor: driver.licenseColor,
        lap: car.lap,
        gapS: leader === null || i === 0 ? null : car.gapToLeaderS - leader.gapToLeaderS,
        intervalS: ahead === null ? null : car.gapToLeaderS - ahead.gapToLeaderS,
        lastLapS: car.lastLapS,
        bestLapS: car.bestLapS,
        fastest: car.bestLapS !== null && car.bestLapS === fastest,
        onPitRoad: car.onPitRoad,
        isPlayer: car.carIdx === s.playerCarIdx,
      };
    });

    const first = ordered[0]!.driver;
    return {
      classId: first.classId,
      className: first.className,
      classColor: first.classColor,
      sof: strengthOfField(ordered.map((e) => e.driver.iRating)),
      rows,
      // For ordering the classes themselves — the quickest class leads.
      estLapS: first.classEstLapS,
    };
  });

  return classes
    .sort((a, b) => a.estLapS - b.estLapS)
    .map(({ estLapS: _ignored, ...rest }) => rest);
}

/** The cars nearest on the road, not in the standings — who you are racing now. */
function relatives(
  s: RaceSnapshot,
  me: RaceCar,
  byIdx: ReadonlyMap<number, RaceDriver>,
): RelativeRow[] {
  const lapS = byIdx.get(me.carIdx)?.classEstLapS ?? 0;

  const rows = s.cars
    .filter((c) => c.inWorld)
    .map((car): RelativeRow | null => {
      const driver = byIdx.get(car.carIdx);
      if (driver === undefined) return null;
      const apart = lapsApart(me, car);
      return {
        carIdx: car.carIdx,
        position: car.position,
        carNumber: driver.carNumber,
        name: driver.shortName,
        classColor: driver.classColor,
        iRating: driver.iRating,
        license: driver.license,
        licenseColor: driver.licenseColor,
        lap: car.lap,
        gapS: car.carIdx === me.carIdx ? 0 : relativeGapS(me.estTimeS, car.estTimeS, lapS),
        lapState: apart > 0.5 ? 1 : apart < -0.5 ? -1 : 0,
        onPitRoad: car.onPitRoad,
        isPlayer: car.carIdx === me.carIdx,
      };
    })
    .filter((r): r is RelativeRow => r !== null);

  const ahead = rows
    .filter((r) => !r.isPlayer && r.gapS >= 0)
    .sort((a, b) => a.gapS - b.gapS)
    .slice(0, RELATIVE_EACH_SIDE)
    .reverse();
  const behind = rows
    .filter((r) => !r.isPlayer && r.gapS < 0)
    .sort((a, b) => b.gapS - a.gapS)
    .slice(0, RELATIVE_EACH_SIDE);
  const player = rows.filter((r) => r.isPlayer);

  return [...ahead, ...player, ...behind];
}

function nearby(
  s: RaceSnapshot,
  me: RaceCar,
  lengthM: number,
  byIdx: ReadonlyMap<number, RaceDriver>,
): { aheadM: number; classColor: string }[] {
  return s.cars
    .filter((c) => c.carIdx !== me.carIdx && c.inWorld && !c.onPitRoad)
    .map((c) => ({
      aheadM: pctDelta(c.lapDistPct, me.lapDistPct) * lengthM,
      classColor: byIdx.get(c.carIdx)?.classColor ?? "#ffffff",
    }))
    .filter((c) => Math.abs(c.aheadM) <= RADAR_RANGE_M);
}
