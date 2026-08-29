/**
 * Where a callout starts speaking — SPEC.md §7.4.
 *
 * "For each note, shade the arc of track over which it will be speaking. Because
 * ReferenceLap gives speed at every pct, this is computable exactly: walk
 * backwards from eventPct, accumulating time against the reference speed profile
 * until it reaches leadSecondsFor. The arc start is where the voice begins."
 *
 * That turns three otherwise-invisible problems into things an author can see:
 * two callouts overlapping, a callout reaching back past the previous corner, and
 * the cost of a longer sentence.
 *
 * Pure, and in core, because the editor is not the only thing that wants it — it
 * is the same question the scheduler answers at 60 Hz with far less information.
 */

import { aheadM, wrapPct } from "./pct.js";
import type { DriverProfile } from "./profile.js";
import type { Note, ReferenceLap } from "./schema.js";
import { leadDistanceM, leadSecondsFor } from "./trigger.js";
import type { Metres, Mps, Pct, Seconds } from "./units.js";
import { metres, mps, pct, seconds } from "./units.js";

export type Variant = "full" | "short";

export interface TriggerWindow {
  /** Where the voice begins, walking the real speed profile. */
  readonly startPct: Pct;
  readonly eventPct: Pct;
  /** Seconds of lead the note asks for. */
  readonly leadS: Seconds;
  /** How far back `startPct` is from the event, along the track. */
  readonly lengthM: Metres;
  /**
   * Where the ENGINE will actually start speaking, which is not the same place.
   *
   * The runtime has one speed sample, not a profile, so it multiplies the lead by
   * the speed it can see right now (§6.1). On an accelerating approach the car
   * then covers more ground than that assumed and the callout lands late; on a
   * decelerating one it lands early.
   */
  readonly runtimeStartPct: Pct;
  /**
   * Seconds to add to `leadAdjustS` so the engine's start matches the true one.
   *
   * §7.4: "offer it as a suggested leadAdjustS the author can accept with one
   * click. This is the single most common source of 'it's a little late' on
   * corner exits, and it is mechanical to fix."
   */
  readonly suggestedLeadAdjustS: Seconds;
}

const speedAt = (lap: ReferenceLap, index: number): Mps => {
  const v = lap.channels.speedMps[index];
  // A stationary sample would divide by zero walking the profile. 5 m/s is slow
  // enough to be honest about a crawl and fast enough to terminate.
  return mps(v === undefined || v < 5 ? 5 : v);
};

const indexOf = (p: number, gridSize: number): number => {
  const i = Math.floor(wrapPct(p) * gridSize);
  return i >= gridSize ? gridSize - 1 : i;
};

/** Time to travel from one lap position to another along the reference profile. */
function timeBetween(
  lap: ReferenceLap,
  lengthM: Metres,
  fromPct: number,
  toPct: number,
): number {
  const grid = lap.gridSize;
  const stepM = lengthM / grid;
  const target = indexOf(toPct, grid);

  let index = indexOf(fromPct, grid);
  let elapsed = 0;
  let guard = 0;

  while (index !== target && guard++ < grid) {
    elapsed += stepM / speedAt(lap, index);
    index = (index + 1) % grid;
  }
  return elapsed;
}

/**
 * Walk back from `fromPct` until `seconds` of travel have accumulated against the
 * reference speed profile. Returns where that lands.
 */
function walkBack(
  lap: ReferenceLap,
  lengthM: Metres,
  fromPct: number,
  targetS: number,
): { pct: Pct; metres: Metres } {
  const grid = lap.gridSize;
  const stepM = lengthM / grid;

  let index = indexOf(fromPct, grid);
  let elapsed = 0;
  let travelled = 0;

  // A whole lap is the hard stop: a callout longer than a lap is a data problem,
  // not something to loop forever over.
  while (elapsed < targetS && travelled < lengthM) {
    index = (index - 1 + grid) % grid;
    elapsed += stepM / speedAt(lap, index);
    travelled += stepM;
  }

  return { pct: pct(index / grid), metres: metres(travelled) };
}

export function triggerWindow(
  note: Note,
  lap: ReferenceLap,
  lengthM: Metres,
  profile: DriverProfile,
  variant: Variant = "full",
): TriggerWindow {
  const audio = variant === "full" ? note.audio : note.audioShort;
  const leadS = leadSecondsFor(note, audio, profile);
  const eventPct = pct(note.pct);

  const trueStart = walkBack(lap, lengthM, note.pct, leadS);

  // Where the engine fires: the first point going back from the event at which
  // the distance remaining has fallen to `speed there × leadS`. Walking rather
  // than solving, because speed is a sampled profile and not a function.
  const grid = lap.gridSize;
  const stepM = lengthM / grid;
  let index = indexOf(note.pct, grid);
  let back = 0;

  while (back < lengthM) {
    const next = (index - 1 + grid) % grid;
    const nextBack = back + stepM;
    if (nextBack >= leadDistanceM(speedAt(lap, next), leadS)) {
      index = next;
      back = nextBack;
      break;
    }
    index = next;
    back = nextBack;
  }

  const runtimeStartPct = pct(index / grid);

  // Both sides measured the same way, so grid quantisation cancels instead of
  // showing up as a correction the author would be told to apply for no reason.
  const wantedS = timeBetween(lap, lengthM, trueStart.pct, note.pct);
  const actualS = timeBetween(lap, lengthM, runtimeStartPct, note.pct);

  return {
    startPct: trueStart.pct,
    eventPct,
    leadS,
    lengthM: trueStart.metres,
    runtimeStartPct,
    suggestedLeadAdjustS: seconds(Number((wantedS - actualS).toFixed(3))),
  };
}

/**
 * The nearest measured braking point to a note, for "put it where the braking
 * actually starts".
 *
 * The words say "brake", so the point should be where braking begins — which is
 * also what §10 stage 4 validates a note against. Searches backwards and forwards
 * so a note placed roughly by hand snaps to the real thing.
 */
export function nearestBrakeOnset(
  atPct: Pct,
  lap: ReferenceLap,
  lengthM: Metres,
  withinM = 250,
): Pct | null {
  let best: { pct: Pct; distance: number } | null = null;

  for (const corner of Object.values(lap.perCorner)) {
    if (corner.brakeOnsetPct === null) continue;
    const onset = pct(corner.brakeOnsetPct);
    const forward = aheadM(atPct, onset, lengthM);
    const distance = Math.min(forward, lengthM - forward);
    if (distance <= withinM && (best === null || distance < best.distance)) {
      best = { pct: onset, distance };
    }
  }

  return best?.pct ?? null;
}
