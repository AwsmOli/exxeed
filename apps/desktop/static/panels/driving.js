// Driving panels — the car's own inputs, and those inputs against the
// reference lap (§7.1).
//
// Every canvas here is drawn from the rAF loop and nothing else (§7.0): the
// state frame is stashed as it arrives and read at paint time.

import { gearbox, wheel } from "./icons.js";
import { $, alpha, areaLine, COLORS, deltaClass, fit, html, kph, pctDelta, sample, setText, signed, wrap01 } from "./util.js";

const gearText = (g) => (g === -1 ? "R" : g === 0 ? "N" : typeof g === "number" ? String(g) : "–");
const pctText = (v) => String(Math.round((v ?? 0) * 100)).padStart(2, "0");
const font = () => getComputedStyle(document.body).fontFamily;

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
  ctx.strokeStyle = "rgba(255,255,255,0.05)";
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
  areaLine(ctx, pts.map((p) => [x(p.t), y(p.throttle)]), top, bottom, COLORS.mint, 0.3, 2.2 * r);
  areaLine(ctx, pts.map((p) => [x(p.t), y(p.brake)]), top, bottom, COLORS.red, 0.3, 2.2 * r);
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
          <div class="graph"><canvas class="fill"></canvas></div>
          <div class="pedals">
            ${pedal("clutch", COLORS.blue, false)}
            ${pedal("brake", COLORS.red, false)}
            ${pedal("throttle", COLORS.mint, false)}
          </div>
          <div class="sep"></div>
          <div class="speedo" style="align-items:center">
            <div class="line"><span class="lg n" data-k="speed">0</span><span class="u">KM/H</span></div>
            <div class="line good"><span class="xl n" data-k="gear" style="font-weight:600">N</span>${gearbox()}</div>
          </div>
          <div class="wheel" data-k="wheel">${wheel(44)}</div>
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

/** Outer to inner: the colour a shift light takes as the revs climb. */
const SHIFT_COLOURS = ["#2ee88f", "#5de85a", "#9fe24a", "#d9e33a", "#f2d23a", "#ffae2e", "#ff7a26", "#ff4a22"];

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
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.beginPath();
  ctx.arc(cx, cy, R - ring / 2, 0, Math.PI * 2);
  ctx.stroke();

  // How far the wheel is turned, as an arc from the top.
  const a = (wheelDeg(f) * Math.PI) / 180;
  if (Math.abs(a) > 0.01) {
    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    ctx.beginPath();
    ctx.arc(cx, cy, R - ring / 2, -Math.PI / 2, -Math.PI / 2 + a, a < 0);
    ctx.stroke();
  }
  // The tick at the wheel's top-dead-centre.
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(a);
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 2 * r;
  ctx.beginPath();
  ctx.moveTo(0, -R);
  ctx.lineTo(0, -R + ring + 2 * r);
  ctx.stroke();
  ctx.restore();
}

export function pedals() {
  const el = html(`
    <div class="panel tab-wrap">
      <div class="tab n" data-k="delta">—</div>
      <div class="card grow">
        <div class="shift">${"<i></i>".repeat(16)}</div>
        <div class="inputs-body">
          <div class="graph"><canvas class="fill" data-k="graph"></canvas></div>
          <div class="pedals">
            ${pedal("brake", "linear-gradient(0deg,#ff3c22,#ff6a4a)", true)}
            ${pedal("throttle", "linear-gradient(0deg,#2ee88f,#6af0ae)", true)}
          </div>
          <div class="speedo">
            <div class="line good"><span class="xl n" data-k="speed">0</span><span class="u">km/h</span>
              <span class="gear good">${gearbox()}<span class="xl n" data-k="gear">N</span></span></div>
            <div class="line ref"><span class="xl n" data-k="rspeed">—</span><span class="u">km/h</span>
              <span class="gear">${gearbox()}<span class="xl n" data-k="rgear">–</span></span></div>
            <div class="ffb">FF<div class="pill-h"><i data-k="ffb" style="background:rgba(255,255,255,0.75)"></i></div></div>
          </div>
          <div class="wheel" style="position:relative;width:64px;height:64px">
            <canvas class="fill" data-k="dial"></canvas>
            <div data-k="wheel" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">${wheel(30)}</div>
          </div>
        </div>
      </div>
    </div>`);
  const k = (name) => $(el, `[data-k="${name}"]`);
  const lights = [...el.querySelectorAll(".shift i")];
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

      // Shift lights, from both ends inwards.
      const sl = s.race?.shiftLights ?? null;
      const rpm = f?.rpm ?? null;
      let lit = 0;
      let blink = false;
      if (sl !== null && rpm !== null && sl.shiftRpm > sl.firstRpm) {
        lit = Math.max(0, Math.min(8, Math.ceil(((rpm - sl.firstRpm) / (sl.shiftRpm - sl.firstRpm)) * 8)));
        blink = rpm >= sl.blinkRpm && Math.floor(performance.now() / 90) % 2 === 0;
      }
      lights.forEach((light, i) => {
        const j = i < 8 ? i : 15 - i;
        const on = blink || j < lit;
        light.style.background = on ? (blink ? "#ff3c22" : SHIFT_COLOURS[j]) : "";
        light.style.boxShadow = on ? `0 0 6px ${alpha(blink ? "#ff3c22" : SHIFT_COLOURS[j], 0.6)}` : "";
      });

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
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.textBaseline = "top";
  ctx.fillText(title, (GUTTER + 4) * r, 4 * r);

  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.textAlign = "right";
  for (const [label, y] of yLabels) {
    ctx.textBaseline = "middle";
    ctx.fillText(label, (GUTTER - 5) * r, y);
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
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
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
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

      ctx.strokeStyle = "rgba(255,159,28,0.8)";
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
      areaLine(ctx, thr.ahead, top, bottom, alpha(COLORS.mint, 0.45), 0.14, 1.4 * r);
      areaLine(ctx, brk.ahead, top, bottom, alpha(COLORS.red, 0.5), 0.16, 1.4 * r);
      areaLine(ctx, thr.behind, top, bottom, "rgba(255,255,255,0.28)", 0, 1 * r);
      areaLine(ctx, brk.behind, top, bottom, "rgba(255,255,255,0.28)", 0, 1 * r);
      areaLine(ctx, livePoints(s.history, here, x, (p) => p.throttle, y), top, bottom, COLORS.mint, 0.3, 2.2 * r);
      areaLine(ctx, livePoints(s.history, here, x, (p) => p.brake, y), top, bottom, COLORS.red, 0.32, 2.2 * r);

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
      areaLine(ctx, refPts.behind, top, bottom, "rgba(255,255,255,0.28)", 0, 1 * r);
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
