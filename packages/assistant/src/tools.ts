/**
 * The questions an assistant can ask.
 *
 * Every tool answers twice: a `summary` sentence that can be read out as it
 * stands, and the `data` behind it. The sentence is the point. The driver is
 * mid-corner and the answer arrives by voice, so "do I need to refuel" has to
 * come back as a yes or a no with a number of litres — worked out here, from
 * the same figures the Fuel panel draws — and not as a table for a model to do
 * sums on.
 *
 * SI in, and metric out: litres, °C, seconds, km/h. A tool is a plain function
 * of `AssistantState`, so all of this is tested without a server or a sim.
 */

import { z } from "zod";

import type { RaceClass, RaceRow, RaceView, RelativeRow } from "@exxeed/overlays";

import type { AssistantState } from "./state.js";

/** A picture in a reply — a video frame, say — for a model that can look. */
export interface ToolImage {
  readonly mimeType: "image/jpeg" | "image/png";
  readonly base64: string;
}

export interface ToolReply {
  readonly summary: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly images?: readonly ToolImage[];
}

/**
 * One tool. `Ctx` is what it works on: the live race (`AssistantState`) for
 * the questions here, the authoring side of the app for the ones in
 * authoring.ts.
 */
export interface Tool<Ctx, Shape extends z.ZodRawShape = z.ZodRawShape> {
  readonly name: string;
  readonly title: string;
  /** For the model: when to call this, in the driver's words. */
  readonly description: string;
  readonly input: Shape;
  run(ctx: Ctx, args: z.infer<z.ZodObject<Shape>>): ToolReply | Promise<ToolReply>;
}

/** A question about the race. Answered at once, from what the app already holds. */
export interface AssistantTool<Shape extends z.ZodRawShape = z.ZodRawShape>
  extends Omit<Tool<AssistantState, Shape>, "run"> {
  run(ctx: AssistantState, args: z.infer<z.ZodObject<Shape>>): ToolReply;
}

const tool = <Shape extends z.ZodRawShape>(t: AssistantTool<Shape>): AssistantTool<Shape> => t;

const round = (v: number, places = 1): number => {
  const f = 10 ** places;
  return Math.round(v * f) / f;
};

const orNull = (v: number | null, places = 1): number | null => (v === null ? null : round(v, places));

/** 92.345 → "1:32.345". */
export function lapTime(s: number | null): string | null {
  if (s === null || !(s > 0)) return null;
  const m = Math.floor(s / 60);
  const rest = (s - m * 60).toFixed(3).padStart(6, "0");
  return m === 0 ? rest : `${m}:${rest}`;
}

/** 3725 → "1 h 2 min". */
function duration(s: number): string {
  const total = Math.max(0, Math.round(s / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h === 0 ? `${m} min` : `${h} h ${m} min`;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

const COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"] as const;

const compass = (rad: number): string =>
  COMPASS[((Math.round(rad / (Math.PI / 4)) % 8) + 8) % 8] ?? "north";

/** The player's class and their row in it, from the standings. */
function playerRow(view: RaceView): { cls: RaceClass; row: RaceRow; index: number } | null {
  for (const cls of view.classes) {
    const index = cls.rows.findIndex((r) => r.isPlayer);
    const row = cls.rows[index];
    if (row !== undefined) return { cls, row, index };
  }
  return null;
}

const rowOf = (view: RaceView, carIdx: number): RaceRow | null => {
  for (const cls of view.classes) {
    const row = cls.rows.find((r) => r.carIdx === carIdx);
    if (row !== undefined) return row;
  }
  return null;
};

/**
 * The sim reports "laps remaining" as a huge number in a timed race. Same
 * cut-off as `lapsRemaining` in @exxeed/telemetry.
 */
const realLaps = (laps: number | null): number | null => (laps !== null && laps < 10_000 ? laps : null);

const car = (r: { carNumber: string; name: string }): string => `car ${r.carNumber} (${r.name})`;

const getSession = tool({
  name: "get_session",
  title: "Session",
  description:
    "Where the driver is and how the session stands: track, car, session type, lap, position, laps or time remaining, the flag being shown, incident count.",
  input: {},
  run(state) {
    const view = state.race();
    const me = playerRow(view);
    const lapsRemain = realLaps(view.lapsRemain);
    const lapsTotal = realLaps(view.lapsTotal);
    const { trackName, carName } = state.session;

    const parts: string[] = [];
    parts.push(
      `${view.sessionType}${trackName === null ? "" : ` at ${trackName}`}${carName === null ? "" : ` in the ${carName}`}.`,
    );
    parts.push(`Lap ${view.lap}${lapsTotal === null ? "" : ` of ${lapsTotal}`}.`);
    if (me !== null && me.row.position > 0) {
      parts.push(
        view.classes.length > 1
          ? `P${me.row.position} overall, P${me.row.classPosition} in ${me.cls.className}.`
          : `P${me.row.position}.`,
      );
    }
    if (lapsRemain !== null) parts.push(`${plural(lapsRemain, "lap")} to go.`);
    else if (view.timeRemainS !== null) parts.push(`${duration(view.timeRemainS)} to go.`);
    if (view.flag !== null) parts.push(`${view.flag.waving ? "Waved" : "A"} ${view.flag.kind} flag is out.`);

    return {
      summary: parts.join(" "),
      data: {
        track: trackName,
        car: carName,
        sessionType: view.sessionType,
        testMode: state.session.testMode,
        lap: view.lap,
        lapsTotal,
        lapsRemaining: lapsRemain,
        timeRemainingS: orNull(view.timeRemainS, 0),
        position: me === null || me.row.position === 0 ? null : me.row.position,
        classPosition: me?.row.classPosition ?? null,
        className: me?.cls.className ?? null,
        flag: view.flag,
        incidents: view.incidents,
      },
    };
  },
});

const getFuel = tool({
  name: "get_fuel",
  title: "Fuel",
  description:
    "Fuel in the tank, use per lap, how many laps it lasts, and whether it reaches the finish. Call for \"do I need to refuel\", \"how much fuel\", \"can I make it to the end\", \"how much do I need to add\".",
  input: {},
  run(state) {
    const view = state.race();
    const f = view.fuel;
    const lapsToFinish = f.toFinishL !== null && f.perLapL !== null && f.perLapL > 0 ? f.toFinishL / f.perLapL : null;
    const needsStop = f.marginL === null ? null : f.marginL < 0;
    const shortL = f.marginL !== null && f.marginL < 0 ? -f.marginL : 0;
    const roomL = Math.max(0, f.tankL - f.levelL);

    const parts = [`${round(f.levelL)} litres in the tank.`];
    if (f.perLapL === null) {
      parts.push("No per-lap figure yet: that needs one clean flying lap.");
    } else {
      parts.push(`${round(f.perLapL, 2)} litres a lap, so about ${round(f.lapsLeft ?? 0)} laps of fuel.`);
      if (lapsToFinish === null) {
        parts.push("The session length is not known, so there is no finish to measure against.");
      } else if (needsStop === true) {
        parts.push(
          `${round(lapsToFinish)} laps to the finish: ${round(shortL)} litres short. You need to stop and add at least ${round(shortL)} litres.` +
            (shortL > roomL ? ` The tank only has room for ${round(roomL)}, so that is more than one stop.` : ""),
        );
      } else {
        parts.push(
          `${round(lapsToFinish)} laps to the finish: you make it with ${round(f.marginL ?? 0)} litres to spare. No stop needed for fuel.`,
        );
      }
    }

    return {
      summary: parts.join(" "),
      data: {
        levelL: round(f.levelL),
        tankL: round(f.tankL),
        levelPct: round(f.levelPct * 100, 0),
        perLapL: orNull(f.perLapL, 2),
        lastLapL: orNull(f.lastLapL, 2),
        lapsOfFuel: orNull(f.lapsLeft),
        lapsToFinish: orNull(lapsToFinish),
        litresToFinish: orNull(f.toFinishL),
        marginL: orNull(f.marginL),
        needsStop,
        litresToAdd: needsStop === true ? round(shortL) : needsStop === false ? 0 : null,
      },
    };
  },
});

const getWeather = tool({
  name: "get_weather",
  title: "Weather",
  description:
    "Current conditions: how wet the track is, whether it is raining, air and track temperature, sky, wind. The sim publishes no forecast, so this is now, not later.",
  input: {},
  run(state) {
    const w = state.race().weather;
    const rainPct = round(w.precipitation * 100, 0);
    const windKph = round(w.windMps * 3.6, 0);

    const parts = [
      `Track is ${w.wetness}${w.declaredWet ? ", declared wet" : ""}.`,
      rainPct > 0 ? `Raining, ${rainPct} percent.` : "No rain.",
      `Air ${round(w.airC, 0)} degrees, track ${round(w.trackC, 0)}.`,
    ];
    if (w.skies !== "") parts.push(`Skies ${w.skies}.`);
    parts.push(windKph === 0 ? "No wind." : `Wind ${windKph} kilometres an hour from the ${compass(w.windDirRad)}.`);

    return {
      summary: parts.join(" "),
      data: {
        wetness: w.wetness,
        declaredWet: w.declaredWet,
        precipitationPct: rainPct,
        airC: round(w.airC),
        trackC: round(w.trackC),
        humidityPct: round(w.humidity * 100, 0),
        skies: w.skies,
        windKph,
        windFrom: compass(w.windDirRad),
        forecastAvailable: false,
      },
    };
  },
});

const lapStateWords = (r: RelativeRow): string =>
  r.lapState === 1 ? "a lap ahead of you" : r.lapState === -1 ? "a lap down" : "same lap";

const relativeEntry = (r: RelativeRow): Record<string, unknown> => ({
  carNumber: r.carNumber,
  name: r.name,
  position: r.position === 0 ? null : r.position,
  gapS: round(Math.abs(r.gapS)),
  lapState: lapStateWords(r),
  inPits: r.onPitRoad,
});

/** The cars either side on the road, nearest first each way. */
function neighbours(view: RaceView): { ahead: RelativeRow[]; behind: RelativeRow[] } {
  const others = view.relatives.filter((r) => !r.isPlayer);
  return {
    ahead: others.filter((r) => r.gapS >= 0).sort((a, b) => a.gapS - b.gapS),
    behind: others.filter((r) => r.gapS < 0).sort((a, b) => b.gapS - a.gapS),
  };
}

const getRelative = tool({
  name: "get_relative",
  title: "Cars around",
  description:
    "The cars nearest on the road, ahead and behind, with the gap in seconds and whether each is on the same lap. Call for \"who is behind me\", \"how far is the car ahead\". For whether a gap is growing or shrinking use get_gap_trend.",
  input: {},
  run(state) {
    const view = state.race();
    const { ahead, behind } = neighbours(view);
    const a = ahead[0];
    const b = behind[0];

    const parts: string[] = [];
    parts.push(
      a === undefined
        ? "Nobody close ahead."
        : `Ahead: ${car(a)}, ${round(a.gapS)} seconds, ${lapStateWords(a)}${a.onPitRoad ? ", in the pits" : ""}.`,
    );
    parts.push(
      b === undefined
        ? "Nobody close behind."
        : `Behind: ${car(b)}, ${round(-b.gapS)} seconds, ${lapStateWords(b)}${b.onPitRoad ? ", in the pits" : ""}.`,
    );

    return {
      summary: parts.join(" "),
      data: { ahead: ahead.map(relativeEntry), behind: behind.map(relativeEntry) },
    };
  },
});

/** Below this many seconds a lap the gap is called steady: it is inside the noise of the fit. */
const STEADY_PER_LAP_S = 0.05;

function trendFor(state: AssistantState, view: RaceView, r: RelativeRow, side: "ahead" | "behind"): {
  sentence: string;
  data: Record<string, unknown>;
} {
  const gap = round(Math.abs(r.gapS));
  const theirs = rowOf(view, r.carIdx);
  const mine = playerRow(view)?.row ?? null;
  const lapS = view.lastLapS ?? view.bestLapS;
  const t = state.history.trend(r.carIdx);

  const where = `${car(r)} is ${gap} seconds ${side}`;
  const lastLapDeltaS =
    theirs?.lastLapS != null && mine?.lastLapS != null ? theirs.lastLapS - mine.lastLapS : null;

  let sentence: string;
  let trend: "closing" | "opening" | "steady" | "unknown" = "unknown";
  let perLapS: number | null = null;
  let lapsUntilTogether: number | null = null;

  if (t !== null) perLapS = t.basis === "lap" ? t.closingPerLapS : lapS === null ? null : t.closingPerS * lapS;
  // Under a lap of history the figure is a line through part of a lap, and the
  // gap moves about within one. Good enough to say which way, not to the hundredth.
  const about = t?.basis === "window" ? "about " : "";

  if (perLapS === null) {
    sentence = `${where}. Not enough history for a trend yet.`;
    if (lastLapDeltaS !== null && Math.abs(lastLapDeltaS) >= 0.05) {
      sentence += ` Their last lap was ${round(Math.abs(lastLapDeltaS), 2)} seconds ${lastLapDeltaS < 0 ? "faster" : "slower"} than yours.`;
    }
  } else {
    if (Math.abs(perLapS) < STEADY_PER_LAP_S) {
      trend = "steady";
      sentence = `${where} and the gap is steady.`;
    } else if (perLapS > 0) {
      trend = "closing";
      lapsUntilTogether = Math.abs(r.gapS) / perLapS;
      const rate = `${about}${round(perLapS, 2)} seconds a lap`;
      const when = `about ${plural(Math.max(1, Math.round(lapsUntilTogether)), "lap")}`;
      sentence =
        side === "behind"
          ? `${where} and gaining ${rate}: on you in ${when}.`
          : `${where} and you are gaining ${rate}: with them in ${when}.`;
    } else {
      trend = "opening";
      const rate = `${about}${round(-perLapS, 2)} seconds a lap`;
      sentence =
        side === "behind"
          ? `${where} and dropping back ${rate}.`
          : `${where} and pulling away ${rate}.`;
    }
  }

  return {
    sentence,
    data: {
      carNumber: r.carNumber,
      name: r.name,
      side,
      gapS: gap,
      lapState: lapStateWords(r),
      trend,
      // Positive: the gap is shrinking.
      closingPerLapS: orNull(perLapS, 2),
      lapsUntilTogether: orNull(lapsUntilTogether),
      // "lap over lap" is the same place on track a lap apart; the other is an
      // estimate from less than a lap.
      measured: t === null ? null : t.basis === "lap" ? "lap over lap" : `last ${round(t.spanS, 0)} seconds`,
      theirLastLap: lapTime(theirs?.lastLapS ?? null),
      yourLastLap: lapTime(mine?.lastLapS ?? view.lastLapS),
      theirLastLapVsYoursS: orNull(lastLapDeltaS, 2),
    },
  };
}

const getGapTrend = tool({
  name: "get_gap_trend",
  title: "Gap trend",
  description:
    "Whether the gap to the nearest car ahead and behind is shrinking or growing, by how much per lap, and how many laps until they meet. Call for \"is the car behind gaining\", \"am I catching him\", \"am I pulling away\". Pass car_number to ask about one specific car nearby.",
  input: {
    side: z.enum(["ahead", "behind", "both"]).default("both").describe("Which neighbour to report on."),
    car_number: z.string().optional().describe("A specific car's number, if the driver named one."),
  },
  run(state, args) {
    const view = state.race();
    const { ahead, behind } = neighbours(view);

    const picked: { r: RelativeRow; side: "ahead" | "behind" }[] = [];
    if (args.car_number !== undefined) {
      const wanted = args.car_number.replace(/^#/, "");
      const r = view.relatives.find((x) => !x.isPlayer && x.carNumber === wanted);
      if (r === undefined) {
        return {
          summary: `Car ${wanted} is not among the cars near you on the road, so there is no gap to it being tracked.`,
          data: { cars: [] },
        };
      }
      picked.push({ r, side: r.gapS >= 0 ? "ahead" : "behind" });
    } else {
      // A car in the pits is not a car being raced; look past it.
      const a = ahead.find((r) => !r.onPitRoad);
      const b = behind.find((r) => !r.onPitRoad);
      if (args.side !== "ahead" && b !== undefined) picked.push({ r: b, side: "behind" });
      if (args.side !== "behind" && a !== undefined) picked.push({ r: a, side: "ahead" });
    }

    if (picked.length === 0) {
      return { summary: "Nobody close enough on the road to have a gap to.", data: { cars: [] } };
    }

    const results = picked.map((p) => trendFor(state, view, p.r, p.side));
    return {
      summary: results.map((r) => r.sentence).join(" "),
      data: { cars: results.map((r) => r.data) },
    };
  },
});

const standingsEntry = (r: RaceRow): Record<string, unknown> => ({
  classPosition: r.classPosition,
  position: r.position === 0 ? null : r.position,
  carNumber: r.carNumber,
  name: r.name,
  gapToLeaderS: orNull(r.gapS),
  lastLap: lapTime(r.lastLapS),
  bestLap: lapTime(r.bestLapS),
  inPits: r.onPitRoad,
  isYou: r.isPlayer,
});

const getStandings = tool({
  name: "get_standings",
  title: "Standings",
  description:
    "Race position in class: where the driver is, who leads and by how much, and the gaps on the timing screen to the places directly ahead and behind. These are standings gaps, not cars on the road — for those use get_relative.",
  input: {},
  run(state) {
    const view = state.race();
    const me = playerRow(view);
    if (me === null) {
      return { summary: "You are not in the standings yet.", data: { classes: view.classes.length } };
    }
    const { cls, row, index } = me;
    const leader = cls.rows[0];
    const ahead = cls.rows[index - 1];
    const behind = cls.rows[index + 1];

    const parts = [`P${row.classPosition} of ${cls.rows.length}${view.classes.length > 1 ? ` in ${cls.className}` : ""}.`];
    if (leader !== undefined && !leader.isPlayer) {
      parts.push(`${car(leader)} leads${row.gapS === null ? "" : `, ${round(row.gapS)} seconds up the road`}.`);
    } else {
      parts.push("You are leading.");
    }
    if (ahead !== undefined && row.intervalS !== null) {
      parts.push(`P${ahead.classPosition} ${car(ahead)} is ${round(row.intervalS)} seconds ahead.`);
    }
    if (behind !== undefined && behind.intervalS !== null) {
      parts.push(`P${behind.classPosition} ${car(behind)} is ${round(behind.intervalS)} seconds behind.`);
    }

    // The podium and the places either side: what a driver asks about, without
    // reading out a sixty-car grid.
    const near = cls.rows.filter((_, i) => i < 3 || Math.abs(i - index) <= 2);
    return {
      summary: parts.join(" "),
      data: {
        className: cls.className,
        classSize: cls.rows.length,
        strengthOfField: cls.sof,
        rows: near.map(standingsEntry),
      },
    };
  },
});

const getLapTimes = tool({
  name: "get_lap_times",
  title: "Lap times",
  description:
    "The driver's last and best lap, and the fastest lap in their class and who set it. Call for \"what was my last lap\", \"how far off the pace am I\".",
  input: {},
  run(state) {
    const view = state.race();
    const me = playerRow(view);
    const fastest = me?.cls.rows.find((r) => r.fastest) ?? null;
    const last = lapTime(view.lastLapS);
    const best = lapTime(view.bestLapS);
    const offPaceS =
      fastest?.bestLapS != null && view.bestLapS !== null ? view.bestLapS - fastest.bestLapS : null;

    const parts: string[] = [];
    parts.push(last === null ? "No lap time yet." : `Last lap ${last}.`);
    if (best !== null) parts.push(`Best ${best}.`);
    if (fastest !== null && fastest.bestLapS !== null) {
      parts.push(
        fastest.isPlayer
          ? "That is the fastest lap in class."
          : `Fastest in class is ${lapTime(fastest.bestLapS) ?? ""} by ${car(fastest)}${offPaceS === null ? "" : `, ${round(offPaceS, 2)} seconds quicker than your best`}.`,
      );
    }

    return {
      summary: parts.join(" "),
      data: {
        lastLap: last,
        lastLapS: orNull(view.lastLapS, 3),
        bestLap: best,
        bestLapS: orNull(view.bestLapS, 3),
        classFastestLap: lapTime(fastest?.bestLapS ?? null),
        classFastestBy: fastest === null ? null : { carNumber: fastest.carNumber, name: fastest.name },
        offClassFastestS: orNull(offPaceS, 3),
      },
    };
  },
});

const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

const CORNERS = [
  ["lf", "front left"],
  ["rf", "front right"],
  ["lr", "rear left"],
  ["rr", "rear right"],
] as const;

const getTyres = tool({
  name: "get_tyres",
  title: "Tyres",
  description:
    "Tread remaining and carcass temperature per tyre. The sim only updates these while the car is in its pit stall, so on track they are from the last stop — say so when answering.",
  input: {},
  run(state) {
    const view = state.race();
    const tyres = CORNERS.map(([key, label]) => {
      const t = view.tyres[key];
      return {
        tyre: label,
        treadPct: round(mean(t.wear) * 100, 0),
        tempC: round(mean(t.tempC), 0),
        coldPressureKpa: round(t.coldPressureKpa, 0),
      };
    });
    const worst = tyres.reduce((a, b) => (b.treadPct < a.treadPct ? b : a));

    return {
      summary:
        `As of the last pit stop: ${tyres.map((t) => `${t.tyre} ${t.treadPct} percent`).join(", ")}. ` +
        `Most worn is the ${worst.tyre}. The sim does not report tyre wear on track.`,
      data: { asOf: "last time in the pit stall", tyres },
    };
  },
});

const getDamage = tool({
  name: "get_damage",
  title: "Damage",
  description:
    "How much repair time the car is carrying, mandatory and optional. That is all the sim says about damage; it does not say what is broken.",
  input: {},
  run(state) {
    const view = state.race();
    const required = round(view.repairS, 0);
    const optional = round(view.optionalRepairS, 0);
    const summary =
      required === 0 && optional === 0
        ? "No damage reported."
        : `${required === 0 ? "No required repairs" : `${required} seconds of required repairs`}, ${
            optional === 0 ? "no optional repairs" : `${optional} seconds of optional repairs`
          }.`;
    return { summary, data: { requiredRepairS: required, optionalRepairS: optional, incidents: view.incidents } };
  },
});

/** Every tool, in the order a client lists them. All read-only. */
export const TOOLS: readonly AssistantTool[] = [
  getSession,
  getFuel,
  getWeather,
  getRelative,
  getGapTrend,
  getStandings,
  getLapTimes,
  getTyres,
  getDamage,
] as unknown as readonly AssistantTool[];
