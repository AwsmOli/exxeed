/**
 * Turn a TrackMap's centreline into something a window can draw.
 *
 * Normalising here rather than in the renderer keeps the arithmetic in
 * TypeScript, where it is typechecked, and means the drawing code is a transform
 * and a stroke. §7.0's rule still applies on the other side: the canvas
 * subscribes to IPC directly and draws in a rAF loop rather than re-rendering.
 */

import { pct, pctToIndex, type Note, type TrackMap } from "@exxeed/core";
import type { TrackMapView } from "@exxeed/overlays";

export function toMapView(map: TrackMap, notes: readonly Note[]): TrackMapView {
  const { x, y, gridSize } = map.centreline;

  const minX = Math.min(...x);
  const maxX = Math.max(...x);
  const minY = Math.min(...y);
  const maxY = Math.max(...y);

  // One scale for both axes, or a circuit comes out stretched into something
  // that does not look like the track — which defeats the point of drawing it.
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const offsetX = (span - (maxX - minX)) / 2;
  const offsetY = (span - (maxY - minY)) / 2;

  return {
    trackName: map.trackName,
    configName: map.configName,
    x: x.map((v) => (v - minX + offsetX) / span),
    // Flip Y: the centreline is a maths frame with Y increasing north, and a
    // canvas has Y increasing downwards.
    y: y.map((v) => 1 - (v - minY + offsetY) / span),
    // A note's pct is a plain number on disk; this is the boundary where it
    // becomes one (§3).
    notes: notes.map((n) => ({ id: n.id, index: pctToIndex(pct(n.pct), gridSize) })),
    startIndex: 0,
  };
}
