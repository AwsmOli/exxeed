import { describe, expect, it } from "vitest";

import type { Note } from "@exxeed/core";
import { aheadM, DEFAULT_PROFILE, metres, mps, NoteEngine } from "@exxeed/core";

import { spaGt3Notes, SPA_LENGTH_M } from "./fixtures.js";
import { Car, drops, plays } from "./harness.js";

const SPA = metres(SPA_LENGTH_M);

/** The 100 board note. Its point is pct 0.99781 — before the start/finish line. */
const brakeOnly = [spaGt3Notes.notes[0]!];

/**
 * The note that actually reproduces the start/finish double-fire.
 *
 * The bug needs the trigger point on ONE side of the line and the event on the
 * OTHER. Both illustrations in the spec (§6.2's worked example and §9's required
 * test) put the note at 0.998 — but that point sits BEFORE the line,
 * so by the time a naive fired-set is cleared the event is a whole lap behind
 * (6988 m) and even the broken design cannot re-fire.
 *
 * Put the note at turn 1's entry instead — pct 0.0121, 84.7 m into the lap — and the
 * numbers line up: a 1.24 s callout at 69 m/s needs 120 m of lead, so it fires at
 * pct 0.99496 — before the line — for an event 84.7 m AFTER it. Clear the set at
 * the line and dAhead is 84.7 m against a 120 m lead, so it speaks a second time,
 * a beat before the corner.
 */
const t1EntryBrake: Note = {
  ...spaGt3Notes.notes[0]!,
  id: "t1_entry_brake",
  pct: 0.0121,
  leadAdjustS: 0,
};

const entryBrakeOnly = [t1EntryBrake];

/**
 * An engine and a car past the out-lap gate (§6.4 requires one completed lap) and
 * with every note armed, parked just before the approach to turn 1.
 */
function ready(notes: readonly Note[], leadAdjustS = 0) {
  const engine = new NoteEngine(notes, SPA, { leadAdjustS });
  const car = new Car(0.05);
  car.drive(engine, 1.1 * SPA_LENGTH_M, { stepM: 5 });
  return { engine, car };
}

describe("out-lap silence", () => {
  it("says nothing on the very first lap", () => {
    // Two independent mechanisms cover this: every note starts SPENT (§6.2), and
    // suppression holds until one lap has completed since IsOnTrack went true
    // (§6.4).
    const engine = new NoteEngine(entryBrakeOnly, SPA);
    const car = new Car(0.5);

    const events = car.drive(engine, 0.49 * SPA_LENGTH_M, { stepM: 2 });

    expect(events).toHaveLength(0);
    expect(car.lastSuppression).toBe("out_lap");
  });

  it("starts speaking once a lap has completed", () => {
    const { engine, car } = ready(entryBrakeOnly);
    expect(car.lastSuppression).toBeNull();

    car.teleport(0.98);
    expect(plays(car.drive(engine, 0.05 * SPA_LENGTH_M))).toHaveLength(1);
  });
});

describe("assumeLapComplete", () => {
  it("arms every note as well as opening the §6.4 gate", () => {
    // Opening the gate alone does almost nothing. §6.2 starts notes SPENT, and a
    // note re-arms only once its point is more than half a lap away — so from the
    // line, only the back half of the lap would ever speak. On Daytona that was
    // one note out of six, which reads as "the fix did not work".
    const engine = new NoteEngine(entryBrakeOnly, SPA, DEFAULT_PROFILE, {
      assumeLapComplete: true,
    });
    expect(engine.stateOf("t1_entry_brake")).toBe("ARMED");

    const car = new Car(0.98);
    expect(plays(car.drive(engine, 0.05 * SPA_LENGTH_M))).toHaveLength(1);
  });

  it("leaves notes SPENT by default, so the out-lap stays silent", () => {
    const engine = new NoteEngine(entryBrakeOnly, SPA);
    expect(engine.stateOf("t1_entry_brake")).toBe("SPENT");

    const car = new Car(0.98);
    expect(car.drive(engine, 0.05 * SPA_LENGTH_M)).toHaveLength(0);
  });
});

describe("start/finish double-fire — the §9 required test", () => {
  // Verified by mutation: implementing the naive firedThisLap design makes every
  // test in this block fail.

  it("speaks exactly once when the trigger is before the line and the event after", () => {
    const { engine, car } = ready(entryBrakeOnly);
    expect(engine.stateOf("t1_entry_brake")).toBe("ARMED");

    car.teleport(0.98);
    const events = car.drive(engine, 0.05 * SPA_LENGTH_M);

    expect(plays(events)).toHaveLength(1);
    expect(plays(events)[0]?.noteId).toBe("t1_entry_brake");
    expect(plays(events)[0]?.atPct).toBeCloseTo(0.99014, 3);
  });

  it("stays silent for the rest of the approach after crossing the line", () => {
    const { engine, car } = ready(entryBrakeOnly);

    car.teleport(0.98);
    const beforeLine = car.drive(engine, 0.019 * SPA_LENGTH_M);
    car.teleport(0.0);
    const afterLine = car.drive(engine, 0.03 * SPA_LENGTH_M);

    expect(plays(beforeLine)).toHaveLength(1);
    // The assertion the naive design fails.
    expect(afterLine).toHaveLength(0);
  });

  it("speaks once per lap over three laps, not twice", () => {
    const { engine, car } = ready(entryBrakeOnly);
    const events = plays(car.drive(engine, 3 * SPA_LENGTH_M, { stepM: 2 }));

    expect(events).toHaveLength(3);

    for (let i = 1; i < events.length; i++) {
      const gap = aheadM(events[i - 1]!.atPct, events[i]!.atPct, SPA);
      expect(gap).toBeGreaterThan(0.9 * SPA_LENGTH_M);
    }
  });

  it("also speaks once for an event that sits before the line", () => {
    // The 100 board case. Not where the bug lives, but it is §4.2's wrapping
    // landmark and it must not regress either.
    const { engine, car } = ready(brakeOnly);
    const events = plays(car.drive(engine, 2 * SPA_LENGTH_M, { stepM: 2 }));

    expect(events).toHaveLength(2);
    expect(events[0]?.atPct).toBeCloseTo(0.97771, 2);
  });
});

describe("where the callout starts", () => {
  it("starts where the arithmetic says, not at a fixed percentage", () => {
    const { engine, car } = ready(brakeOnly);
    car.teleport(0.95);

    const [event] = plays(car.drive(engine, 0.06 * SPA_LENGTH_M, { stepM: 0.5 }));
    expect(event).toBeDefined();

    // 1.24 s audio + 1.0 s buffer − 0.2 s author adjustment = 2.04 s.
    // At 69 m/s that is 140.8 m, i.e. pct 0.99781 − 0.02010 = 0.97771.
    expect(event!.leadM).toBeCloseTo(140.76, 1);
    expect(event!.atPct).toBeCloseTo(0.97771, 3);
    expect(event!.variant).toBe("full");
  });

  it("starts further back when the car is going faster", () => {
    const fast = ready(brakeOnly);
    const slow = ready(brakeOnly);
    fast.car.teleport(0.95);
    slow.car.teleport(0.95);

    const [fastPlay] = plays(
      fast.car.drive(fast.engine, 0.06 * SPA_LENGTH_M, { speedMps: mps(69), stepM: 0.5 }),
    );
    const [slowPlay] = plays(
      slow.car.drive(slow.engine, 0.06 * SPA_LENGTH_M, { speedMps: mps(25), stepM: 0.5 }),
    );

    expect(fastPlay!.leadM).toBeGreaterThan(slowPlay!.leadM * 2);
    expect(fastPlay!.atPct).toBeLessThan(slowPlay!.atPct);
  });

  it("respects a driver's profile preference", () => {
    const plain = ready(brakeOnly, 0);
    const early = ready(brakeOnly, 0.5);
    plain.car.teleport(0.95);
    early.car.teleport(0.95);

    const [a] = plays(plain.car.drive(plain.engine, 0.06 * SPA_LENGTH_M, { stepM: 0.5 }));
    const [b] = plays(early.car.drive(early.engine, 0.06 * SPA_LENGTH_M, { stepM: 0.5 }));

    // Half a second more warning at 69 m/s is ~34.5 m further back.
    expect(b!.leadM - a!.leadM).toBeCloseTo(34.5, 0);
  });
});

describe("state machine", () => {
  it("re-arms only once the event is more than half a lap away", () => {
    const { engine, car } = ready(entryBrakeOnly);

    // Drive far enough to pass the trigger point at 0.99496, but stop short of
    // the event itself at 0.0121.
    car.teleport(0.98);
    car.drive(engine, 0.02 * SPA_LENGTH_M);
    expect(engine.stateOf("t1_entry_brake")).toBe("SPENT");

    // Still approaching the event at 0.0121: from 0.9 it is 785 m ahead, well
    // under half a lap, so a spent note stays spent. This is what stops a second
    // callout in the same approach.
    engine.reset();
    car.teleport(0.9);
    car.drive(engine, 10);
    expect(engine.stateOf("t1_entry_brake")).toBe("SPENT");

    // Past the event, it is 6388 m ahead — more than half a lap — so it arms for
    // next time round.
    engine.reset();
    car.teleport(0.1);
    car.drive(engine, 10);
    expect(engine.stateOf("t1_entry_brake")).toBe("ARMED");
  });

  it("survives a reset to pits without needing to know one happened", () => {
    const { engine, car } = ready(entryBrakeOnly);
    expect(engine.stateOf("t1_entry_brake")).toBe("ARMED");

    // Teleported backwards mid-lap. The state machine counts no laps, so there
    // is nothing to get out of step.
    car.teleport(0.5);
    car.drive(engine, 10);
    expect(engine.stateOf("t1_entry_brake")).toBe("ARMED");

    car.teleport(0.98);
    expect(plays(car.drive(engine, 0.05 * SPA_LENGTH_M))).toHaveLength(1);
  });

  it("tracks notes independently", () => {
    const { engine, car } = ready(spaGt3Notes.notes);
    const spoken = plays(car.drive(engine, SPA_LENGTH_M, { stepM: 1 }));

    expect(spoken.map((e) => e.noteId).sort()).toEqual(["t1_brake", "t1_throttle"]);
  });

  it("hands the dev overlay a snapshot, not a live view", () => {
    const engine = new NoteEngine(brakeOnly, SPA);
    const snapshot = engine.states();
    expect(snapshot.get("t1_brake")).toBe("SPENT");

    const car = new Car(0.05);
    car.drive(engine, 1.1 * SPA_LENGTH_M, { stepM: 5 });

    expect(snapshot.get("t1_brake")).toBe("SPENT");
    expect(engine.stateOf("t1_brake")).toBe("ARMED");
  });

  it("ignores notes it was never given", () => {
    const engine = new NoteEngine(brakeOnly, SPA);
    expect(engine.stateOf("nonexistent")).toBeUndefined();
  });
});

describe("suppression drops queued notes", () => {
  it("discards the queue rather than releasing a burst on rejoining", () => {
    const { engine, car } = ready(spaGt3Notes.notes);

    // Two notes become due while the channel is busy, then the car goes off.
    car.teleport(0.98);
    car.drive(engine, 0.02 * SPA_LENGTH_M, { stepM: 1 });
    const offTrack = car.drive(engine, 20, { offTrack: true, stepM: 1 });

    expect(car.lastSuppression).toBe("off_track");
    for (const event of drops(offTrack)) {
      expect(event.reason).toBe("suppressed");
    }
  });
});
