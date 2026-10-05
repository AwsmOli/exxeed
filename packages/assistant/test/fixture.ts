import type { RaceRow, RaceView, RelativeRow } from "@exxeed/overlays";

const tyre = { tempC: [80, 82, 81], wear: [0.9, 0.88, 0.9], coldPressureKpa: 150 };

export const row = (over: Partial<RaceRow> & Pick<RaceRow, "carIdx">): RaceRow => ({
  position: over.carIdx + 1,
  classPosition: over.carIdx + 1,
  carNumber: String(over.carIdx),
  name: `Driver ${over.carIdx}`,
  iRating: 2000,
  license: "A 3.00",
  licenseColor: "#0000ff",
  lap: 5,
  gapS: null,
  intervalS: null,
  lastLapS: 100,
  bestLapS: 99,
  fastest: false,
  onPitRoad: false,
  isPlayer: false,
  ...over,
});

export const rel = (over: Partial<RelativeRow> & Pick<RelativeRow, "carIdx" | "gapS">): RelativeRow => ({
  position: over.carIdx + 1,
  carNumber: String(over.carIdx),
  name: `Driver ${over.carIdx}`,
  classColor: "#ff0000",
  iRating: 2000,
  license: "A 3.00",
  licenseColor: "#0000ff",
  lap: 5,
  lapState: 0,
  onPitRoad: false,
  isPlayer: false,
  ...over,
});

/** The player is car 1: car 0 leads and is 2 s up the road, car 2 is 1.5 s behind. */
export function view(over: Partial<RaceView> = {}): RaceView {
  return {
    sessionType: "Race",
    rubber: "moderate usage",
    shiftLights: null,
    lap: 5,
    lapsTotal: 20,
    lapsRemain: 15,
    timeRemainS: null,
    trackLengthM: 4000,
    classes: [
      {
        classId: 1,
        className: "GT3",
        classColor: "#ff0000",
        sof: 2000,
        rows: [
          row({ carIdx: 0, bestLapS: 98, fastest: true }),
          row({ carIdx: 1, isPlayer: true, gapS: 2, intervalS: 2 }),
          row({ carIdx: 2, gapS: 3.5, intervalS: 1.5, lastLapS: 99.7 }),
        ],
      },
    ],
    relatives: [
      rel({ carIdx: 0, gapS: 2 }),
      rel({ carIdx: 1, gapS: 0, isPlayer: true }),
      rel({ carIdx: 2, gapS: -1.5 }),
    ],
    cars: [],
    flag: null,
    radar: { spotter: "clear", nearby: [] },
    fuel: {
      levelL: 30,
      levelPct: 0.5,
      tankL: 60,
      useLph: 80,
      perLapL: 2.5,
      lastLapL: 2.5,
      maxLapL: 2.6,
      lapsLeft: 12,
      toFinishL: 37.5,
      marginL: -7.5,
    },
    tyres: { lf: tyre, rf: tyre, lr: tyre, rr: { ...tyre, wear: [0.6, 0.6, 0.6] } },
    weather: {
      airC: 22,
      trackC: 30,
      humidity: 0.5,
      precipitation: 0,
      windMps: 5,
      windDirRad: Math.PI / 2,
      wetness: "dry",
      skies: "clear",
      declaredWet: false,
    },
    repairS: 0,
    optionalRepairS: 0,
    brakeBiasPct: 54,
    incidents: 2,
    sectorStartPcts: [0],
    lastLapS: 100,
    bestLapS: 99,
    ...over,
  };
}

/**
 * The same view with the cars ahead and behind at other gaps. `dist` is the
 * player's laps plus lap position; without it the view does not say where on
 * the lap the player is, as a view with an empty `cars` does not.
 */
export const withGaps = (aheadS: number, behindS: number, dist: number | null = null): RaceView =>
  view({
    ...(dist === null
      ? {}
      : {
          lap: Math.floor(dist),
          cars: [
            {
              carIdx: 1,
              lapDistPct: dist - Math.floor(dist),
              classColor: "#ff0000",
              isPlayer: true,
              onPitRoad: false,
            },
          ],
        }),
    relatives: [
      rel({ carIdx: 0, gapS: aheadS }),
      rel({ carIdx: 1, gapS: 0, isPlayer: true }),
      rel({ carIdx: 2, gapS: -behindS }),
    ],
  });
