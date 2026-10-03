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

/**
 * The palette the canvases draw from. One object, filled from the stylesheet
 * and refilled when the theme changes — never read per frame (§7.0: nothing on
 * the 60 Hz path queries the DOM). Panels read `COLORS.x` at draw time, so a
 * refill reaches them without anything being rebuilt.
 */
export const COLORS = {};

export function refreshColors() {
  // A token that is itself a var() (the role colours) resolves through here.
  const resolve = (name, fallback) => {
    let v = token(name);
    for (let depth = 0; depth < 3 && v.startsWith("var("); depth++) v = token(v.slice(4, -1).split(",")[0].trim());
    return v || fallback;
  };
  Object.assign(COLORS, {
    green: resolve("--green", "#4de95f"),
    mint: resolve("--mint", "#2ee88f"),
    red: resolve("--red", "#ff3c22"),
    cyan: resolve("--cyan", "#00ffdc"),
    purple: resolve("--purple", "#e285ff"),
    yellow: resolve("--yellow", "#ffd23f"),
    orange: resolve("--orange", "#ff7919"),
    blue: resolve("--blue", "#58a6ff"),
    throttle: resolve("--throttle", "#2ee88f"),
    brake: resolve("--brake", "#ff3c22"),
    danger: resolve("--danger", "#ff3c22"),
    me: resolve("--me", "#4de95f"),
    text: resolve("--text", "#ffffff"),
    // Neutral lines on the canvases (grids, the reference trace, dials): white
    // on a dark theme, near-black on a light one.
    ink: resolve("--ink", "#ffffff"),
    road: resolve("--road", "rgba(200,202,206,0.95)"),
    roadEdge: resolve("--road-edge", "rgba(40,42,46,0.9)"),
    font: resolve("--font", "system-ui, sans-serif"),
    glow: parseFloat(resolve("--glow", "6px")) || 0,
    shiftStyle: resolve("--shift-style", "lights") === "sweep" ? "sweep" : "lights",
    lapAhead: resolve("--lap-ahead", "#ff8a7a"),
    lapBehind: resolve("--lap-behind", "#7ab8ff"),
    // Licence colours by letter, where the theme sets them; the sim's otherwise.
    licences: Object.fromEntries(
      ["r", "d", "c", "b", "a", "p"]
        .map((k) => [k.toUpperCase(), resolve(`--lic-${k}`, "")])
        .filter(([, c]) => /^#[0-9a-f]{6}$/i.test(c)),
    ),
    // The theme's class colours, fastest class first; empty means the sim's own.
    classes: [1, 2, 3, 4, 5].map((i) => resolve(`--class-${i}`, "")).filter((c) => /^#[0-9a-f]{6}$/i.test(c)),
    // Or, when a theme names them, one colour for your class and one for every other.
    classMine: resolve("--class-mine", ""),
    classOther: resolve("--class-other", ""),
  });

  // The shift lights: green through yellow and orange to red, in the theme's
  // own palette, pulled towards the card colour by `--shift-strength` so a
  // quiet theme gets quiet lights. The default theme keeps its hand-picked ramp.
  const strength = Math.max(0, Math.min(1, parseFloat(resolve("--shift-strength", "1"))));
  // The classic look keeps its hand-picked ramp; every other theme gets one from its palette.
  const themed = document.documentElement.dataset.base ?? "classic";
  // A theme may give the rev lights their own sweep, as four colours from
  // the first light to the last; the eight lights are spread along it.
  const sweep = ["low", "mid", "high", "max"].map((k) => resolve(`--shift-${k}`, ""));
  const own = sweep.every((c) => /^#[0-9a-f]{6}$/i.test(c));
  const along = (j) => {
    const x = (j / 7) * 3;
    const i = Math.min(2, Math.floor(x));
    return mix(sweep[i], sweep[i + 1], x - i);
  };
  const ramp = own
    ? [0, 1, 2, 3, 4, 5, 6, 7].map(along)
    : themed === "classic"
      ? ["#2ee88f", "#5de85a", "#9fe24a", "#d9e33a", "#f2d23a", "#ffae2e", "#ff7a26", "#ff4a22"]
      : [
          COLORS.green,
          COLORS.green,
          mix(COLORS.green, COLORS.yellow, 0.5),
          COLORS.yellow,
          COLORS.yellow,
          COLORS.orange,
          mix(COLORS.orange, COLORS.red, 0.5),
          COLORS.red,
        ];
  COLORS.shift = ramp.map((c) => mix("#20222b", c, strength));
  COLORS.shiftBlink = mix("#20222b", COLORS.danger, strength);

  // Tyre temperatures: cold to hot through the theme's own colours.
  // A theme can name its own (temp-cold … temp-hot): Gran Turismo's run blue, white, red.
  COLORS.temps = [
    resolve("--temp-cold", COLORS.blue),
    resolve("--temp-cool", COLORS.cyan),
    resolve("--temp-ok", COLORS.green),
    resolve("--temp-warm", resolve("--warm", COLORS.yellow)),
    resolve("--temp-hot", COLORS.red),
  ].map(rgbOf);
}

/**
 * Gaining or losing this many seconds per second of driving is full colour.
 * Deliberately a lot: a tenth found over a whole corner is about 0.03 s/s and
 * should read as a tint, while out-braking the reference by two tenths in a
 * second is the full colour. At 0.05 everything ordinary was already
 * saturated, so the bar only ever showed white, full green or full red.
 */
const TREND_FULL = 0.12;
/** Below this the gap is holding: white. Small, so the bar is rarely white. */
const TREND_DEAD = 0.001;
/** How quickly the trend follows the delta, so it does not flicker. */
const TREND_SMOOTH_S = 1.2;

/**
 * The colour of a delta by where it is GOING, as the sim's own bar does it:
 * green while you are gaining on the reference, red while you are losing, and
 * white when the gap is holding — however large the gap itself is. Four
 * seconds down but catching up reads green. The shade says how fast.
 *
 * Returns a function to call each paint with the current delta; it keeps the
 * little history it needs.
 */
export function deltaTrend() {
  let last = null;
  let at = 0;
  let rate = 0;
  return (d) => {
    const now = performance.now();
    if (last !== null) {
      const dt = (now - at) / 1000;
      const step = d - last;
      // A jump is a new lap or a reset, not driving: start again from here.
      if (dt > 1 || Math.abs(step) > 0.5) rate = 0;
      else if (dt > 0) {
        const k = Math.min(1, dt / TREND_SMOOTH_S);
        rate += (step / dt - rate) * k;
      }
    }
    last = d;
    at = now;
    const speed = Math.max(0, Math.abs(rate) - TREND_DEAD);
    // Eased, so a slow gain is already a visible tint and the colour keeps
    // deepening all the way up to a fast one, rather than snapping to full.
    // A steep start: even a slow gain is clearly tinted.
    const t = Math.min(1, speed / TREND_FULL) ** 0.45;
    // Negative rate: the delta is falling, which is time gained.
    return mix(COLORS.text, rate < 0 ? COLORS.green : COLORS.red, t);
  };
}

/**
 * The colour to draw a class in: the theme's, if it sets class colours,
 * otherwise the one the sim gave it. Classes are numbered in standings order,
 * fastest first, so "class 1" is the same class on every panel.
 */
export function classColour(race, simColour) {
  if (COLORS.classMine !== "" && COLORS.classOther !== "") {
    return simColour === playerClassColour(race) ? COLORS.classMine : COLORS.classOther;
  }
  if (COLORS.classes.length === 0) return simColour;
  const index = (race?.classes ?? []).findIndex((c) => c.classColor === simColour);
  return index < 0 ? simColour : COLORS.classes[index % COLORS.classes.length];
}

/** The sim's colour for the player's own class, or null. */
export function playerClassColour(race) {
  return (race?.classes ?? []).find((c) => c.rows.some((r) => r.isPlayer))?.classColor ?? null;
}

/** A licence's colour: the theme's for that letter ("A 3.12" → A), otherwise the sim's. */
export const licenceColour = (licence, simColour) =>
  COLORS.licences[String(licence ?? "").trim().charAt(0).toUpperCase()] ?? simColour;

/** Blend two #rrggbb colours: 0 is all `a`, 1 is all `b`. Anything else passes `b` through. */
export function mix(a, b, t) {
  const pa = /^#?([0-9a-f]{6})$/i.exec(a ?? "");
  const pb = /^#?([0-9a-f]{6})$/i.exec(b ?? "");
  if (pa === null || pb === null) return b;
  const na = parseInt(pa[1], 16);
  const nb = parseInt(pb[1], 16);
  const ch = (shift) => Math.round(((na >> shift) & 255) + (((nb >> shift) & 255) - ((na >> shift) & 255)) * t);
  return `#${((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1)}`;
}
refreshColors();

/** #rrggbb + alpha → rgba(). */
export function alpha(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? "");
  if (m === null) return `rgba(255,255,255,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** A rounded rectangle path, for canvases. */
/**
 * A car as an arrowhead pointing along `angle` (radians, 0 = right), the way
 * Gran Turismo draws cars on its maps: a filled chevron with a pale edge.
 */
export function chevron(ctx, x, y, angle, size, fill, r) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(size, 0);
  ctx.lineTo(-size * 0.8, -size * 0.72);
  ctx.lineTo(-size * 0.35, 0);
  ctx.lineTo(-size * 0.8, size * 0.72);
  ctx.closePath();
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 3 * r;
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = 1 * r;
  ctx.stroke();
  ctx.restore();
}

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
export function areaLine(ctx, points, top, bottom, colour, fillAlpha, width, opts = {}) {
  if (points.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  if (opts.smooth) {
    // Through the midpoints, each sample a control point: a smooth line, as
    // RaceLab draws its traces, instead of the steps of the raw samples.
    for (let i = 1; i < points.length - 1; i++) {
      const [x, y] = points[i];
      const [nx, ny] = points[i + 1];
      ctx.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
    }
    ctx.lineTo(points[points.length - 1][0], points[points.length - 1][1]);
  } else {
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
  }
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  // A theme that glows more than the default (Synthwave) gets a neon line,
  // and so does a block asked for one. The default's 6px is for small lit
  // things, not every trace.
  const glow = opts.glow ?? (COLORS.glow > 6 ? width * 3.5 : 0);
  if (glow > 0) {
    ctx.save();
    ctx.shadowColor = colour;
    ctx.shadowBlur = glow;
    ctx.stroke();
    ctx.restore();
  }
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

/** #rrggbb → [r, g, b]; mid grey for anything else. */
function rgbOf(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? "");
  if (m === null) return [128, 128, 128];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Tyre carcass temperature → colour: cold, cool, in the window, warm, hot —
 * in the theme's blue, cyan, green, yellow and red, so a theme that moves
 * "good" and "bad" moves the tyres with them.
 */
export function tempColour(c) {
  if (!(c > 0)) return "rgba(255,255,255,0.08)";
  const at = [40, 70, 85, 100, 115];
  const stops = at.map((t, i) => [t, COLORS.temps[i]]);
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
