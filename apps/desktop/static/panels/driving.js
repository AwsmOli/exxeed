// Driving panels — the car's own inputs, and those inputs against the
// reference lap (§7.1).
//
// Every canvas here is drawn from the rAF loop and nothing else (§7.0): the
// state frame is stashed as it arrives and read at paint time.

import { canvasIn, numberAttr, registerBlock } from "./blocks.js";
import { templated } from "./templated.js";
import { alpha, areaLine, COLORS, fit, kph, pctDelta, sample, wrap01 } from "./util.js";

const gearText = (g) => (g === -1 ? "R" : g === 0 ? "N" : typeof g === "number" ? String(g) : "–");
const font = () => COLORS.font;
const unit = (v) => Math.max(0, Math.min(1, v ?? 0));

// ---------------------------------------------------------------------------
// Shared pieces.
// ---------------------------------------------------------------------------

/** Throttle and brake against time — the last few seconds, newest at the right. */
const TIMELINE_S = 5;

function drawTimeline(canvas, timeline, seconds = TIMELINE_S) {
  const c = fit(canvas);
  if (c === null) return;
  const { ctx, w, h, r } = c;
  ctx.clearRect(0, 0, w, h);

  const top = 4 * r;
  const bottom = h - 3 * r;
  ctx.strokeStyle = alpha(COLORS.ink, 0.05);
  ctx.lineWidth = 1 * r;
  for (const q of [0.25, 0.5, 0.75]) {
    const y = bottom - q * (bottom - top);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  if (timeline.length < 2) return;
  const now = timeline[timeline.length - 1].t;
  const pts = timeline.filter((p) => now - p.t <= seconds * 1000);
  const x = (t) => w - ((now - t) / (seconds * 1000)) * w;
  const y = (v) => bottom - v * (bottom - top);
  areaLine(ctx, pts.map((p) => [x(p.t), y(p.throttle)]), top, bottom, COLORS.throttle, 0.3, 2.2 * r);
  areaLine(ctx, pts.map((p) => [x(p.t), y(p.brake)]), top, bottom, COLORS.brake, 0.3, 2.2 * r);
}

/** Degrees the wheel icon turns. The frame is radians at the wheel. */
const wheelDeg = (f) => (typeof f?.steerRad === "number" ? (-f.steerRad * 180) / Math.PI : 0);

// ---------------------------------------------------------------------------
// Essential inputs: a short input trace, the three pedals, speed and gear,
// and the wheel.
// ---------------------------------------------------------------------------

/** What the pedals, speed, gear and wheel read, for both input panels' templates. */
function inputsModel(s) {
  const f = s.frame;
  const pedal = (v) => {
    const p = unit(v);
    // pct: 0–100 for a bar's height; text: "07", as the sim pads it; knob: the
    // cap's lift off the fill's top, so it never leaves the bar.
    return { pct: Math.round(p * 100), text: String(Math.round(p * 100)).padStart(2, "0"), knob: (p * 5).toFixed(1) };
  };
  return {
    clutch: pedal(f?.clutch ?? 0),
    brake: pedal(f?.brake),
    throttle: pedal(f?.throttle),
    speedKph: Math.round(kph(f?.speedMps)),
    gear: gearText(f?.gear),
    wheelDeg: wheelDeg(f).toFixed(1),
    rpm: f?.rpm ?? null,
  };
}

const INPUTS = `
<div class="panel inputs">
  <div class="card grow">
    <div class="inputs-body">
      <div class="graph" data-part="graph"><x-timeline></x-timeline></div>
      <div class="pedals" data-part="pedals">
        <div class="pedal clutch"><span class="v n">{{ clutch.text }}%</span><div class="pill-v"><i style="height:{{ clutch.pct }}%"></i></div></div>
        <div class="pedal brake"><span class="v n">{{ brake.text }}%</span><div class="pill-v"><i style="height:{{ brake.pct }}%"></i></div></div>
        <div class="pedal throttle"><span class="v n">{{ throttle.text }}%</span><div class="pill-v"><i style="height:{{ throttle.pct }}%"></i></div></div>
      </div>
      <div class="sep" data-part="speed"></div>
      <div class="speedo" data-part="speed">
        <div class="line"><span class="lg n spd">{{ speedKph }}</span><span class="u">KM/H</span></div>
        <div class="line good"><span class="xl n gr gear-n">{{ gear }}</span><x-icon name="gearbox"></x-icon></div>
      </div>
      <div class="wheel" data-part="wheel" style="transform:rotate({{ wheelDeg }}deg)"><x-icon name="wheel" size="44"></x-icon></div>
    </div>
  </div>
</div>`;

export const inputs = templated({ template: INPUTS, model: inputsModel });

// ---------------------------------------------------------------------------
// Input telemetry: shift lights across the top, the live delta on a tab above
// them, the trace, brake and throttle, speed and gear against the
// reference's, force feedback, and the wheel in a dial.
// ---------------------------------------------------------------------------

// The shift lights' colours, outer to inner, are COLORS.shift (util.js): the
// theme's own ramp, and its glow.

function drawDial(canvas, f) {
  const c = fit(canvas);
  if (c === null) return;
  const { ctx, w, h, r } = c;
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) / 2 - 2 * r;
  const ring = 7 * r;

  ctx.lineWidth = ring;
  ctx.strokeStyle = alpha(COLORS.ink, 0.08);
  ctx.beginPath();
  ctx.arc(cx, cy, R - ring / 2, 0, Math.PI * 2);
  ctx.stroke();

  // How far the wheel is turned, as an arc from the top.
  const a = (wheelDeg(f) * Math.PI) / 180;
  if (Math.abs(a) > 0.01) {
    ctx.strokeStyle = alpha(COLORS.ink, 0.3);
    ctx.beginPath();
    ctx.arc(cx, cy, R - ring / 2, -Math.PI / 2, -Math.PI / 2 + a, a < 0);
    ctx.stroke();
  }
  // The tick at the wheel's top-dead-centre.
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(a);
  ctx.strokeStyle = COLORS.ink;
  ctx.lineWidth = 2 * r;
  ctx.beginPath();
  ctx.moveTo(0, -R);
  ctx.lineTo(0, -R + ring + 2 * r);
  ctx.stroke();
  ctx.restore();
}

/**
 * The shift lights, from both ends inwards: how many are lit from the revs
 * against the car's shift points, and all of them blinking past the blink point.
 * Shared by Input Telemetry's row and the Rev Lights overlay.
 */
/**
 * The other way to show the revs, for themes that ask for it (shift-style
 * "sweep"): one curved line, low on the left and rising to the right, that
 * fills white with the revs and flashes red, fast, from the shift point on.
 * Gran Turismo's tachometer works this way.
 *
 * The fill is the whole line, revealed from the left by a clip; the line only
 * ever moves rightwards, so revealing it by x is the same as filling it along
 * its length. It is drawn in the block's own pixels, rebuilt when the block
 * changes size, so a hatched band keeps even ticks however it is stretched.
 */
let sweepIds = 0;

/** The line through a w × h box, inset by `pad`: a swoop, an arc, GT's arch, or straight. */
function sweepPath(shape, w, h, pad) {
  const left = pad;
  const right = w - pad;
  const top = pad;
  const bottom = h - pad;
  const x = (u) => left + (u / 400) * (right - left);
  const y = (v) => top + ((v - 6) / 44) * (bottom - top);
  if (shape === "line") return `M ${left} ${(top + bottom) / 2} L ${right} ${(top + bottom) / 2}`;
  if (shape === "arc") return `M ${left} ${bottom} Q ${w / 2} ${top - (bottom - top)} ${right} ${bottom}`;
  if (shape === "arch") {
    // Gran Turismo's: flat across the middle, the ends bending down at the sides.
    const span = right - left;
    const bend = top + (bottom - top) * 0.3;
    return `M ${left} ${bottom} C ${left + span * 0.03} ${bend}, ${left + span * 0.24} ${top}, ${w / 2} ${top} C ${right - span * 0.24} ${top}, ${right - span * 0.03} ${bend}, ${right} ${bottom}`;
  }
  // The swoop: low and flat on the left, rising to the right.
  return `M ${x(6)} ${y(50)} C ${x(110)} ${y(50)}, ${x(210)} ${y(48)}, ${x(282)} ${y(36)} S ${x(372)} ${y(12)}, ${x(394)} ${y(6)}`;
}

/**
 * A small arrowhead just outside the line at x, pointing at it: where the
 * redline is. The line's height there is found along the path, which only
 * ever moves rightwards, by halving.
 */
function markAt(path, x, half) {
  const total = path.getTotalLength();
  let lo = 0;
  let hi = total;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (path.getPointAtLength(mid).x < x) lo = mid;
    else hi = mid;
  }
  const p = path.getPointAtLength(lo);
  const q = path.getPointAtLength(Math.min(total, lo + 1));
  // Outwards from the curve (up, for an arch), along its normal.
  let nx = -(q.y - p.y);
  let ny = q.x - p.x;
  const len = Math.hypot(nx, ny) || 1;
  nx /= len;
  ny /= len;
  if (ny > 0) {
    nx = -nx;
    ny = -ny;
  }
  const tip = [p.x + nx * (half + 1), p.y + ny * (half + 1)];
  const size = Math.max(4, half);
  const back = [tip[0] + nx * size * 1.3, tip[1] + ny * size * 1.3];
  const side = [-ny * size * 0.75, nx * size * 0.75];
  const pt = (a) => `${a[0].toFixed(1)} ${a[1].toFixed(1)}`;
  return `M ${pt(tip)} L ${pt([back[0] + side[0], back[1] + side[1]])} L ${pt([back[0] - side[0], back[1] - side[1]])} Z`;
}

function sweepBlock(el) {
  const id = ++sweepIds;
  el.innerHTML = `
    <svg class="shift-sweep" aria-hidden="true">
      <defs>
        <clipPath id="sweep-reveal-${id}"><rect class="sweep-reveal" x="0" y="0" width="0" height="0" /></clipPath>
        <linearGradient id="sweep-lit-${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1" y2="0">
          <stop class="sweep-stop-lit" offset="0" /><stop class="sweep-stop-lit" offset="1" />
          <stop class="sweep-stop-red" offset="1" /><stop class="sweep-stop-red" offset="1" />
        </linearGradient>
      </defs>
      <path class="sweep-body" /><path class="sweep-edge" /><path class="sweep-track" />
      <path class="sweep-fill" clip-path="url(#sweep-reveal-${id})" stroke="url(#sweep-lit-${id})" />
      <path class="sweep-mark" />
    </svg>`;
  const svg = el.firstElementChild;
  const reveal = svg.querySelector(".sweep-reveal");
  const gradient = svg.querySelector("linearGradient");
  const stops = [...gradient.children];
  /** Everything under the line, down to the block's foot: a body whose top edge is the band (theme.css fills it). */
  const body = svg.querySelector(".sweep-body");
  /** The small arrow at the redline (attribute mark). */
  const mark = svg.querySelector(".sweep-mark");
  const paths = [...svg.querySelectorAll("path:not(.sweep-body):not(.sweep-mark)")];
  const fill = svg.querySelector(".sweep-fill");
  let built = "";
  let from = 0;
  let to = 0;
  /** Half the thickest stroke: how far a round cap reaches past the line's ends. */
  let half = 0;

  return {
    paint(s) {
      // Its own size, not the scaled one: the overlay may be shrunk with a transform.
      const w = svg.clientWidth;
      const h = svg.clientHeight;
      if (w === 0 || h === 0) return;
      const shape = el.getAttribute("shape") ?? "swoop";
      const redline = Math.max(0, Math.min(1, numberAttr(el, "redline", 1)));
      const hatch = el.hasAttribute("hatch");
      const key = `${w}x${h}:${shape}:${redline}:${hatch}:${el.hasAttribute("mark")}`;
      if (key !== built) {
        built = key;
        svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
        svg.classList.toggle("hatched", hatch);
        half = Math.max(...paths.map((p) => parseFloat(getComputedStyle(p).strokeWidth) || 0)) / 2 + 1;
        const d = sweepPath(shape, w, h, half);
        for (const p of paths) p.setAttribute("d", d);
        body.setAttribute("d", `${d} L ${w} ${h} L 0 ${h} Z`);
        mark.setAttribute("d", el.hasAttribute("mark") && redline < 1 ? markAt(paths[0], half + redline * (w - 2 * half), half) : "");
        from = half;
        to = w - half;
        reveal.setAttribute("y", "-1000");
        reveal.setAttribute("height", String(h + 2000));
        gradient.setAttribute("x1", String(from));
        gradient.setAttribute("x2", String(to));
        // Lit colour up to the redline, the red beyond it.
        stops[1].setAttribute("offset", String(redline));
        stops[2].setAttribute("offset", String(redline));
      }
      const r = revs(s);
      const shifting = r?.shift ?? false;
      const f = shifting ? 1 : Math.max(0, Math.min(1, r?.fraction ?? 0));
      reveal.setAttribute("x", String(from - half));
      reveal.setAttribute("width", f === 0 ? "0" : (half + f * (to - from) + (f === 1 ? 2 * half : 0)).toFixed(1));
      // At the shift point the whole line takes over: full, red, and blinking
      // hard enough to catch in the corner of an eye.
      const flash = shifting && Math.floor(performance.now() / 55) % 2 === 0;
      fill.classList.toggle("shift-now", shifting);
      fill.style.visibility = shifting && !flash ? "hidden" : "";
    },
  };
}

/** How far through the shift range the revs are, 0–1, and whether to shift: null without shift points. */
function revs(s) {
  const sl = s.race?.shiftLights ?? null;
  const rpm = s.frame?.rpm ?? null;
  if (sl === null || rpm === null || !(sl.shiftRpm > sl.firstRpm)) return null;
  return {
    fraction: (rpm - sl.firstRpm) / (sl.shiftRpm - sl.firstRpm),
    shift: rpm >= sl.shiftRpm,
    blink: rpm >= sl.blinkRpm,
  };
}

function drawShiftLights(lights, s) {
  const r = revs(s);
  const lit = r === null ? 0 : Math.max(0, Math.min(8, Math.ceil(r.fraction * 8)));
  const blink = r !== null && r.blink && Math.floor(performance.now() / 90) % 2 === 0;
  lights.forEach((light, i) => {
    const j = i < 8 ? i : 15 - i;
    const on = blink || j < lit;
    const colour = blink ? COLORS.shiftBlink : COLORS.shift[j];
    light.style.background = on ? colour : "";
    light.style.boxShadow = on && COLORS.glow > 0 ? `0 0 ${COLORS.glow}px ${alpha(colour, 0.6)}` : "";
  });
}

registerBlock(
  "x-shift-lights",
  {
    summary:
      "Sixteen rev lights lighting from both ends inwards, in the theme's shift colours, all blinking at the shift point. Hidden when the theme's shift-style is sweep.",
    attributes: {},
  },
  (el) => {
    el.classList.add("shift");
    el.innerHTML = "<i></i>".repeat(16);
    const lights = [...el.children];
    return { paint: (s) => drawShiftLights(lights, s) };
  },
);

registerBlock(
  "x-sweep",
  {
    summary:
      "Gran Turismo's rev line: a curve that fills white with the revs and flashes red from the shift point. Shown only when the theme's shift-style is sweep.",
    attributes: {
      shape: "swoop (default, rising to the right) | arch (flat, the ends bending down — Gran Turismo's) | arc | line",
      hatch: "fine ticks instead of a solid line, as Gran Turismo's rev band",
      redline: "0–1: how far along the lit part turns red; 1 (default) for never",
      mark: "a small arrow at the redline, pointing at the band, as Gran Turismo's",
    },
  },
  sweepBlock,
);

registerBlock(
  "x-timeline",
  {
    summary: "Throttle and brake against time, newest at the right.",
    attributes: { seconds: "how much time it spans; 5 by default" },
  },
  (el) => ({ paint: (s) => drawTimeline(canvasIn(el), s.timeline, numberAttr(el, "seconds", TIMELINE_S)) }),
);

registerBlock(
  "x-wheel-dial",
  { summary: "A ring showing how far the wheel is turned, with a tick at its top.", attributes: {} },
  (el) => ({ paint: (s) => drawDial(canvasIn(el), s.frame) }),
);

// ---------------------------------------------------------------------------
// Rev lights on their own, to put wherever the eye already is — above the
// mirror, beside the dash — rather than wherever Input Telemetry sits.
// ---------------------------------------------------------------------------

const REVLIGHTS = `
<div class="panel revlights" data-class="is-empty: empty">
  <div class="card grow revlights-card">
    <x-shift-lights></x-shift-lights>
    <x-sweep></x-sweep>
  </div>
  <div class="empty">waiting for the sim</div>
</div>`;

// The shift points come with the race data: without them there is nothing
// to light the row against.
export const revlights = templated({
  template: REVLIGHTS,
  model: (s) => ({ empty: s.race?.shiftLights == null, ...revsModel(s) }),
});

/** The revs for a template: rpm, shiftFraction (0–1), shifting. */
function revsModel(s) {
  const r = revs(s);
  return { rpm: s.frame?.rpm ?? null, shiftFraction: r === null ? 0 : unit(r.fraction), shifting: r?.shift ?? false };
}

function pedalsModel(s) {
  const f = s.frame;
  const ref = s.reference;
  const atRef = ref !== null && f !== null;
  const d = f?.deltaS;
  const timed = typeof d === "number" && Math.abs(d) >= 0.005;
  return {
    ...inputsModel(s),
    ...revsModel(s),
    refSpeedKph: atRef ? Math.round(kph(sample(ref.speedMps, ref.gridSize, f.lapDistPct))) : null,
    refGear: atRef ? gearText(ref.gear ? sample(ref.gear, ref.gridSize, f.lapDistPct) : undefined) : null,
    deltaS: typeof d === "number" ? d : null,
    // Gaining is good, losing is bad; under 5 ms is neither.
    gaining: timed && d < 0,
    losing: timed && d > 0,
    ffbPct: Math.round(unit(f?.ffb) * 100),
  };
}

const PEDALS = `
<div class="panel tab-wrap pedals-panel">
  <div class="tab n" data-part="delta" data-class="good: gaining; bad: losing">{{ deltaS | signed:3 | or:— }}</div>
  <div class="card grow">
    <x-shift-lights data-part="revlights"></x-shift-lights>
    <x-sweep data-part="revlights"></x-sweep>
    <div class="inputs-body">
      <div class="graph" data-part="graph"><x-timeline></x-timeline></div>
      <div class="pedals" data-part="pedals">
        <div class="pedal knob brake"><span class="v n">{{ brake.pct }}</span><div class="pill-v"><i style="height:{{ brake.pct }}%"></i><b style="bottom:calc({{ brake.pct }}% - {{ brake.knob }}px)"></b></div></div>
        <div class="pedal knob throttle"><span class="v n">{{ throttle.pct }}</span><div class="pill-v"><i style="height:{{ throttle.pct }}%"></i><b style="bottom:calc({{ throttle.pct }}% - {{ throttle.knob }}px)"></b></div></div>
      </div>
      <div class="speedo">
        <div class="line good"><span class="xl n spd">{{ speedKph }}</span><span class="u">km/h</span>
          <span class="gear good"><x-icon name="gearbox"></x-icon><span class="xl n gr">{{ gear }}</span></span></div>
        <div class="line ref" data-part="reference"><span class="xl n spd">{{ refSpeedKph | or:— }}</span><span class="u">km/h</span>
          <span class="gear"><x-icon name="gearbox"></x-icon><span class="xl n gr">{{ refGear | or:– }}</span></span></div>
        <div class="ffb" data-part="ffb">FF<div class="pill-h"><i style="width:{{ ffbPct }}%"></i></div></div>
      </div>
      <div class="wheel dial" data-part="wheel">
        <x-wheel-dial></x-wheel-dial>
        <div class="wheel-icon" style="transform:rotate({{ wheelDeg }}deg)"><x-icon name="wheel" size="30"></x-icon></div>
      </div>
    </div>
  </div>
</div>`;

export const pedals = templated({ template: PEDALS, model: pedalsModel });

// ---------------------------------------------------------------------------
// The comparison window both lap-position panels share: a stretch of the lap
// around the car, which sits in the middle — the road just driven on the
// left, and the reference showing what is coming on the right (§7.1).
// ---------------------------------------------------------------------------

const WINDOW_PCT = 0.08;
const CURSOR = 0.5;
const GUTTER = 22;

function chrome(ctx, w, h, r, title, yLabels, lengthM, here) {
  ctx.font = `700 ${9 * r}px ${font()}`;
  ctx.fillStyle = alpha(COLORS.ink, 0.7);
  ctx.textBaseline = "top";
  ctx.fillText(title, (GUTTER + 4) * r, 4 * r);

  ctx.fillStyle = alpha(COLORS.ink, 0.5);
  ctx.textAlign = "right";
  for (const [label, y] of yLabels) {
    ctx.textBaseline = "middle";
    ctx.fillText(label, (GUTTER - 5) * r, y);
    ctx.strokeStyle = alpha(COLORS.ink, 0.05);
    ctx.lineWidth = 1 * r;
    ctx.beginPath();
    ctx.moveTo(GUTTER * r, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  ctx.textAlign = "center";

  // Distance along the lap, every 200 m, under the plot.
  if (lengthM !== null) {
    const x = axis(w, r, here);
    const from = (here - WINDOW_PCT) * lengthM;
    const to = (here + WINDOW_PCT) * lengthM;
    ctx.textBaseline = "bottom";
    for (let m = Math.ceil(from / 200) * 200; m <= to; m += 200) {
      const lapM = ((m % lengthM) + lengthM) % lengthM;
      ctx.fillText(`${Math.round(lapM)}m`, x(m / lengthM), h - 1 * r);
    }
  }
  ctx.textAlign = "start";
}

function axis(w, r, here) {
  const left = GUTTER * r;
  return (p) => left + (CURSOR + pctDelta(p, here) / (WINDOW_PCT * 2)) * (w - left);
}

/** The reference over the window, split at the car: behind it and ahead of it. */
function referenceSplit(channel, gridSize, here, x, yOf) {
  const behind = [];
  const ahead = [];
  for (let step = -60; step <= 60; step++) {
    const p = wrap01(here + (step / 60) * WINDOW_PCT);
    const v = sample(channel, gridSize, p);
    if (typeof v !== "number") continue;
    const pt = [x(p), yOf(v)];
    if (step <= 0) behind.push(pt);
    if (step >= 0) ahead.push(pt);
  }
  return { behind, ahead };
}

/**
 * The live trace: the run of samples leading up to the car, and nothing else.
 *
 * The history holds more than one lap, so "every sample inside the window"
 * also picks up the same stretch from the lap before — and joining those to
 * this lap's draws a line from the cursor back across the chart. Walking back
 * from the newest sample and stopping at the first one that is out of the
 * window, or further forward than the one after it (an earlier pass, a reset,
 * a replay looping), keeps exactly the current pass.
 */
function livePoints(history, here, x, pick, yOf) {
  const points = [];
  let after = Infinity;
  for (let i = history.length - 1; i >= 0; i--) {
    const s = history[i];
    const d = pctDelta(s.pct, here);
    if (d > 0.0005) continue;
    if (d < -WINDOW_PCT || d > after + 0.0005) break;
    after = d;
    points.push([x(s.pct), yOf(pick(s))]);
  }
  return points.reverse();
}

function cursor(ctx, x, top, bottom, r) {
  ctx.strokeStyle = alpha(COLORS.ink, 0.85);
  ctx.lineWidth = 1.2 * r;
  ctx.beginPath();
  ctx.moveTo(x, top);
  ctx.lineTo(x, bottom);
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// Input comparison (§7.1): throttle and brake on one plot, yours up to the
// car and the reference's beyond it, with the reference's braking points
// marked — "seeing your brake trace start after the reference marker is the
// single most legible piece of feedback in the app."
// ---------------------------------------------------------------------------

function drawTrace(canvas, s) {
  if (s.reference === null) return;
  const c = fit(canvas);
  if (c === null) return;
  const { ctx, w, h, r } = c;
  ctx.clearRect(0, 0, w, h);

  const ref = s.reference;
  const here = s.frame?.lapDistPct ?? 0;
  const x = axis(w, r, here);
  const top = 18 * r;
  const bottom = h - 14 * r;
  const y = (v) => bottom - v * (bottom - top);
  chrome(ctx, w, h, r, "THROTTLE/BRAKE · %", [["100", y(1)], ["50", y(0.5)], ["0", y(0)]], s.map?.lengthM ?? s.race?.trackLengthM ?? null, here);

  ctx.strokeStyle = alpha(COLORS.orange, 0.8);
  ctx.lineWidth = 1.2 * r;
  ctx.setLineDash([3 * r, 3 * r]);
  for (const p of ref.brakeOnsetPcts) {
    if (Math.abs(pctDelta(p, here)) > WINDOW_PCT) continue;
    ctx.beginPath();
    ctx.moveTo(x(p), top);
    ctx.lineTo(x(p), bottom);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  const thr = referenceSplit(ref.throttle, ref.gridSize, here, x, y);
  const brk = referenceSplit(ref.brake, ref.gridSize, here, x, y);
  // Ahead: the reference is all there is, drawn as a dim version of the
  // live colours. Behind: a thin ghost under your own trace.
  areaLine(ctx, thr.ahead, top, bottom, alpha(COLORS.throttle, 0.45), 0.14, 1.4 * r);
  areaLine(ctx, brk.ahead, top, bottom, alpha(COLORS.brake, 0.5), 0.16, 1.4 * r);
  areaLine(ctx, thr.behind, top, bottom, alpha(COLORS.ink, 0.28), 0, 1 * r);
  areaLine(ctx, brk.behind, top, bottom, alpha(COLORS.ink, 0.28), 0, 1 * r);
  areaLine(ctx, livePoints(s.history, here, x, (p) => p.throttle, y), top, bottom, COLORS.throttle, 0.3, 2.2 * r);
  areaLine(ctx, livePoints(s.history, here, x, (p) => p.brake, y), top, bottom, COLORS.brake, 0.32, 2.2 * r);

  cursor(ctx, x(here), top - 4 * r, bottom, r);
}

/** Both comparison panels: a chart against the reference, or why there is none. */
const comparison = (block) => `
<div class="panel comparison" data-class="is-empty: noReference">
  <div class="card grow chart-card">${block}</div>
  <div class="empty">no reference lap for this car — nothing to compare against</div>
</div>`;
const comparisonModel = (s) => ({ noReference: s.reference === null });

registerBlock(
  "x-trace",
  {
    summary:
      "Throttle and brake by lap position: yours up to the car, the reference's beyond it, its braking points dashed.",
    attributes: {},
  },
  (el) => ({ paint: (s) => drawTrace(canvasIn(el), s) }),
);

export const trace = templated({ template: comparison("<x-trace></x-trace>"), model: comparisonModel });

// ---------------------------------------------------------------------------
// Speed comparison: the same window, speed against the reference's.
// ---------------------------------------------------------------------------

function drawSpeed(canvas, s) {
  if (s.reference === null) return;
  const c = fit(canvas);
  if (c === null) return;
  const { ctx, w, h, r } = c;
  ctx.clearRect(0, 0, w, h);

  const ref = s.reference;
  const here = s.frame?.lapDistPct ?? 0;

  // Scaled to what is on screen, so a corner's shape fills the panel
  // instead of being a ripple on a 0–300 axis.
  let lo = Infinity;
  let hi = -Infinity;
  for (let step = -60; step <= 60; step++) {
    const v = kph(sample(ref.speedMps, ref.gridSize, here + (step / 60) * WINDOW_PCT));
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  if (!Number.isFinite(lo)) return;
  lo = Math.max(0, Math.floor((lo - 10) / 10) * 10);
  hi = Math.ceil((hi + 10) / 10) * 10;

  const x = axis(w, r, here);
  const top = 18 * r;
  const bottom = h - 14 * r;
  const y = (v) => bottom - ((v - lo) / (hi - lo)) * (bottom - top);
  const mid = Math.round((lo + hi) / 2);
  const liveNow = kph(s.frame?.speedMps);
  const diff = liveNow - kph(sample(ref.speedMps, ref.gridSize, here));
  chrome(
    ctx, w, h, r,
    `SPEED · KM/H   ${diff >= 0 ? "+" : "−"}${Math.abs(diff).toFixed(0)}`,
    [[String(hi), y(hi)], [String(mid), y(mid)], [String(lo), y(lo)]],
    s.map?.lengthM ?? s.race?.trackLengthM ?? null,
    here,
  );

  const refPts = referenceSplit(ref.speedMps, ref.gridSize, here, x, (v) => y(kph(v)));
  areaLine(ctx, refPts.ahead, top, bottom, alpha(COLORS.cyan, 0.45), 0.14, 1.4 * r);
  areaLine(ctx, refPts.behind, top, bottom, alpha(COLORS.ink, 0.28), 0, 1 * r);
  areaLine(ctx, livePoints(s.history, here, x, (p) => kph(p.speed), y), top, bottom, COLORS.cyan, 0.26, 2.2 * r);
  cursor(ctx, x(here), top - 4 * r, bottom, r);
}

registerBlock(
  "x-speed-trace",
  { summary: "Speed by lap position against the reference's, scaled to what is on screen.", attributes: {} },
  (el) => ({ paint: (s) => drawSpeed(canvasIn(el), s) }),
);

export const speed = templated({ template: comparison("<x-speed-trace></x-speed-trace>"), model: comparisonModel });

// ---------------------------------------------------------------------------
// Brake indicator: a bar that fills towards the reference's braking point,
// with the boards marked under it. Exxeed says where to brake out loud; this
// is the same answer for the eye.
// ---------------------------------------------------------------------------

const BOARDS = [120, 90, 60, 30];
const RANGE_M = 150;
/** How long the bar stays lit past the point — long enough to be seen. */
const HOLD_M = 25;

const atBoard = (m) => ((RANGE_M - m) / RANGE_M) * 100;

function brakeModel(s) {
  const ref = s.reference;
  const lengthM = s.map?.lengthM ?? s.race?.trackLengthM ?? null;
  const ready = ref !== null && ref.brakeOnsetPcts.length > 0 && lengthM !== null;
  const boards = BOARDS.map((m) => ({ metres: m, at: atBoard(m).toFixed(1) }));
  if (!ready || s.frame === null) return { empty: !ready, fillPct: 0, now: false, metresToGo: null, boards };
  const here = s.frame.lapDistPct;
  let best = Infinity;
  for (const p of ref.brakeOnsetPcts) {
    const d = pctDelta(p, here) * lengthM;
    if (d > -HOLD_M && d < best) best = d;
  }
  const k = best > RANGE_M ? 0 : Math.min(1, (RANGE_M - Math.max(0, best)) / RANGE_M);
  return {
    empty: false,
    fillPct: (k * 100).toFixed(1),
    now: best <= 0,
    metresToGo: Number.isFinite(best) ? Math.max(0, Math.round(best)) : null,
    boards,
  };
}

const BRAKE = `
<div class="panel brake-panel" data-class="is-empty: empty">
  <div class="card grow">
    <div class="brake-bar" data-class="now: now"><i style="width:{{ fillPct }}%"></i><s data-each="boards" style="left:{{ at }}%"></s></div>
    <div class="brake-marks"><span data-each="boards" style="left:{{ at }}%">{{ metres }}m</span></div>
  </div>
  <div class="empty">no reference lap — no braking points</div>
</div>`;

export const brake = templated({ template: BRAKE, model: brakeModel });
