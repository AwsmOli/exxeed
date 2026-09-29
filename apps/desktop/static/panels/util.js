// Shared by every panel. Formatting and canvas plumbing only — nothing here
// decides anything (§7).

export const $ = (root, selector) => root.querySelector(selector);

/** Build an element from an HTML string. Panels build their own DOM. */
export function html(markup) {
  const t = document.createElement("template");
  t.innerHTML = markup.trim();
  return t.content.firstElementChild;
}

export const setText = (el, text) => {
  if (el !== null && el.textContent !== text) el.textContent = text;
};

/** "1:46.890", or "46.890" under a minute. */
export function lapTime(s) {
  if (typeof s !== "number" || !Number.isFinite(s) || s <= 0) return "—";
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return m > 0 ? `${m}:${rest.toFixed(3).padStart(6, "0")}` : rest.toFixed(3);
}

/** "+0.25" / "−0.25", always signed, a real minus sign. */
export function signed(v, digits = 2) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  const s = Math.abs(v).toFixed(digits);
  if (Number(s) === 0) return (0).toFixed(digits);
  return v < 0 ? `−${s}` : `+${s}`;
}

/** Green when ahead, red when behind. Negative delta is time gained. */
export const deltaClass = (v) =>
  typeof v !== "number" || Math.abs(v) < 0.005 ? "" : v < 0 ? "good" : "bad";

/** "29:04", or "1:02:10" past the hour. */
export function clock(s) {
  if (typeof s !== "number" || !Number.isFinite(s) || s < 0) return "—";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const mm = String(m).padStart(h > 0 ? 2 : 1, "0");
  return h > 0 ? `${h}:${mm}:${String(sec).padStart(2, "0")}` : `${mm}:${String(sec).padStart(2, "0")}`;
}

/** "4.8k" iRating, as every timing screen writes it. */
export const irating = (n) => (n > 0 ? `${(n / 1000).toFixed(1)}k` : "");

export const kph = (mps) => (typeof mps === "number" ? mps * 3.6 : 0);

/** Signed distance in pct, −0.5..0.5, so windows work across start/finish. */
export const pctDelta = (a, b) => ((((a - b) % 1) + 1.5) % 1) - 0.5;

export const wrap01 = (p) => ((p % 1) + 1) % 1;

/** Sample a pct-grid channel at a lap position. */
export function sample(channel, gridSize, p) {
  return channel[Math.min(gridSize - 1, Math.floor(wrap01(p) * gridSize))];
}

/**
 * Size a canvas to its box at the display's pixel ratio. Returns what the draw
 * routines need, or null while the canvas has no size yet (not laid out, or
 * the window is hidden).
 */
export function fit(canvas) {
  const r = window.devicePixelRatio || 1;
  const box = canvas.getBoundingClientRect();
  const w = Math.round(box.width * r);
  const h = Math.round(box.height * r);
  if (w === 0 || h === 0) return null;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  return { ctx: canvas.getContext("2d"), w, h, r };
}

/** Read a CSS custom property once, so canvases and HTML share one palette. */
const css = getComputedStyle(document.documentElement);
export const token = (name) => css.getPropertyValue(name).trim();

export const COLORS = {
  green: token("--green") || "#4de95f",
  mint: token("--mint") || "#2ee88f",
  red: token("--red") || "#ff3c22",
  cyan: token("--cyan") || "#00ffdc",
  purple: token("--purple") || "#e285ff",
  yellow: token("--yellow") || "#ffd23f",
  orange: token("--orange") || "#ff7919",
  blue: token("--blue") || "#58a6ff",
};

/** #rrggbb + alpha → rgba(). */
export function alpha(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? "");
  if (m === null) return `rgba(255,255,255,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** A rounded rectangle path, for canvases. */
export function roundRect(ctx, x, y, w, h, radius) {
  const rr = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * The shaded area chart both comparison panels use: a line with a soft fill
 * under it, fading to nothing at the bottom of its lane.
 */
export function areaLine(ctx, points, top, bottom, colour, fillAlpha, width) {
  if (points.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.lineJoin = "round";
  ctx.stroke();

  if (fillAlpha <= 0) return;
  ctx.lineTo(points[points.length - 1][0], bottom);
  ctx.lineTo(points[0][0], bottom);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, top, 0, bottom);
  g.addColorStop(0, alpha(colour, fillAlpha));
  g.addColorStop(1, alpha(colour, 0));
  ctx.fillStyle = g;
  ctx.fill();
}

/** Tyre carcass temperature → colour: blue cold, green in the window, red hot. */
export function tempColour(c) {
  if (!(c > 0)) return "rgba(255,255,255,0.08)";
  const stops = [
    [40, [88, 166, 255]],
    [70, [0, 255, 220]],
    [85, [77, 233, 95]],
    [100, [255, 210, 63]],
    [115, [255, 60, 34]],
  ];
  if (c <= stops[0][0]) return `rgb(${stops[0][1].join(",")})`;
  for (let i = 1; i < stops.length; i++) {
    const [t1, c1] = stops[i];
    const [t0, c0] = stops[i - 1];
    if (c <= t1) {
      const k = (c - t0) / (t1 - t0);
      return `rgb(${c0.map((v, j) => Math.round(v + (c1[j] - v) * k)).join(",")})`;
    }
  }
  return `rgb(${stops[stops.length - 1][1].join(",")})`;
}
