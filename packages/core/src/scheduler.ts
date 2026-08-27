/**
 * The scheduler — SPEC.md §6.3.
 *
 * One audio channel, a queue two deep. Its whole job is deciding, at the instant
 * a note would start speaking, whether there is still room to say it — and if
 * not, whether the short form fits, and if not, to shut up.
 *
 * The rule worth internalising: **dropping is allowed at every priority,
 * including 1.** A braking cue that arrives after the braking point is worse than
 * silence — it makes the driver flinch mid-corner. There is no priority high
 * enough to justify speaking too late.
 */

import { aheadM } from "./pct.js";
import type { DriverProfile } from "./profile.js";
import type { Note } from "./schema.js";
import { leadDistanceM, leadSecondsFor } from "./trigger.js";
import type { Metres, Mps, Pct } from "./units.js";

/** SPEC.md §6.3: "One audio channel. Queue, max depth 2." */
export const QUEUE_DEPTH = 2;

export type AudioVariantName = "full" | "short";

export type DropReason =
  /** Neither the full nor the short form fits before the event arrives. */
  | "no_fit_after_short"
  /** Queue was full and this note lost the priority contest. */
  | "queue_full"
  /** Was queued, then displaced by a higher-priority note. */
  | "evicted"
  /**
   * The car went past the event while the note sat in the queue.
   *
   * Distinct from `no_fit_after_short` because it is not a fit problem — there is
   * no amount of shortening that helps, and the two want different fixes: this
   * one means the queue is too deep or the corner too busy.
   *
   * Worth its own case because `aheadM` is always positive (§4.6): an event two
   * metres behind the car reads as 6990 m ahead, which sails through any fit test
   * you care to write. Caught by replaying a real timeline, not by unit tests.
   */
  | "event_passed"
  /**
   * Discarded because suppression started while it was queued. Not one of the
   * three reasons §6.3 names — added because releasing a burst of stale callouts
   * when the driver rejoins the track is worse than losing them, and a silent
   * discard would be invisible in the dev overlay (§7.3).
   */
  | "suppressed";

export interface PlayEvent {
  readonly kind: "play";
  readonly noteId: string;
  readonly variant: AudioVariantName;
  readonly file: string;
  readonly durationMs: number;
  readonly eventPct: Pct;
  /** Lead distance required by the variant actually chosen. */
  readonly leadM: Metres;
  readonly dAheadM: Metres;
  readonly atPct: Pct;
  readonly speedMps: Mps;
}

export interface DropEvent {
  readonly kind: "drop";
  readonly noteId: string;
  readonly reason: DropReason;
  readonly eventPct: Pct;
  readonly dAheadM: Metres;
  readonly atPct: Pct;
  readonly speedMps: Mps;
}

export type EngineEvent = PlayEvent | DropEvent;

export interface Candidate {
  readonly note: Note;
  readonly eventPct: Pct;
}

export interface PumpInput {
  readonly tMs: number;
  readonly lapDistPct: Pct;
  readonly speedMps: Mps;
}

/**
 * Which of two contending notes should be served first.
 *
 * Priority wins; ties break by event position, the sooner event first. That
 * tie-break is what makes two priority-1 notes always resolvable — without it the
 * outcome would depend on iteration order, and the golden-file timeline (§9)
 * would not be reproducible.
 */
export function compareCandidates(
  a: Candidate,
  b: Candidate,
  atPct: Pct,
  lengthM: Metres,
): number {
  if (a.note.priority !== b.note.priority) return a.note.priority - b.note.priority;
  return aheadM(atPct, a.eventPct, lengthM) - aheadM(atPct, b.eventPct, lengthM);
}

export class Scheduler {
  readonly #lengthM: Metres;
  readonly #profile: DriverProfile;
  #queue: Candidate[] = [];
  #busyUntilMs = 0;
  #lastTMs: number | null = null;
  #dtS = 0;

  constructor(lengthM: Metres, profile: DriverProfile) {
    this.#lengthM = lengthM;
    this.#profile = profile;
  }

  /**
   * Advance the clock. Called once per engine tick BEFORE admit/pump, and
   * crucially also on suppressed ticks — otherwise the first tick after
   * suppression lifts would see a dt spanning the whole excursion, or none at
   * all, and mis-size the fit tolerance below.
   */
  advance(tMs: number): void {
    this.#dtS = this.#lastTMs === null ? 0 : (tMs - this.#lastTMs) / 1000;
    this.#lastTMs = tMs;
  }

  queued(): readonly string[] {
    return this.#queue.map((c) => c.note.id);
  }

  busyAt(tMs: number): boolean {
    return tMs < this.#busyUntilMs;
  }

  /**
   * Offer a note to the queue. Returns a drop event when something had to give —
   * either the incoming note (queue full, lost the contest) or the queued note it
   * displaced.
   */
  admit(candidate: Candidate, input: PumpInput): DropEvent[] {
    if (this.#queue.length < QUEUE_DEPTH) {
      this.#queue.push(candidate);
      return [];
    }

    // Find the worst-placed queued note, i.e. the one that would be served last.
    let worstIndex = 0;
    for (let i = 1; i < this.#queue.length; i++) {
      const better = compareCandidates(
        this.#queue[i]!,
        this.#queue[worstIndex]!,
        input.lapDistPct,
        this.#lengthM,
      );
      if (better > 0) worstIndex = i;
    }

    const worst = this.#queue[worstIndex]!;
    const incomingIsBetter =
      compareCandidates(candidate, worst, input.lapDistPct, this.#lengthM) < 0;

    if (!incomingIsBetter) {
      return [this.#drop(candidate, "queue_full", input)];
    }

    this.#queue.splice(worstIndex, 1);
    this.#queue.push(candidate);
    return [this.#drop(worst, "evicted", input)];
  }

  /** Discard everything queued — suppression started. */
  flush(input: PumpInput): DropEvent[] {
    const dropped = this.#queue.map((c) => this.#drop(c, "suppressed", input));
    this.#queue = [];
    return dropped;
  }

  /**
   * Serve the queue if the channel is free. Emits a play event for whatever gets
   * spoken, and drop events for anything that no longer fits.
   */
  pump(input: PumpInput): EngineEvent[] {
    const events: EngineEvent[] = [];
    if (this.#queue.length === 0) return events;

    this.#queue.sort((a, b) =>
      compareCandidates(a, b, input.lapDistPct, this.#lengthM),
    );

    // A note that does not fit is dropped without occupying the channel, so the
    // next one in the queue still gets its chance on this tick.
    while (this.#queue.length > 0 && !this.busyAt(input.tMs)) {
      const candidate = this.#queue.shift()!;
      const dAheadM = aheadM(input.lapDistPct, candidate.eventPct, this.#lengthM);

      // The car is past the event. `aheadM` cannot express that — it reports the
      // long way round — so check the half-lap threshold explicitly before any
      // fit test, or a note that missed its corner plays with a nonsense lead.
      if (dAheadM > this.#lengthM / 2) {
        events.push(this.#drop(candidate, "event_passed", input));
        continue;
      }

      const chosen = this.#chooseVariant(candidate, input, dAheadM);

      if (chosen === null) {
        events.push(this.#drop(candidate, "no_fit_after_short", input));
        continue;
      }

      this.#busyUntilMs = input.tMs + chosen.durationMs;
      events.push(chosen);
    }

    return events;
  }

  /**
   * The §6.3 fit test, full form first.
   *
   * The tolerance needs explaining. The trigger fires on the tick that `dAhead`
   * drops to or below the full lead (§6.1), so by the time the scheduler looks at
   * the note on that same tick, `dAhead` is already up to one tick's travel
   * *under* the lead. A strict `dAhead >= lead` would therefore reject the full
   * form almost every time and everything would speak in short form. One tick of
   * travel is the exact amount of slack that costs.
   */
  #chooseVariant(
    candidate: Candidate,
    input: PumpInput,
    dAheadM: Metres,
  ): PlayEvent | null {
    const { note, eventPct } = candidate;
    const toleranceM = input.speedMps * this.#dtS;

    const build = (variant: AudioVariantName, leadM: Metres): PlayEvent => {
      const audio = variant === "full" ? note.audio : note.audioShort;
      return {
        kind: "play",
        noteId: note.id,
        variant,
        file: audio.file,
        durationMs: audio.durationMs,
        eventPct,
        leadM,
        dAheadM,
        atPct: input.lapDistPct,
        speedMps: input.speedMps,
      };
    };

    const fullLeadM = leadDistanceM(
      input.speedMps,
      leadSecondsFor(note, note.audio, this.#profile),
    );
    if (dAheadM >= fullLeadM - toleranceM) return build("full", fullLeadM);

    const shortLeadM = leadDistanceM(
      input.speedMps,
      leadSecondsFor(note, note.audioShort, this.#profile),
    );
    if (dAheadM >= shortLeadM - toleranceM) return build("short", shortLeadM);

    return null;
  }

  #drop(candidate: Candidate, reason: DropReason, input: PumpInput): DropEvent {
    return {
      kind: "drop",
      noteId: candidate.note.id,
      reason,
      eventPct: candidate.eventPct,
      dAheadM: aheadM(input.lapDistPct, candidate.eventPct, this.#lengthM),
      atPct: input.lapDistPct,
      speedMps: input.speedMps,
    };
  }
}
