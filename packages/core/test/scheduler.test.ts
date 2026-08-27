import { describe, expect, it } from "vitest";

import type { Candidate, Note, PumpInput } from "@exxeed/core";
import {
  compareCandidates,
  DEFAULT_PROFILE,
  metres,
  mps,
  pct,
  QUEUE_DEPTH,
  Scheduler,
} from "@exxeed/core";

import { spaGt3Notes, SPA_LENGTH_M } from "./fixtures.js";

const SPA = metres(SPA_LENGTH_M);
const V250 = mps(69);

const baseNote = spaGt3Notes.notes[0]!; // audio 1240 ms, short 720 ms

/** A note at a chosen priority, with a chosen event position. */
const noteAt = (id: string, priority: number, overrides: Partial<Note> = {}): Note => ({
  ...baseNote,
  id,
  priority,
  leadAdjustS: 0,
  ...overrides,
});

const at = (eventPct: number, note: Note): Candidate => ({ note, eventPct: pct(eventPct) });

const input = (lapDistPct: number, tMs: number, speedMps = V250): PumpInput => ({
  tMs,
  lapDistPct: pct(lapDistPct),
  speedMps,
});

/** Fresh scheduler with the clock advanced twice, so the fit tolerance is sane. */
function scheduler(startPct = 0.5): Scheduler {
  const s = new Scheduler(SPA, DEFAULT_PROFILE);
  s.advance(0);
  s.pump(input(startPct, 0));
  s.advance(16);
  return s;
}

describe("fit test and the short-form fallback", () => {
  it("plays the full form when there is room", () => {
    const s = scheduler(0.3);
    // Event 400 m ahead; the full form needs 1.74 s × 69 = 120 m.
    s.admit(at(0.3 + 400 / SPA_LENGTH_M, noteAt("n", 1)), input(0.3, 16));

    const [event] = s.pump(input(0.3, 16));
    expect(event?.kind).toBe("play");
    expect(event?.kind === "play" && event.variant).toBe("full");
    expect(event?.kind === "play" && event.durationMs).toBe(1240);
  });

  it("falls back to the short form when the full one no longer fits", () => {
    const s = scheduler(0.3);
    // Event 100 m ahead. Full needs 120 m, short needs (0.72+0.5)×69 = 84.2 m.
    s.admit(at(0.3 + 100 / SPA_LENGTH_M, noteAt("n", 1)), input(0.3, 16));

    const [event] = s.pump(input(0.3, 16));
    expect(event?.kind === "play" && event.variant).toBe("short");
    expect(event?.kind === "play" && event.durationMs).toBe(720);
  });

  it("drops rather than speaking too late — at every priority, including 1", () => {
    // SPEC.md §6.3: "A braking cue that arrives after the braking point is worse
    // than silence — it makes the driver flinch mid-corner." There is no priority
    // high enough to override this.
    const s = scheduler(0.3);
    // Event 40 m ahead. Even the short form needs 84 m.
    s.admit(at(0.3 + 40 / SPA_LENGTH_M, noteAt("urgent", 1)), input(0.3, 16));

    const [event] = s.pump(input(0.3, 16));
    expect(event?.kind).toBe("drop");
    expect(event?.kind === "drop" && event.reason).toBe("no_fit_after_short");
  });

  it("a dropped note does not consume the channel, so the next one still speaks", () => {
    const s = scheduler(0.3);
    s.admit(at(0.3 + 40 / SPA_LENGTH_M, noteAt("too_late", 1)), input(0.3, 16));
    s.admit(at(0.3 + 400 / SPA_LENGTH_M, noteAt("in_time", 1)), input(0.3, 16));

    const events = s.pump(input(0.3, 16));
    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe("drop");
    expect(events[1]?.kind).toBe("play");
    expect(events[1]?.noteId).toBe("in_time");
  });
});

describe("one channel", () => {
  it("holds a second note back while the first is still speaking", () => {
    const s = scheduler(0.3);
    s.admit(at(0.3 + 400 / SPA_LENGTH_M, noteAt("first", 1)), input(0.3, 16));
    expect(s.pump(input(0.3, 16))).toHaveLength(1);

    s.admit(at(0.3 + 500 / SPA_LENGTH_M, noteAt("second", 1)), input(0.31, 32));
    // 1240 ms of audio started at t=16, so nothing else can start before t=1256.
    expect(s.pump(input(0.31, 500))).toHaveLength(0);
    expect(s.queued()).toEqual(["second"]);
  });

  it("serves the queue once the channel frees up", () => {
    const s = scheduler(0.3);
    s.admit(at(0.3 + 400 / SPA_LENGTH_M, noteAt("first", 1)), input(0.3, 16));
    s.pump(input(0.3, 16));

    s.admit(at(0.5, noteAt("second", 1)), input(0.31, 32));
    const [event] = s.pump(input(0.45, 1300));

    expect(event?.kind).toBe("play");
    expect(event?.noteId).toBe("second");
  });
});

describe("admission when the queue is full", () => {
  const full = (): Scheduler => {
    const s = scheduler(0.3);
    // Occupy the channel so nothing drains, then fill both queue slots.
    s.admit(at(0.4, noteAt("speaking", 1)), input(0.3, 16));
    s.pump(input(0.3, 16));
    s.admit(at(0.5, noteAt("queued_p2", 2)), input(0.3, 32));
    s.admit(at(0.6, noteAt("queued_p3", 3)), input(0.3, 32));
    return s;
  };

  it("holds exactly two", () => {
    const s = full();
    expect(s.queued()).toHaveLength(QUEUE_DEPTH);
  });

  it("evicts the worst queued note for a higher-priority arrival", () => {
    const s = full();
    const drops = s.admit(at(0.7, noteAt("urgent", 1)), input(0.3, 48));

    expect(drops).toHaveLength(1);
    expect(drops[0]?.noteId).toBe("queued_p3");
    expect(drops[0]?.reason).toBe("evicted");
    expect(s.queued()).toContain("urgent");
  });

  it("drops the arrival when it is not better than what is queued", () => {
    const s = full();
    const drops = s.admit(at(0.7, noteAt("meh", 4)), input(0.3, 48));

    expect(drops).toHaveLength(1);
    expect(drops[0]?.noteId).toBe("meh");
    expect(drops[0]?.reason).toBe("queue_full");
    expect(s.queued()).not.toContain("meh");
  });
});

describe("two priority-1 notes contending — the §9 required test", () => {
  it("resolves deterministically by event position, sooner first", () => {
    const s = scheduler(0.3);
    s.admit(at(0.4, noteAt("blocker", 1)), input(0.3, 16));
    s.pump(input(0.3, 16));

    // Both priority 1. Without the tie-break the outcome would depend on
    // iteration order and the golden-file timeline (§9) would not reproduce.
    s.admit(at(0.60, noteAt("later_event", 1)), input(0.3, 32));
    s.admit(at(0.45, noteAt("sooner_event", 1)), input(0.3, 32));

    // Queue is now full of two priority-1s. A third arrives, also priority 1,
    // whose event is sooner than both.
    const drops = s.admit(at(0.35, noteAt("soonest", 1)), input(0.3, 48));

    expect(drops[0]?.noteId).toBe("later_event");
    expect(drops[0]?.reason).toBe("evicted");
    expect([...s.queued()].sort()).toEqual(["sooner_event", "soonest"]);
  });

  it("serves the sooner event first when both are ready", () => {
    const s = scheduler(0.3);
    s.admit(at(0.60, noteAt("later_event", 1)), input(0.3, 16));
    s.admit(at(0.35, noteAt("sooner_event", 1)), input(0.3, 16));

    const [first] = s.pump(input(0.3, 16));
    expect(first?.noteId).toBe("sooner_event");
  });

  it("gives the same answer whichever order the notes arrive in", () => {
    const build = (order: readonly string[]): readonly string[] => {
      const s = scheduler(0.3);
      s.admit(at(0.4, noteAt("blocker", 1)), input(0.3, 16));
      s.pump(input(0.3, 16));
      const events: Record<string, number> = { a: 0.5, b: 0.45, c: 0.55 };
      for (const id of order) {
        s.admit(at(events[id]!, noteAt(id, 1)), input(0.3, 32));
      }
      return [...s.queued()].sort();
    };

    expect(build(["a", "b", "c"])).toEqual(["a", "b"]);
    expect(build(["c", "b", "a"])).toEqual(["a", "b"]);
    expect(build(["b", "c", "a"])).toEqual(["a", "b"]);
  });
});

describe("compareCandidates", () => {
  it("puts lower priority numbers first", () => {
    const a = at(0.9, noteAt("a", 1));
    const b = at(0.4, noteAt("b", 2));
    // Priority beats position: a is priority 1 even though b's event is sooner.
    expect(compareCandidates(a, b, pct(0.3), SPA)).toBeLessThan(0);
  });

  it("breaks ties by which event comes sooner, wrapping safely", () => {
    const soon = at(0.02, noteAt("soon", 1));
    const later = at(0.4, noteAt("later", 1));
    // From pct 0.98, the event at 0.02 is 280 m away and the one at 0.4 is 2941 m
    // away — despite 0.02 being the numerically smaller percentage.
    expect(compareCandidates(soon, later, pct(0.98), SPA)).toBeLessThan(0);
  });
});

describe("flush", () => {
  it("discards the queue with a reason rather than silently", () => {
    const s = scheduler(0.3);
    s.admit(at(0.4, noteAt("a", 1)), input(0.3, 16));
    s.pump(input(0.3, 16));
    s.admit(at(0.5, noteAt("b", 1)), input(0.3, 32));

    const dropped = s.flush(input(0.3, 32));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.reason).toBe("suppressed");
    expect(s.queued()).toEqual([]);
  });
});

describe("a note whose event has already gone past", () => {
  it("is dropped, not spoken with a nonsense lead", () => {
    // Found by replaying a real timeline, not by unit tests. `aheadM` is always
    // positive (§4.6), so an event 14 m behind the car reports as 6990 m ahead —
    // which passes any fit test you care to write. The note then "plays" for a
    // corner the driver has already been through.
    const s = scheduler(0.3);

    // Occupy the channel, queue a note, then let the car drive past its event
    // while the channel is still busy.
    s.admit(at(0.4, noteAt("speaking", 1)), input(0.3, 16));
    s.pump(input(0.3, 16));
    s.admit(at(0.42, noteAt("missed", 1)), input(0.3, 32));

    s.advance(1300);
    const [event] = s.pump(input(0.45, 1300));

    expect(event?.kind).toBe("drop");
    expect(event?.kind === "drop" && event.reason).toBe("event_passed");
  });

  it("still speaks a note whose event is genuinely ahead", () => {
    const s = scheduler(0.3);
    s.admit(at(0.4, noteAt("speaking", 1)), input(0.3, 16));
    s.pump(input(0.3, 16));
    s.admit(at(0.5, noteAt("still_ahead", 1)), input(0.3, 32));

    s.advance(1300);
    const [event] = s.pump(input(0.45, 1300));

    expect(event?.kind).toBe("play");
    expect(event?.noteId).toBe("still_ahead");
  });
});
