/**
 * TelemetryFrame → the engine's TickInput.
 *
 * This translation lives here, not in core, because core must stay sim-neutral:
 * it asks "is the car off track?", not "is `PlayerTrackSurface` equal to
 * `irsdk_TrkLoc.OffTrack`?". A second sim would answer the same questions from
 * different channels, and only this file would change.
 */

import type { TickInput } from "@exxeed/core";

import { TRK_LOC, type TelemetryFrame } from "./frame.js";

export const toTickInput = (frame: TelemetryFrame): TickInput => ({
  tMs: frame.tMs,
  lapDistPct: frame.lapDistPct,
  speedMps: frame.speedMps,
  lap: frame.lap,
  onTrack: frame.isOnTrack,
  inPitLane: frame.onPitRoad,
  inGarage: frame.isInGarage,
  // SPEC.md §6.4: there is no clean "four wheels off" channel. This is the
  // closest available proxy, and core applies the 2 s hold after it clears.
  offTrack: frame.playerTrackSurface === TRK_LOC.OffTrack,
  towTimeS: frame.playerCarTowTime,
  resetCounter: frame.enterExitReset,
});
