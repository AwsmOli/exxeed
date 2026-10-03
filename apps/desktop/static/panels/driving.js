// Driving panels — the car's own inputs, and those inputs against the
// reference lap (§7.1).
//
// Every canvas here is drawn from the rAF loop and nothing else (§7.0): the
// state frame is stashed as it arrives and read at paint time.

import { gearbox, wheel } from "./icons.js";
import { $, alpha, areaLine, COLORS, deltaClass, fit, html, kph, pctDelta, sample, setText, signed, wrap01 } from "./util.js";

const gearText = (g) => (g === -1 ? "R" : g === 0 ? "N" : typeof g === "number" ? String(g) : "–");
const pctText = (v) => String(Math.round((v ?? 0) * 100)).padStart(2, "0");
const font = () => COLORS.font;

// ---------------------------------------------------------------------------
// Shared pieces.
// ---------------------------------------------------------------------------

/** Throttle and brake against time — the last few seconds, newest at the right. */
const TIMELINE_S = 5;

function drawTimeline(canvas, timeline) {
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
  const pts = timeline.filter((p) => now - p.t <= TIMELINE_S * 1000);
  const x = (t) => w - ((now - t) / (TIMELINE_S * 1000)) * w;
  const y = (v) => bottom - v * (bottom - top);
  areaLine(ctx, pts.map((p) => [x(p.t), y(p.throttle)]), top, bottom, COLORS.throttle, 0.3, 2.2 * r);
  areaLine(ctx, pts.map((p) => [x(p.t), y(p.brake)]), top, bottom, COLORS.brake, 0.3, 2.2 * r);
}

function pedal(label, colour, knob) {
  return `<div class="pedal${knob ? " knob" : ""}" data-p="${label}">
    <span class="v n">00</span>
    <div class="pill-v"><i style="background:${colour}"></i>${knob ? "<b></b>" : ""}</div>
  </div>`;
}

function setPedal(el, v, withPct) {
  const p = Math.max(0, Math.min(1, v ?? 0));
  setText($(el, ".v"), withPct ? `${pctText(p)}%` : String(Math.round(p * 100)));
  $(el, "i").style.height = `${p * 100}%`;
  const knob = $(el, "b");
  if (knob !== null) knob.style.bottom = `calc(${p * 100}% - ${p * 5}px)`;
}

/** Degrees the wheel icon turns. The frame is radians at the wheel. */
const wheelDeg = (f) => (typeof f?.steerRad === "number" ? (-f.steerRad * 180) / Math.PI : 0);

// ---------------------------------------------------------------------------
// Essential inputs: a short input trace, the three pedals, speed and gear,
// and the wheel.
// ---------------------------------------------------------------------------

export function inputs() {
  const el = html(`
    <div class="panel">
      <div class="card grow">
        <div class="inputs-body">
          <div class="graph" data-part="graph"><canvas class="fill"></canvas></div>
          <div class="pedals" data-part="pedals">
            ${pedal("clutch", COLORS.blue, false)}
            ${pedal("brake", "var(--brake)", false)}
            ${pedal("throttle", "var(--throttle)", false)}
          </div>
          <div class="sep" data-part="speed"></div>
          <div class="speedo" style="align-items:center" data-part="speed">
            <div class="line"><span class="lg n" data-k="speed">0</span><span class="u">KM/H</span></div>
            <div class="line good"><span class="xl n" data-k="gear" style="font-weight:600">N</span>${gearbox()}</div>
          </div>
          <div class="wheel" data-k="wheel" data-part="wheel">${wheel(44)}</div>
        </div>
      </div>
    </div>`);
  const canvas = $(el, "canvas");
  const pedals = {
    clutch: $(el, '[data-p="clutch"]'),
    brake: $(el, '[data-p="brake"]'),
    throttle: $(el, '[data-p="throttle"]'),
  };

  return {
    el,
    draw(s) {
      const f = s.frame;
      setPedal(pedals.clutch, f?.clutch ?? 0, true);
      setPedal(pedals.brake, f?.brake, true);
      setPedal(pedals.throttle, f?.throttle, true);
      setText($(el, '[data-k="speed"]'), String(Math.round(kph(f?.speedMps))));
      setText($(el, '[data-k="gear"]'), gearText(f?.gear));
      $(el, '[data-k="wheel"]').style.transform = `rotate(${wheelDeg(f)}deg)`;
      drawTimeline(canvas, s.timeline);
    },
  };
}

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
 * The fill is the whole line, revealed from the left by a clip. A dash along
 * the path would follow the curve more exactly, but the SVG is stretched to
 * its window (preserveAspectRatio none) and Chromium breaks a dash on a
 * stretched, non-scaling stroke into pieces. The line only ever rises to the
 * right, so revealing it by x is the same thing.
 */
const SWEEP_PATH = "M 6 50 C 110 50, 210 48, 282 36 S 372 12, 394 6";
let sweepIds = 0;
const sweepHtml = (part = "") => {
  const clip = `sweep-reveal-${++sweepIds}`;
  return `
  <svg class="shift-sweep" viewBox="0 0 400 56" preserveAspectRatio="none" aria-hidden="true"${part}>
    <clipPath id="${clip}"><rect class="sweep-reveal" x="-10" y="-20" width="0" height="96" /></clipPath>
    <path d="${SWEEP_PATH}" class="sweep-edge" />
    <path d="${SWEEP_PATH}" class="sweep-track" />
    <path d="${SWEEP_PATH}" class="sweep-fill" clip-path="url(#${clip})" />
  </svg>`;
};

function drawSweep(fill, fraction, shifting) {
  if (fill === null) return;
  const reveal = fill.ownerSVGElement.querySelector(".sweep-reveal");
  // From the line's left end (x 6, round cap and all) to its right end (x 394).
  const f = shifting ? 1 : Math.max(0, Math.min(1, fraction));
  reveal.setAttribute("width", f === 0 ? "0" : (16 + f * 388 + (f === 1 ? 20 : 0)).toFixed(1));
  // At the shift point the whole line takes over: full, red, and blinking
  // hard enough to catch in the corner of an eye.
  const flash = shifting && Math.floor(performance.now() / 55) % 2 === 0;
  fill.classList.toggle("shift-now", shifting);
  fill.style.visibility = shifting && !flash ? "hidden" : "";
}

function drawShiftLights(lights, s, sweep = null) {
  const sl = s.race?.shiftLights ?? null;
  const rpm = s.frame?.rpm ?? null;
  let lit = 0;
  let blink = false;
  if (sl !== null && rpm !== null && sl.shiftRpm > sl.firstRpm) {
    lit = Math.max(0, Math.min(8, Math.ceil(((rpm - sl.firstRpm) / (sl.shiftRpm - sl.firstRpm)) * 8)));
    blink = rpm >= sl.blinkRpm && Math.floor(performance.now() / 90) % 2 === 0;
    drawSweep(sweep, (rpm - sl.firstRpm) / (sl.shiftRpm - sl.firstRpm), rpm >= sl.shiftRpm);
  } else {
    drawSweep(sweep, 0, false);
  }
  lights.forEach((light, i) => {
    const j = i < 8 ? i : 15 - i;
    const on = blink || j < lit;
    const colour = blink ? COLORS.shiftBlink : COLORS.shift[j];
    light.style.background = on ? colour : "";
    light.style.boxShadow = on && COLORS.glow > 0 ? `0 0 ${COLORS.glow}px ${alpha(colour, 0.6)}` : "";
  });
}

// ---------------------------------------------------------------------------
// Rev lights on their own, to put wherever the eye already is — above the
// mirror, beside the dash — rather than wherever Input Telemetry sits.
// ---------------------------------------------------------------------------

export function revlights() {
  const el = html(`
    <div class="panel">
      <div class="card grow revlights-card">
        <div class="shift">${"<i></i>".repeat(16)}</div>
        ${sweepHtml()}
      </div>
      <div class="empty">waiting for the sim</div>
    </div>`);
  const lights = [...el.querySelectorAll(".shift i")];
  const sweep = $(el, ".sweep-fill");

  return {
    el,
    draw(s) {
      // The shift points come with the race data: without them there is
      // nothing to light the row against.
      el.classList.toggle("is-empty", s.race?.shiftLights == null);
      drawShiftLights(lights, s, sweep);
    },
  };
}

export function pedals() {
  const el = html(`
    <div class="panel tab-wrap">
      <div class="tab n" data-k="delta" data-part="delta">—</div>
      <div class="card grow">
        <div class="shift" data-part="revlights">${"<i></i>".repeat(16)}</div>
        ${sweepHtml(' data-part="revlights"')}
        <div class="inputs-body">
          <div class="graph" data-part="graph"><canvas class="fill" data-k="graph"></canvas></div>
          <div class="pedals" data-part="pedals">
            ${pedal("brake", "linear-gradient(0deg,var(--brake),color-mix(in srgb,var(--brake) 78%,white))", true)}
            ${pedal("throttle", "linear-gradient(0deg,var(--throttle),color-mix(in srgb,var(--throttle) 70%,white))", true)}
          </div>
          <div class="speedo">
            <div class="line good"><span class="xl n" data-k="speed">0</span><span class="u">km/h</span>
              <span class="gear good">${gearbox()}<span class="xl n" data-k="gear">N</span></span></div>
            <div class="line ref" data-part="reference"><span class="xl n" data-k="rspeed">—</span><span class="u">km/h</span>
              <span class="gear">${gearbox()}<span class="xl n" data-k="rgear">–</span></span></div>
            <div class="ffb" data-part="ffb">FF<div class="pill-h"><i data-k="ffb" style="background:color-mix(in srgb, var(--text) 75%, transparent)"></i></div></div>
          </div>
          <div class="wheel" style="position:relative;width:64px;height:64px" data-part="wheel">
            <canvas class="fill" data-k="dial"></canvas>
            <div data-k="wheel" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">${wheel(30)}</div>
          </div>
        </div>
      </div>
    </div>`);
  const k = (name) => $(el, `[data-k="${name}"]`);
  const lights = [...el.querySelectorAll(".shift i")];
  const sweepFill = $(el, ".sweep-fill");
  const brakeP = $(el, '[data-p="brake"]');
  const throttleP = $(el, '[data-p="throttle"]');

  return {
    el,
    draw(s) {
      const f = s.frame;
      setPedal(brakeP, f?.brake, false);
      setPedal(throttleP, f?.throttle, false);
      setText(k("speed"), String(Math.round(kph(f?.speedMps))));
      setText(k("gear"), gearText(f?.gear));

      const ref = s.reference;
      if (ref !== null && f !== null) {
        setText(k("rspeed"), String(Math.round(kph(sample(ref.speedMps, ref.gridSize, f.lapDistPct)))));
        setText(k("rgear"), gearText(ref.gear ? sample(ref.gear, ref.gridSize, f.lapDistPct) : undefined));
      }

      const d = f?.deltaS;
      const tab = k("delta");
      setText(tab, typeof d === "number" ? signed(d, 3) : "—");
      tab.className = `tab n ${deltaClass(d)}`;

      k("ffb").style.width = `${Math.round(Math.max(0, Math.min(1, f?.ffb ?? 0)) * 100)}%`;
      k("wheel").style.transform = `rotate(${wheelDeg(f)}deg)`;

      drawShiftLights(lights, s, sweepFill);

      drawTimeline(k("graph"), s.timeline);
      drawDial(k("dial"), f);
    },
  };
}

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

const noReference = `<div class="empty">no reference lap for this car — nothing to compare against</div>`;

// ---------------------------------------------------------------------------
// Input comparison (§7.1): throttle and brake on one plot, yours up to the
// car and the reference's beyond it, with the reference's braking points
// marked — "seeing your brake trace start after the reference marker is the
// single most legible piece of feedback in the app."
// ---------------------------------------------------------------------------

export function trace() {
  const el = html(`<div class="panel is-empty"><div class="card grow" style="padding:4px 8px 2px 0"><canvas class="fill"></canvas></div>${noReference}</div>`);
  const canvas = $(el, "canvas");

  return {
    el,
    draw(s) {
      el.classList.toggle("is-empty", s.reference === null);
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
    },
  };
}

// ---------------------------------------------------------------------------
// Speed comparison: the same window, speed against the reference's.
// ---------------------------------------------------------------------------

export function speed() {
  const el = html(`<div class="panel is-empty"><div class="card grow" style="padding:4px 8px 2px 0"><canvas class="fill"></canvas></div>${noReference}</div>`);
  const canvas = $(el, "canvas");

  return {
    el,
    draw(s) {
      el.classList.toggle("is-empty", s.reference === null);
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
    },
  };
}

// ---------------------------------------------------------------------------
// Brake indicator: a bar that fills towards the reference's braking point,
// with the boards marked under it. Exxeed says where to brake out loud; this
// is the same answer for the eye.
// ---------------------------------------------------------------------------

const BOARDS = [120, 90, 60, 30];
const RANGE_M = 150;
/** How long the bar stays lit past the point — long enough to be seen. */
const HOLD_M = 25;

export function brake() {
  const at = (m) => ((RANGE_M - m) / RANGE_M) * 100;
  const el = html(`
    <div class="panel is-empty">
      <div class="card grow" style="justify-content:center">
        <div class="brake-bar"><i></i>${BOARDS.map((m) => `<s style="left:${at(m)}%"></s>`).join("")}</div>
        <div class="brake-marks">${BOARDS.map((m) => `<span style="left:${at(m)}%">${m}m</span>`).join("")}</div>
      </div>
      <div class="empty">no reference lap — no braking points</div>
    </div>`);
  const bar = $(el, ".brake-bar");
  const fill = $(el, ".brake-bar i");

  return {
    el,
    draw(s) {
      const ref = s.reference;
      const lengthM = s.map?.lengthM ?? s.race?.trackLengthM ?? null;
      const ready = ref !== null && ref.brakeOnsetPcts.length > 0 && lengthM !== null;
      el.classList.toggle("is-empty", !ready);
      if (!ready || s.frame === null) return;

      const here = s.frame.lapDistPct;
      let best = Infinity;
      for (const p of ref.brakeOnsetPcts) {
        const d = pctDelta(p, here) * lengthM;
        if (d > -HOLD_M && d < best) best = d;
      }
      const k = best > RANGE_M ? 0 : Math.min(1, (RANGE_M - Math.max(0, best)) / RANGE_M);
      fill.style.width = `${k * 100}%`;
      bar.classList.toggle("now", best <= 0);
    },
  };
}
