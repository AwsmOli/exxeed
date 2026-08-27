/**
 * The "throwaway script rendering detected corners so you can eyeball them" from
 * milestone M1.
 *
 * It is deliberately unglamorous, but it is not actually throwaway: it is the
 * only way to tell a correct track map from a plausible one. §5.2's whole
 * workflow is look, correct, look again, and the corrections go in
 * `corners.override.json`. This is the "look".
 *
 * SVG rather than a plotting library so it has no dependencies and opens in
 * anything. The note editor at §7.4 draws the same centreline properly.
 */

import type { Corner, ReferenceLap, TrackMap } from "@exxeed/core";

const WIDTH = 1000;
const HEIGHT = 800;
const PAD = 64;

/** Grid cell holding a lap position. */
const cellOf = (p: number, gridSize: number): number =>
  Math.min(gridSize - 1, Math.max(0, Math.floor(p * gridSize)));

export function renderMapSvg(map: TrackMap, lap: ReferenceLap): string {
  const { x, y, gridSize } = map.centreline;
  if (x.length === 0) return `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>`;

  const minX = Math.min(...x);
  const maxX = Math.max(...x);
  const minY = Math.min(...y);
  const maxY = Math.max(...y);
  const scale = Math.min((WIDTH - 2 * PAD) / (maxX - minX || 1), (HEIGHT - 2 * PAD) / (maxY - minY || 1));

  // North is up, so y is flipped: SVG counts downwards.
  const px = (i: number): number => PAD + (x[i]! - minX) * scale;
  const py = (i: number): number => HEIGHT - PAD - (y[i]! - minY) * scale;

  const path = Array.from({ length: gridSize + 1 }, (_, k) => {
    const i = k % gridSize;
    return `${k === 0 ? "M" : "L"}${px(i).toFixed(1)},${py(i).toFixed(1)}`;
  }).join(" ");

  const arc = (c: Corner): string => {
    const from = cellOf(c.entryPct, gridSize);
    const to = cellOf(c.exitPct, gridSize);
    const span = ((to - from + gridSize) % gridSize) + 1;
    const seg: string[] = [];
    for (let k = 0; k < span; k++) {
      const i = (from + k) % gridSize;
      seg.push(`${k === 0 ? "M" : "L"}${px(i).toFixed(1)},${py(i).toFixed(1)}`);
    }
    const colour = c.direction === "right" ? "#f85149" : "#3fb950";
    return `<path d="${seg.join(" ")}" fill="none" stroke="${colour}" stroke-width="10" stroke-opacity="0.5" stroke-linecap="round"/>`;
  };

  const label = (c: Corner): string => {
    const i = cellOf(c.apexPct, gridSize);
    const name = c.names[0] ?? "";
    return (
      `<circle cx="${px(i).toFixed(1)}" cy="${py(i).toFixed(1)}" r="3" fill="#e6edf3"/>` +
      `<text x="${(px(i) + 9).toFixed(1)}" y="${(py(i) + 5).toFixed(1)}" fill="#e6edf3" font-family="monospace" font-size="15" font-weight="bold">T${c.index}</text>` +
      `<text x="${(px(i) + 9).toFixed(1)}" y="${(py(i) + 19).toFixed(1)}" fill="#8b949e" font-family="monospace" font-size="10">${c.direction} sev${c.severity}${name === "" ? "" : ` ${escapeText(name)}`}</text>`
    );
  };

  // Direction-of-travel arrows: without them a map is ambiguous, and a mirrored
  // one is indistinguishable from a correct one by eye.
  const arrow = (p: number): string => {
    const i = cellOf(p, gridSize);
    const j = (i + Math.max(2, Math.round(gridSize / 80))) % gridSize;
    const angle = (Math.atan2(py(j) - py(i), px(j) - px(i)) * 180) / Math.PI;
    return `<g transform="translate(${px(i).toFixed(1)},${py(i).toFixed(1)}) rotate(${angle.toFixed(1)})"><path d="M-9,-6 L9,0 L-9,6 Z" fill="#d29922"/></g>`;
  };

  // Where the reference lap says braking begins — the single most legible check
  // that the map lines up with the driving (§7.1 makes the same point).
  const brakeMark = (c: Corner): string => {
    const onset = lap.perCorner[String(c.index)]?.brakeOnsetPct;
    if (onset === null || onset === undefined) return "";
    const i = cellOf(onset, gridSize);
    return `<circle cx="${px(i).toFixed(1)}" cy="${py(i).toFixed(1)}" r="4" fill="none" stroke="#f0883e" stroke-width="2"/>`;
  };

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}">
<rect width="${WIDTH}" height="${HEIGHT}" fill="#0d1117"/>
<path d="${path}" fill="none" stroke="#30363d" stroke-width="15" stroke-linejoin="round"/>
${map.corners.map(arc).join("\n")}
<path d="${path}" fill="none" stroke="#58a6ff" stroke-width="2" stroke-linejoin="round"/>
${[0.02, 0.27, 0.52, 0.77].map(arrow).join("\n")}
${map.corners.map(brakeMark).join("")}
<circle cx="${px(0).toFixed(1)}" cy="${py(0).toFixed(1)}" r="7" fill="#d29922"/>
<text x="${(px(0) + 12).toFixed(1)}" y="${(py(0) + 4).toFixed(1)}" fill="#d29922" font-family="monospace" font-size="13">S/F</text>
${map.corners.map(label).join("\n")}
<text x="${PAD}" y="30" fill="#e6edf3" font-family="monospace" font-size="15">${escapeText(map.trackName)} — ${escapeText(map.configName)}</text>
<text x="${PAD}" y="50" fill="#8b949e" font-family="monospace" font-size="12">${map.corners.length} corners, ${map.lengthM.toFixed(0)}m, map v${map.trackRef.mapVersion}.  green = left, red = right.  arrows = direction of travel, north up.  orange ring = reference brake onset.</text>
</svg>`;
}

const escapeText = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
