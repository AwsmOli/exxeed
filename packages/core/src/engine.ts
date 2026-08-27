/**
 * The note engine — SPEC.md §6.2.
 *
 * ## Why there is no lap counter in here
 *
 * The obvious design is a `firedThisLap` set cleared at the start/finish line.
 * It is wrong, and it fails at exactly the corners people care most about.
 *
 * Worked example, Spa. `t1_brake` is anchored at pct 0.99781 — the 100 board for
 * La Source, which sits BEHIND the start/finish line. At 69 m/s with a lead of
 * 173 m it fires at pct ≈ 0.9731. The car then crosses start/finish, the fired
 * set is cleared, and `dAhead` is still well inside `leadM` — so it fires again,
 * in the same approach, a second before turn 1.
 *
 * So this engine has no concept of a lap at all:
 *
 *   ARMED  --[ dAhead <= leadM ]-->      SPENT   (fire, or drop — both land here)
 *   SPENT  --[ dAhead > lengthM/2 ]-->   ARMED   (event is now half a lap away)
 *
 * Re-arming on "more than half a lap away" is unconditionally correct, needs no
 * lap counter, and survives resets, tows and pit exits for free.
 *
 * Every note starts SPENT, so nothing fires on the out-lap before the car has
 * been round once.
 *
 * ## Purity
 *
 * `tick` takes a minimal input rather than a `TelemetryFrame`, because core must
 * not depend on the telemetry package (§3, enforced by lint). That is the point
 * of the boundary, not an inconvenience: the engine can be driven by a recording,
 * a test, or the sim without knowing the difference.
 */

import { aheadM } from "./pct.js";
import type { ResolvedNote } from "./anchor.js";
import type { DriverProfile } from "./profile.js";
import { DEFAULT_PROFILE } from "./profile.js";
import { leadDistanceM, leadSecondsFor } from "./trigger.js";
import type { Metres, Mps, Pct } from "./units.js";

export type NoteState = "ARMED" | "SPENT";

export interface TickInput {
  readonly lapDistPct: Pct;
  readonly speedMps: Mps;
}

/**
 * A note whose trigger condition has been met.
 *
 * "Fire" here means the trigger fired, not that a sound was necessarily played.
 * The scheduler (§6.3) consumes these and decides between the full form, the
 * short form, and dropping — a braking cue that would arrive after the braking
 * point is worse than silence. Either way the note is already SPENT: a dropped
 * note that stayed ARMED would re-enter the trigger test every tick for the rest
 * of its window and flood the log.
 */
export interface FireEvent {
  readonly kind: "fire";
  readonly noteId: string;
  readonly eventPct: Pct;
  /** Lead distance used for the decision, from the FULL variant (§6.1). */
  readonly leadM: Metres;
  /** Distance remaining to the event when it fired. */
  readonly dAheadM: Metres;
  readonly speedMps: Mps;
  readonly atPct: Pct;
}

export type EngineEvent = FireEvent;

export class NoteEngine {
  readonly #notes: readonly ResolvedNote[];
  readonly #lengthM: Metres;
  readonly #halfLapM: number;
  readonly #profile: DriverProfile;
  readonly #state = new Map<string, NoteState>();

  constructor(
    notes: readonly ResolvedNote[],
    lengthM: Metres,
    profile: DriverProfile = DEFAULT_PROFILE,
  ) {
    this.#notes = notes;
    this.#lengthM = lengthM;
    this.#halfLapM = lengthM / 2;
    this.#profile = profile;

    // Start everything SPENT so the out-lap is silent (§6.2). Notes arm
    // themselves on the first tick where their event is more than half a lap
    // ahead, which for a car leaving the pits is almost immediately.
    for (const { note } of notes) this.#state.set(note.id, "SPENT");
  }

  stateOf(noteId: string): NoteState | undefined {
    return this.#state.get(noteId);
  }

  /** Snapshot for the dev callout overlay (§7.3). */
  states(): ReadonlyMap<string, NoteState> {
    return new Map(this.#state);
  }

  /**
   * Force every note back to SPENT. Not needed for laps — the half-lap rule
   * handles those — but useful when loading a different note set mid-session.
   */
  reset(): void {
    for (const { note } of this.#notes) this.#state.set(note.id, "SPENT");
  }

  tick(input: TickInput): EngineEvent[] {
    const events: EngineEvent[] = [];

    for (const { note, eventPct } of this.#notes) {
      const dAheadM = aheadM(input.lapDistPct, eventPct, this.#lengthM);

      if (this.#state.get(note.id) === "SPENT") {
        // Re-arm once the event is more than half a lap away. A note cannot both
        // re-arm and fire on the same tick: firing needs dAhead <= leadM, and a
        // lead of more than half a lap would mean a callout lasting most of a
        // lap. So returning early here loses nothing.
        if (dAheadM > this.#halfLapM) this.#state.set(note.id, "ARMED");
        continue;
      }

      const leadM = leadDistanceM(
        input.speedMps,
        leadSecondsFor(note, note.audio, this.#profile),
      );

      if (dAheadM <= leadM) {
        this.#state.set(note.id, "SPENT");
        events.push({
          kind: "fire",
          noteId: note.id,
          eventPct,
          leadM,
          dAheadM,
          speedMps: input.speedMps,
          atPct: input.lapDistPct,
        });
      }
    }

    return events;
  }
}
