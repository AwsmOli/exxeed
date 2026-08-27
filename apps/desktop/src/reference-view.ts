/**
 * Package a ReferenceLap and its TrackMap into what the overlays draw against
 * (§7.1, §7.2).
 *
 * Kept out of the renderer so the drawing code is a transform and a stroke, and
 * so the corner geometry a display needs does not leak back into the engine —
 * which still loads neither of these (§4.4).
 */

import type { ReferenceLap, TrackMap } from "@exxeed/core";
import type { ReferenceView } from "@exxeed/overlays";

export function toReferenceView(
  lap: ReferenceLap,
  map: TrackMap | null,
): ReferenceView {
  const corners = (map?.corners ?? []).map((c) => ({
    index: c.index,
    entryPct: c.entryPct,
    apexPct: c.apexPct,
    exitPct: c.exitPct,
  }));

  // perCorner is keyed by corner index as a string, and its brakeOnsetPct is null
  // for corners taken flat — those simply get no marker rather than one at zero.
  const brakeOnsetPcts = Object.values(lap.perCorner)
    .map((c) => c.brakeOnsetPct)
    .filter((p): p is number => p !== null);

  return {
    gridSize: lap.gridSize,
    lapTimeS: lap.lapTimeS,
    carId: lap.carId,
    throttle: lap.channels.throttle,
    brake: lap.channels.brake,
    speedMps: lap.channels.speedMps,
    elapsedS: lap.channels.elapsedS,
    corners,
    brakeOnsetPcts,
  };
}
