import { describe, expect, it } from "vitest";

import type { EngineEvent, Note, ResolvedNote } from "@exxeed/core";
import {
  aheadM,
  indexLandmarks,
  metres,
  mps,
  NoteEngine,
  offsetPct,
  pct,
  resolveNotes,
} from "@exxeed/core";

import { spaGt3Notes, spaLandmarks, spaMap, SPA_LENGTH_M } from "./fixtures.js";

const SPA = metres(SPA_LENGTH_M);
const landmarks = indexLandmarks(spaLandmarks);

/** 250 km/h, the speed the §6.1 and §6.2 worked examples use. */
const V250 = mps(69);

const resolved = (notes: readonly Note[]): readonly ResolvedNote[] =>
  resolveNotes(notes, spaMap, landmarks).resolved;

/** The braking note only. Anchored at the 100 board, pct 0.99781. */
const brakeOnly = resolved([spaGt3Notes.notes[0]!]);

/**
 * The note that actually reproduces the start/finish double-fire.
 *
 * The bug needs the trigger point on ONE side of the line and the event on the
 * OTHER. Both illustrations in the spec (§6.2's worked example and §9's required
 * test) describe a note anchored at 0.99781 — but that event sits BEFORE the
 * line, so by the time the fired-set is cleared the event is already a whole lap
 * behind and even the naive design cannot re-fire. Verified: after crossing at
 * pct 0.0, the 100 board is 6988 m ahead.
 *
 * Anchor to turn 1's ENTRY instead (pct 0.0121, i.e. 84.7 m into the lap) and the
 * numbers line up: a 1.24 s callout at 69 m/s needs 120 m of lead, so it fires at
 * pct 0.99496 — before the line — for an event 84.7 m AFTER it. Clear the set at
 * the line and dAhead is 84.7 m against a 120 m lead, so it fires a second time,
 * a beat before the corner.
 */
const t1EntryBrake: Note = {
  ...spaGt3Notes.notes[0]!,
  id: "t1_entry_brake",
  phase: "brake",
  anchor: { type: "corner", cornerIndex: 1, offsetM: 0 },
  leadAdjustS: 0,
};

const entryBrakeOnly = resolved([t1EntryBrake]);

/**
 * Drive a car forward at constant speed, ticking the engine every `stepM` metres,
 * and collect everything it emits. Returns events plus where each one happened.
 */
function drive(
  engine: NoteEngine,
  fromPct: number,
  distanceM: number,
  speedMps = V250,
  stepM = 1,
): EngineEvent[] {
  const events: EngineEvent[] = [];
  let p = pct(fromPct);

  for (let travelled = 0; travelled <= distanceM; travelled += stepM) {
    events.push(...engine.tick({ lapDistPct: p, speedMps }));
    p = offsetPct(p, metres(stepM), SPA);
  }

  return events;
}

describe("out-lap silence", () => {
  it("fires nothing before the car has been round once", () => {
    // SPEC.md §6.2: every note starts SPENT. A car leaving the pits and arriving
    // at turn 1 for the first time gets no callout, because the note has never
    // been half a lap away from the car since the engine was built.
    const engine = new NoteEngine(brakeOnly, SPA);

    expect(engine.stateOf("t1_brake")).toBe("SPENT");
    // 0.97 → 0.02, straight through the event at 0.99781.
    expect(drive(engine, 0.97, 0.05 * SPA_LENGTH_M)).toHaveLength(0);
  });
});

describe("start/finish double-fire — the §9 required test", () => {
  // This block is the regression test for the bug §12 calls out as real rather
  // than hypothetical. It was verified by mutation: implementing the naive
  // firedThisLap design makes every test in here fail, and the engine as written
  // makes them pass.

  it("fires exactly once when the trigger is before the line and the event after it", () => {
    const engine = new NoteEngine(entryBrakeOnly, SPA);

    // Arm it by going most of the way round, then make the approach.
    drive(engine, 0.05, 0.85 * SPA_LENGTH_M);
    expect(engine.stateOf("t1_entry_brake")).toBe("ARMED");

    // 0.98 through start/finish to 0.03. Fires at 0.99496. A firedThisLap set
    // cleared at the line would re-arm it 84.7 m from an event needing 120 m of
    // lead, and it would speak again just before the corner.
    const events = drive(engine, 0.98, 0.05 * SPA_LENGTH_M);

    expect(events).toHaveLength(1);
    expect(events[0]?.noteId).toBe("t1_entry_brake");
    expect(events[0]?.atPct).toBeCloseTo(0.99496, 3);
  });

  it("stays silent for the rest of the approach after crossing the line", () => {
    const engine = new NoteEngine(entryBrakeOnly, SPA);
    drive(engine, 0.05, 0.85 * SPA_LENGTH_M);

    const beforeLine = drive(engine, 0.98, 0.019 * SPA_LENGTH_M); // 0.98 → 0.999
    const afterLine = drive(engine, 0.0, 0.03 * SPA_LENGTH_M); // 0.0 → 0.03, past the event

    expect(beforeLine).toHaveLength(1);
    // The assertion the naive design fails.
    expect(afterLine).toHaveLength(0);
  });

  it("fires once per lap over three laps, not twice", () => {
    const engine = new NoteEngine(entryBrakeOnly, SPA);
    const events = drive(engine, 0.1, 3 * SPA_LENGTH_M);

    expect(events).toHaveLength(3);

    // And the fires are a lap apart, not clustered either side of the line.
    for (let i = 1; i < events.length; i++) {
      const gap = aheadM(events[i - 1]!.atPct, events[i]!.atPct, SPA);
      expect(gap).toBeGreaterThan(0.9 * SPA_LENGTH_M);
    }
  });

  it("also fires once for an event that sits before the line", () => {
    // The 100 board case. Not where the bug lives, but it is the wrapping
    // landmark from §4.2 and it must not regress either.
    const engine = new NoteEngine(brakeOnly, SPA);
    const events = drive(engine, 0.1, 2 * SPA_LENGTH_M);

    expect(events).toHaveLength(2);
    expect(events[0]?.atPct).toBeCloseTo(0.98264, 3);
  });
});

describe("fire position", () => {
  it("fires where the arithmetic says, not at a fixed percentage", () => {
    const engine = new NoteEngine(brakeOnly, SPA);
    drive(engine, 0.1, 0.8 * SPA_LENGTH_M);

    const [event] = drive(engine, 0.95, 0.06 * SPA_LENGTH_M, V250, 0.5);
    expect(event).toBeDefined();

    // 1.24 s audio + 0.5 s buffer − 0.2 s author adjustment = 1.54 s.
    // At 69 m/s that is 106.3 m, i.e. pct 0.99781 − 0.01518 = 0.98263.
    expect(event!.leadM).toBeCloseTo(106.26, 1);
    expect(event!.atPct).toBeCloseTo(0.98263, 3);
    expect(event!.dAheadM).toBeLessThanOrEqual(event!.leadM);
  });

  it("fires earlier on track when the car is going faster", () => {
    const fast = new NoteEngine(brakeOnly, SPA);
    const slow = new NoteEngine(brakeOnly, SPA);
    drive(fast, 0.1, 0.8 * SPA_LENGTH_M, mps(69), 2);
    drive(slow, 0.1, 0.8 * SPA_LENGTH_M, mps(25), 2);

    const [fastFire] = drive(fast, 0.95, 0.06 * SPA_LENGTH_M, mps(69), 0.5);
    const [slowFire] = drive(slow, 0.95, 0.06 * SPA_LENGTH_M, mps(25), 0.5);

    expect(fastFire!.leadM).toBeGreaterThan(slowFire!.leadM * 2);
    // Same event, but the fast car hears it much further back down the road.
    expect(fastFire!.atPct).toBeLessThan(slowFire!.atPct);
  });

  it("respects a driver's profile preference", () => {
    const build = (leadAdjustS: number): NoteEngine => {
      const engine = new NoteEngine(brakeOnly, SPA, { leadAdjustS });
      drive(engine, 0.1, 0.8 * SPA_LENGTH_M, V250, 2);
      return engine;
    };

    const [plain] = drive(build(0), 0.95, 0.06 * SPA_LENGTH_M, V250, 0.5);
    const [early] = drive(build(0.5), 0.95, 0.06 * SPA_LENGTH_M, V250, 0.5);

    // Half a second more warning at 69 m/s is ~34.5 m further back.
    expect(early!.leadM - plain!.leadM).toBeCloseTo(34.5, 0);
  });
});

describe("state machine", () => {
  it("re-arms only once the event is more than half a lap away", () => {
    const engine = new NoteEngine(brakeOnly, SPA);

    // Event at 0.99781. Sitting just past it, it is nearly a full lap ahead.
    engine.tick({ lapDistPct: pct(0.01), speedMps: V250 });
    expect(engine.stateOf("t1_brake")).toBe("ARMED");

    engine.reset();

    // A third of a lap ahead is not enough.
    engine.tick({ lapDistPct: pct(0.7), speedMps: V250 });
    expect(engine.stateOf("t1_brake")).toBe("SPENT");
  });

  it("survives a reset to pits without needing to know one happened", () => {
    // SPEC.md §6.2: the half-lap rule survives resets, tows and pit exits for
    // free, because it never counts laps in the first place.
    const engine = new NoteEngine(brakeOnly, SPA);
    drive(engine, 0.1, 0.8 * SPA_LENGTH_M);
    expect(engine.stateOf("t1_brake")).toBe("ARMED");

    // Teleported backwards to the pit exit mid-lap. No event, no notification.
    engine.tick({ lapDistPct: pct(0.02), speedMps: mps(0) });
    expect(engine.stateOf("t1_brake")).toBe("ARMED");

    const events = drive(engine, 0.95, 0.06 * SPA_LENGTH_M);
    expect(events).toHaveLength(1);
  });

  it("tracks notes independently", () => {
    const engine = new NoteEngine(resolved(spaGt3Notes.notes), SPA);
    const events = drive(engine, 0.1, SPA_LENGTH_M);

    // t1_brake at 0.99781, t1_throttle at the apex 0.018 — both fire, once each.
    expect(events.map((e) => e.noteId).sort()).toEqual(["t1_brake", "t1_throttle"]);
  });

  it("reports state for the dev overlay without exposing internals", () => {
    const engine = new NoteEngine(brakeOnly, SPA);
    const snapshot = engine.states();
    expect(snapshot.get("t1_brake")).toBe("SPENT");

    engine.tick({ lapDistPct: pct(0.01), speedMps: V250 });
    // The snapshot is a copy, so it did not move under the caller.
    expect(snapshot.get("t1_brake")).toBe("SPENT");
    expect(engine.stateOf("t1_brake")).toBe("ARMED");
  });

  it("ignores notes it was never given", () => {
    const engine = new NoteEngine(brakeOnly, SPA);
    expect(engine.stateOf("nonexistent")).toBeUndefined();
  });
});
