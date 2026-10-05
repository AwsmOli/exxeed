import { describe, expect, it } from "vitest";

import type { RaceView } from "@exxeed/overlays";

import { AssistantState, lapTime, NoLiveData, TOOLS, type ToolReply } from "@exxeed/assistant";

import { rel, row, view, withGaps } from "./fixture.js";

function live(v: RaceView = view()): AssistantState {
  const state = new AssistantState(() => 0);
  state.onSession({ phase: "running", trackName: "Spa", carName: "Porsche 992 GT3 R", testMode: false });
  state.onRace(0, v);
  return state;
}

function call(state: AssistantState, name: string, args: Record<string, unknown> = {}): ToolReply {
  const tool = TOOLS.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return tool.run(state, args);
}

describe("lapTime", () => {
  it("formats the way a timing screen does", () => {
    expect(lapTime(92.3456)).toBe("1:32.346");
    expect(lapTime(59.5)).toBe("59.500");
    expect(lapTime(125.004)).toBe("2:05.004");
    expect(lapTime(null)).toBeNull();
  });
});

describe("with no live data", () => {
  it("every tool says so rather than answering from nothing", () => {
    const state = new AssistantState(() => 0);
    for (const tool of TOOLS) {
      expect(() => tool.run(state, { side: "both" }), tool.name).toThrow(NoLiveData);
    }
  });

  it("a view that has gone stale is not live", () => {
    let now = 0;
    const state = new AssistantState(() => now);
    state.onRace(0, view());
    now = 2000;
    expect(call(state, "get_fuel").data["levelL"]).toBe(30);
    now = 10_000;
    expect(() => call(state, "get_fuel")).toThrow(NoLiveData);
  });
});

describe("get_session", () => {
  it("says where the race stands", () => {
    const reply = call(live(), "get_session");
    expect(reply.summary).toBe("Race at Spa in the Porsche 992 GT3 R. Lap 5 of 20. P2. 15 laps to go.");
    expect(reply.data).toMatchObject({ position: 2, lapsRemaining: 15, incidents: 2 });
  });

  it("falls back to the clock in a timed race, and reads out a flag", () => {
    const reply = call(
      live(view({ lapsTotal: 32767, lapsRemain: 32767, timeRemainS: 3725, flag: { kind: "yellow", waving: true } })),
      "get_session",
    );
    expect(reply.summary).toContain("Lap 5.");
    expect(reply.summary).toContain("1 h 2 min to go.");
    expect(reply.summary).toContain("Waved yellow flag is out.");
    expect(reply.data["lapsRemaining"]).toBeNull();
  });
});

describe("get_fuel", () => {
  it("answers 'do I need to refuel' with a yes and a number", () => {
    const reply = call(live(), "get_fuel");
    expect(reply.data).toMatchObject({ needsStop: true, litresToAdd: 7.5, lapsOfFuel: 12, lapsToFinish: 15 });
    expect(reply.summary).toContain("You need to stop and add at least 7.5 litres.");
  });

  it("answers with a no when it reaches the finish", () => {
    const v = view();
    const reply = call(live({ ...v, fuel: { ...v.fuel, levelL: 40, lapsLeft: 16, marginL: 2.5 } }), "get_fuel");
    expect(reply.data).toMatchObject({ needsStop: false, litresToAdd: 0 });
    expect(reply.summary).toContain("you make it with 2.5 litres to spare");
  });

  it("says when one stop cannot cover it", () => {
    const v = view();
    const reply = call(
      live({ ...v, fuel: { ...v.fuel, levelL: 50, toFinishL: 100, marginL: -50 } }),
      "get_fuel",
    );
    expect(reply.summary).toContain("The tank only has room for 10");
  });

  it("does not guess before a lap has been measured", () => {
    const v = view();
    const reply = call(
      live({ ...v, fuel: { ...v.fuel, perLapL: null, lapsLeft: null, toFinishL: null, marginL: null } }),
      "get_fuel",
    );
    expect(reply.data).toMatchObject({ needsStop: null, litresToAdd: null, perLapL: null });
    expect(reply.summary).toContain("No per-lap figure yet");
  });
});

describe("get_weather", () => {
  it("reads out the conditions in spoken units", () => {
    const reply = call(live(), "get_weather");
    expect(reply.summary).toBe(
      "Track is dry. No rain. Air 22 degrees, track 30. Skies clear. Wind 18 kilometres an hour from the east.",
    );
  });

  it("says when it is raining", () => {
    const v = view();
    const reply = call(
      live({ ...v, weather: { ...v.weather, precipitation: 0.4, wetness: "lightly wet", declaredWet: true } }),
      "get_weather",
    );
    expect(reply.summary).toContain("Track is lightly wet, declared wet. Raining, 40 percent.");
  });
});

describe("get_relative", () => {
  it("names the nearest car each way", () => {
    const reply = call(live(), "get_relative");
    expect(reply.summary).toBe(
      "Ahead: car 0 (Driver 0), 2 seconds, same lap. Behind: car 2 (Driver 2), 1.5 seconds, same lap.",
    );
  });

  it("picks the nearest, not the first listed, and flags a lapped car", () => {
    const reply = call(
      live(
        view({
          relatives: [
            rel({ carIdx: 5, gapS: 6 }),
            rel({ carIdx: 0, gapS: 2, lapState: -1 }),
            rel({ carIdx: 1, gapS: 0, isPlayer: true }),
          ],
        }),
      ),
      "get_relative",
    );
    expect(reply.summary).toBe("Ahead: car 0 (Driver 0), 2 seconds, a lap down. Nobody close behind.");
  });
});

describe("get_gap_trend", () => {
  /** `seconds` of racing with the car behind closing `perLapS` a (100 s) lap. */
  function closing(perLapS: number, seconds = 130): AssistantState {
    const state = new AssistantState(() => 0);
    state.onSession({ phase: "running", trackName: "Spa", carName: "Porsche 992 GT3 R", testMode: false });
    for (let i = 0; i <= seconds * 5; i++) {
      const t = i / 5;
      state.onRace(t, withGaps(2, 3 - (perLapS / 100) * t, 3 + t / 100));
    }
    return state;
  }

  it("answers 'is the car behind gaining'", () => {
    const reply = call(closing(0.2), "get_gap_trend", { side: "behind" });
    expect(reply.summary).toBe(
      "car 2 (Driver 2) is 2.7 seconds behind and gaining 0.2 seconds a lap: on you in about 14 laps.",
    );
    expect(reply.data["cars"]).toMatchObject([
      { trend: "closing", closingPerLapS: 0.2, side: "behind", measured: "lap over lap" },
    ]);
  });

  it("hedges the figure before a full lap has been seen", () => {
    const reply = call(closing(0.2, 60), "get_gap_trend", { side: "behind" });
    expect(reply.summary).toContain("gaining about 0.2 seconds a lap");
    expect(reply.data["cars"]).toMatchObject([{ measured: "last 60 seconds" }]);
  });

  it("says when they are dropping back", () => {
    const reply = call(closing(-0.3), "get_gap_trend", { side: "behind" });
    expect(reply.summary).toContain("dropping back 0.3 seconds a lap");
  });

  it("calls a gap inside the noise steady", () => {
    const reply = call(closing(0.01), "get_gap_trend", { side: "behind" });
    expect(reply.summary).toContain("the gap is steady");
  });

  it("reports both neighbours, behind first", () => {
    const reply = call(closing(0.2), "get_gap_trend", { side: "both" });
    expect(reply.data["cars"]).toMatchObject([
      { side: "behind", trend: "closing" },
      { side: "ahead", trend: "steady" },
    ]);
  });

  it("falls back on last laps before there is a trend", () => {
    const reply = call(live(), "get_gap_trend", { side: "behind" });
    expect(reply.summary).toBe(
      "car 2 (Driver 2) is 1.5 seconds behind. Not enough history for a trend yet. Their last lap was 0.3 seconds faster than yours.",
    );
    expect(reply.data["cars"]).toMatchObject([{ trend: "unknown", closingPerLapS: null }]);
  });

  it("finds a named car, and says when it is not nearby", () => {
    expect(call(closing(0.2), "get_gap_trend", { side: "both", car_number: "#2" }).data["cars"]).toHaveLength(1);
    expect(call(live(), "get_gap_trend", { side: "both", car_number: "99" }).summary).toContain(
      "Car 99 is not among the cars near you",
    );
  });
});

describe("get_standings", () => {
  it("gives the position, the leader and the places either side", () => {
    const reply = call(live(), "get_standings");
    expect(reply.summary).toBe(
      "P2 of 3. car 0 (Driver 0) leads, 2 seconds up the road. P1 car 0 (Driver 0) is 2 seconds ahead. P3 car 2 (Driver 2) is 1.5 seconds behind.",
    );
  });

  it("says when the driver leads", () => {
    const v = view();
    const reply = call(
      live({
        ...v,
        classes: [
          {
            ...v.classes[0]!,
            rows: [row({ carIdx: 1, isPlayer: true, classPosition: 1 }), row({ carIdx: 2, intervalS: 4, gapS: 4, classPosition: 2 })],
          },
        ],
      }),
      "get_standings",
    );
    expect(reply.summary).toBe("P1 of 2. You are leading. P2 car 2 (Driver 2) is 4 seconds behind.");
  });
});

describe("get_lap_times", () => {
  it("compares the best lap with the class's fastest", () => {
    const reply = call(live(), "get_lap_times");
    expect(reply.summary).toBe(
      "Last lap 1:40.000. Best 1:39.000. Fastest in class is 1:38.000 by car 0 (Driver 0), 1 seconds quicker than your best.",
    );
  });
});

describe("get_tyres and get_damage", () => {
  it("finds the most worn tyre and admits how old the reading is", () => {
    const reply = call(live(), "get_tyres");
    expect(reply.summary).toContain("Most worn is the rear right.");
    expect(reply.summary).toContain("As of the last pit stop");
  });

  it("reports repair time, or none", () => {
    expect(call(live(), "get_damage").summary).toBe("No damage reported.");
    expect(call(live(view({ repairS: 42, optionalRepairS: 0 })), "get_damage").summary).toBe(
      "42 seconds of required repairs, no optional repairs.",
    );
  });
});
