/**
 * A minimal car for driving the engine in tests.
 *
 * Carries position, lap and clock across calls, because the engine's suppression
 * gate (§6.4) is stateful in all three: it needs one completed lap before it will
 * arm anything, and the scheduler sizes its fit tolerance from the tick interval.
 */

import type { EngineEvent, Mps, NoteEngine, Pct, SuppressionReason } from "@exxeed/core";
import { metres, mps, offsetPct, pct } from "@exxeed/core";

import { SPA_LENGTH_M } from "./fixtures.js";

const SPA = metres(SPA_LENGTH_M);

/** 250 km/h — the speed the §6.1 and §6.2 worked examples use. */
export const V250 = mps(69);

export interface DriveOptions {
  readonly speedMps?: Mps;
  readonly stepM?: number;
  /** Suppression overrides. Defaults are "driving normally, on track". */
  readonly onTrack?: boolean;
  readonly inPitLane?: boolean;
  readonly inGarage?: boolean;
  readonly offTrack?: boolean;
  readonly towTimeS?: number;
  readonly resetCounter?: number;
}

export class Car {
  pct: Pct;
  lap: number;
  tMs = 0;
  lastSuppression: SuppressionReason | null = null;

  constructor(fromPct = 0, lap = 1) {
    this.pct = pct(fromPct);
    this.lap = lap;
  }

  /** Jump to a position without driving there. Models a reset or a tow. */
  teleport(toPct: number): void {
    this.pct = pct(toPct);
  }

  /** Drive forward, ticking every `stepM` metres, and collect what comes out. */
  drive(engine: NoteEngine, distanceM: number, options: DriveOptions = {}): EngineEvent[] {
    const speedMps = options.speedMps ?? V250;
    const stepM = options.stepM ?? 1;
    const events: EngineEvent[] = [];

    for (let travelled = 0; travelled <= distanceM; travelled += stepM) {
      const result = engine.tick({
        tMs: this.tMs,
        lapDistPct: this.pct,
        speedMps,
        lap: this.lap,
        onTrack: options.onTrack ?? true,
        inPitLane: options.inPitLane ?? false,
        inGarage: options.inGarage ?? false,
        offTrack: options.offTrack ?? false,
        towTimeS: options.towTimeS ?? 0,
        resetCounter: options.resetCounter ?? 0,
      });

      this.lastSuppression = result.suppressedBy;
      events.push(...result.events);

      const next = offsetPct(this.pct, metres(stepM), SPA);
      if (next < this.pct) this.lap++;
      this.pct = next;
      this.tMs += (stepM / speedMps) * 1000;
    }

    return events;
  }

  /** Sit still for a while, still ticking. For off-track holds and pit stops. */
  idle(engine: NoteEngine, durationMs: number, options: DriveOptions = {}): EngineEvent[] {
    const events: EngineEvent[] = [];
    const stepMs = 50;

    for (let elapsed = 0; elapsed <= durationMs; elapsed += stepMs) {
      const result = engine.tick({
        tMs: this.tMs,
        lapDistPct: this.pct,
        speedMps: options.speedMps ?? V250,
        lap: this.lap,
        onTrack: options.onTrack ?? true,
        inPitLane: options.inPitLane ?? false,
        inGarage: options.inGarage ?? false,
        offTrack: options.offTrack ?? false,
        towTimeS: options.towTimeS ?? 0,
        resetCounter: options.resetCounter ?? 0,
      });

      this.lastSuppression = result.suppressedBy;
      events.push(...result.events);
      this.tMs += stepMs;
    }

    return events;
  }
}

export const plays = (events: readonly EngineEvent[]) =>
  events.filter((e) => e.kind === "play");

export const drops = (events: readonly EngineEvent[]) =>
  events.filter((e) => e.kind === "drop");
