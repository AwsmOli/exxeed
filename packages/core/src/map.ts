/**
 * Helpers for reading a TrackMap.
 *
 * What used to live here — `PHASE_PCT`, `resolveEventPct`, anchor resolution —
 * is gone. A note carries its own lap position (§4.4), so there is nothing to
 * resolve: no phase table, no landmark lookup on the runtime path, and no
 * "unresolvable anchor" case for callers to handle.
 *
 * The map is still needed for its length, and the editor and the trackmap tool
 * still read corners. The engine does not.
 */

import type { Corner, Landmark, LandmarkInventory, TrackMap } from "./schema.js";
import type { Metres } from "./units.js";
import { metres } from "./units.js";

/** Track length as branded metres, so callers stop re-wrapping it. */
export const trackLength = (map: TrackMap): Metres => metres(map.lengthM);

/**
 * Corner lookup by its `index` field, not by array position.
 *
 * Indices are 1-based and a `corners.override.json` can merge, split or insert
 * corners (§5.2), so position and index are not interchangeable.
 */
export const cornerByIndex = (map: TrackMap, index: number): Corner | undefined =>
  map.corners.find((c) => c.index === index);

export type LandmarkIndex = ReadonlyMap<string, Landmark>;

/**
 * Landmarks by id. Not used at runtime — a note is a point and a message, and
 * says whatever it says. This is for §10 stage 3, where the model is handed a
 * closed set of landmark ids so it cannot free-text a corner reference.
 */
export const indexLandmarks = (inventory: LandmarkInventory): LandmarkIndex =>
  new Map(inventory.landmarks.map((lm) => [lm.id, lm]));
