/**
 * The note engine — SPEC.md §6.
 *
 * Composes the three pieces: suppression (§6.4) gates everything, the per-note
 * state machine (§6.2) decides when a note is due, and the scheduler (§6.3)
 * decides what actually gets said.
 *
 * ## Why there is no lap counter in the state machine
 *
 * The obvious design is a `firedThisLap` set cleared at the start/finish line.
 * It is wrong, and it fails at exactly the corners people care most about.
 *
 * The failure needs the trigger on one side of the line and the event on the
 * other. Turn 1 at Spa: a note at pct 0.0121 — 84.7 m into the lap — with a
 * 120 m lead fires at pct 0.99496, before the line. Clear the fired-set at the
 * line and `dAhead` is 84.7 m against a 120 m lead, so it speaks again, a beat
 * before the corner.
 *
 * (Note that §6.2's and §9's own worked examples put the note at pct 0.998. That
 * event sits *before* the line, so once the set is cleared the event is a whole
 * lap behind and even the broken design cannot re-fire. The bug is real; the
 * illustration is off by one position. See engine.test.ts.)
 *
 * So this state machine has no concept of a lap at all:
 *
 *   ARMED  --[ dAhead <= leadM ]-->      SPENT   (fire, or drop — both land here)
 *   SPENT  --[ dAhead > lengthM/2 ]-->   ARMED   (event is now half a lap away)
 *
 * Re-arming on "more than half a lap away" is unconditionally correct, needs no
 * lap counter, and survives resets, tows and pit exits for free.
 *
 * ## Purity
 *
 * `tick` takes a plain input rather than a `TelemetryFrame`, because core must
 * not depend on the telemetry package (§3, enforced by lint). That is the point
 * of the boundary, not an inconvenience: the engine can be driven by a recording,
 * a test, or the sim without knowing the difference.
 */

import { aheadM } from "./pct.js";
import type { Note } from "./schema.js";
import type { DriverProfile } from "./profile.js";
import { DEFAULT_PROFILE } from "./profile.js";
import type { Candidate, EngineEvent, PumpInput } from "./scheduler.js";
import { compareCandidates, Scheduler } from "./scheduler.js";
import type {
  SuppressionInput,
  SuppressionOptions,
  SuppressionReason,
} from "./suppression.js";
import { SuppressionGate } from "./suppression.js";
import { leadDistanceM, leadSecondsFor } from "./trigger.js";
import type { Metres, Pct } from "./units.js";
import { pct } from "./units.js";

export type NoteState = "ARMED" | "SPENT";

export interface TickInput extends SuppressionInput, PumpInput {
  readonly lapDistPct: Pct;
}

export interface TickResult {
  readonly events: readonly EngineEvent[];
  /** Non-null when the engine stayed quiet on purpose. For the dev overlay (§7.3). */
  readonly suppressedBy: SuppressionReason | null;
}

export class NoteEngine {
  /** Branded once, at construction. The hot path never calls a unit constructor. */
  readonly #notes: readonly Candidate[];
  readonly #lengthM: Metres;
  readonly #halfLapM: number;
  readonly #profile: DriverProfile;
  readonly #state = new Map<string, NoteState>();
  readonly #gate: SuppressionGate;
  readonly #scheduler: Scheduler;

  constructor(
    notes: readonly Note[],
    lengthM: Metres,
    profile: DriverProfile = DEFAULT_PROFILE,
    suppression: SuppressionOptions = {},
  ) {
    this.#gate = new SuppressionGate(suppression);
    this.#notes = notes.map((note) => ({ note, eventPct: pct(note.pct), dueAtMs: -1 }));
    this.#lengthM = lengthM;
    this.#halfLapM = lengthM / 2;
    this.#profile = profile;
    this.#scheduler = new Scheduler(lengthM, profile);

    // Start everything SPENT so the out-lap is silent (§6.2). Belt and braces
    // with the out-lap suppression rule in §6.4 — they cover the same ground from
    // different directions, and neither alone covers a mid-session note-set swap.
    //
    // Which means `assumeLapComplete` has to relax BOTH, or it does almost
    // nothing: opening the §6.4 gate on a single extracted lap still leaves every
    // note spent, and a note only re-arms once its point is more than half a lap
    // away. Starting at the line, that is true of the back half of the lap and no
    // more — on Daytona exactly one note out of six. If a lap really has been
    // completed then every note has been half a lap away at some point, so ARMED
    // is what the flag means.
    const initial: NoteState = suppression.assumeLapComplete === true ? "ARMED" : "SPENT";
    for (const note of notes) this.#state.set(note.id, initial);
  }

  stateOf(noteId: string): NoteState | undefined {
    return this.#state.get(noteId);
  }

  /** Snapshot for the dev callout overlay (§7.3). */
  states(): ReadonlyMap<string, NoteState> {
    return new Map(this.#state);
  }

  queued(): readonly string[] {
    return this.#scheduler.queued();
  }

  /** Force every note back to SPENT. For loading a different note set mid-session. */
  reset(): void {
    for (const { note } of this.#notes) this.#state.set(note.id, "SPENT");
  }

  tick(input: TickInput): TickResult {
    // Before anything else, and on suppressed ticks too — see Scheduler.advance.
    this.#scheduler.advance(input.tMs);

    const suppressedBy = this.#gate.evaluate(input);

    if (suppressedBy !== null) {
      // Discard anything queued rather than releasing a burst of stale callouts
      // when the driver rejoins. Note this does NOT touch the per-note state
      // machine: those notes are already SPENT, and the half-lap rule re-arms
      // them normally once the car is going round again.
      return { events: this.#scheduler.flush(input), suppressedBy };
    }

    const events: EngineEvent[] = [];

    // Notes that became due this tick. Collected first, then offered to the
    // scheduler in a deterministic order — priority, then soonest event — so a
    // golden-file timeline (§9) is reproducible rather than dependent on the
    // order the note set happens to be written in.
    const due = this.#collectDue(input);
    due.sort((a, b) => compareCandidates(a, b, input.lapDistPct, this.#lengthM));

    for (const candidate of due) {
      events.push(...this.#scheduler.admit(candidate, input));
    }

    events.push(...this.#scheduler.pump(input));

    return { events, suppressedBy: null };
  }

  #collectDue(input: TickInput): Candidate[] {
    const due: Candidate[] = [];

    for (const candidate of this.#notes) {
      const { note, eventPct } = candidate;
      const dAheadM = aheadM(input.lapDistPct, eventPct, this.#lengthM);

      if (this.#state.get(note.id) === "SPENT") {
        // A note cannot both re-arm and fire on the same tick: firing needs
        // dAhead <= leadM, and a lead of more than half a lap would mean a
        // callout lasting most of a lap. So skipping ahead here loses nothing.
        if (dAheadM > this.#halfLapM) this.#state.set(note.id, "ARMED");
        continue;
      }

      const leadM = leadDistanceM(
        input.speedMps,
        leadSecondsFor(note, note.audio, this.#profile),
      );

      if (dAheadM <= leadM) {
        // SPENT on becoming due, whatever the scheduler then decides. A dropped
        // note that stayed ARMED would re-enter the trigger test every tick for
        // the rest of its window and flood the log (§6.2).
        this.#state.set(note.id, "SPENT");
        due.push({ ...candidate, dueAtMs: input.tMs });
      }
    }

    return due;
  }
}
