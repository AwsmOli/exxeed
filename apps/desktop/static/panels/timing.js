// Timing panels — how the lap is going against the reference (§7.2).
//
// The delta itself is computed in main (core's deltaSeconds); these panels
// only slice it. Sector and corner splits are the delta sampled at a boundary
// and subtracted, which is exact on the pct grid (§4.3) and needs no timing of
// its own.

import { canvasIn, numberAttr, registerBlock } from "./blocks.js";
import { templated } from "./templated.js";
import { alpha, COLORS, deltaTint, deltaTrend, fit, kph, liveTone, pctDelta, sample } from "./util.js";

/** Gaining is good, losing is bad; under 5 ms is neither. */
const tone = (d) => ({
  good: typeof d === "number" && d <= -0.005,
  bad: typeof d === "number" && d >= 0.005,
});

/** Did the car cross `boundary` between `from` and `to`? Forwards only. */
const crossed = (from, to, boundary) =>
  pctDelta(to, boundary) >= 0 && pctDelta(from, boundary) < 0 && pctDelta(to, from) < 0.1;

// ---------------------------------------------------------------------------
// Delta bar (§7.2): a long pill filling from the centre, and the number in
// its own small card underneath. ±1 s fills a side.
// ---------------------------------------------------------------------------

const DELTA_FULL_S = 1;

function deltaModel(s, local) {
  const d = s.frame?.deltaS;
  if (typeof d !== "number") return { empty: true, deltaS: null, good: false, bad: false };
  const k = Math.min(1, Math.abs(d) / DELTA_FULL_S) * 50;
  // Ahead of the reference fills to the right, behind to the left, as the
  // sim's own bar does. Which side and how far say where you are; the colour
  // says which way it is going (util.js deltaTrend).
  const ahead = d < 0;
  const refS = s.reference?.lapTimeS ?? null;
  return {
    empty: false,
    deltaS: d,
    ...liveTone(d),
    /** The number's colour: white near ±0, fading to green or red with the size of the gap. */
    tint: deltaTint(d),
    ahead,
    /** The laps beside a delta: the reference, the lap this one is heading for, best and last. */
    refLapS: refS,
    predictedLapS: refS === null ? null : refS + d,
    bestLapS: s.race?.bestLapS ?? null,
    lastLapS: s.race?.lastLapS ?? null,
    colour: local.trend(d),
    fillLeft: (ahead ? 50 : 50 - k).toFixed(2),
    fillWidth: k.toFixed(2),
    // Rounded on the outer end only, so the bar reads as growing out of the line.
    fillRadius: ahead ? "0 99px 99px 0" : "99px 0 0 99px",
    /** 0–1: how much of a side the bar fills. */
    fraction: k / 50,
  };
}

/**
 * The dial style: a ring that fills clockwise when ahead and anticlockwise
 * when behind, in the delta's trend colour.
 */
function drawDeltaDial(canvas, data, look = {}) {
  if (data === null || data.deltaS === null) return;
  const c = fit(canvas);
  if (c === null) return;
  const { ctx, w, h, r } = c;
  ctx.clearRect(0, 0, w, h);
  const R = Math.min(w, h) / 2 - 7 * r;
  const top = -Math.PI / 2;
  ctx.lineCap = "round";
  ctx.lineWidth = (look.ring ?? 5) * r;
  ctx.strokeStyle = alpha(COLORS.ink, 0.12);
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, R, 0, Math.PI * 2);
  ctx.stroke();
  const sweep = data.fraction * Math.PI * 1.9;
  ctx.strokeStyle = data.colour;
  ctx.shadowColor = data.colour;
  ctx.shadowBlur = (look.glow ?? COLORS.glow * 1.5) * r;
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, R, top, data.ahead ? top + sweep : top - sweep, !data.ahead);
  ctx.stroke();
  ctx.shadowBlur = 0;
}

registerBlock(
  "x-delta-dial",
  {
    summary: "The delta as a ring filling clockwise when ahead, anticlockwise when behind. Needs the Delta model.",
    attributes: { glow: "pixels of glow round the ring", ring: "the ring's thickness in pixels; 5 by default" },
  },
  (el) => ({
    paint(s, data) {
      // Hidden unless the dial style is chosen: no drawing for nothing.
      if (el.offsetParent === null) return;
      drawDeltaDial(canvasIn(el), data, {
        ...(el.hasAttribute("glow") ? { glow: numberAttr(el, "glow", 0) } : {}),
        ...(el.hasAttribute("ring") ? { ring: numberAttr(el, "ring", 5) } : {}),
      });
    },
  }),
);

const DELTA = `
<div class="panel delta" data-class="is-empty: empty">
  <div class="delta-track"><i style="left:{{ fillLeft }}%;width:{{ fillWidth }}%;border-radius:{{ fillRadius }};background:{{ colour }}"></i></div>
  <div class="delta-readout n" data-part="number" style="color:{{ tint }}">{{ deltaS | signed:2 }}</div>
  <div class="delta-dial">
    <x-delta-dial></x-delta-dial>
    <div class="delta-dial-mid" data-part="number"><span class="cap">Delta</span><b class="n" style="color:{{ tint }}">{{ deltaS | signed:3 }}</b></div>
  </div>
  <div class="empty">no delta yet — waiting for a timed lap against a reference</div>
</div>`;

export const delta = templated({ template: DELTA, model: deltaModel, local: () => ({ trend: deltaTrend() }) });

// ---------------------------------------------------------------------------
// Delta sectors: each sector's time and what it gained or lost, the one in
// progress highlighted, then best, last and reference laps in their own card.
// ---------------------------------------------------------------------------

const DEFAULT_SECTORS = [0, 1 / 3, 2 / 3];

function sectorsLocal() {
  return { starts: DEFAULT_SECTORS, current: [], previous: [], open: null, prev: null, lastLapS: null, bestLapS: null };
}

/** Every frame: close a sector at each boundary crossed, and a lap at the line. */
function sectorsFrame(s, m) {
  const f = s.frame;
  if (s.race?.sectorStartPcts?.length > 1) m.starts = s.race.sectorStartPcts;
  const prev = m.prev;
  if (prev !== null && typeof f.lapElapsedS === "number" && typeof prev.lapElapsedS === "number") {
    // The lap clock going backwards is the line. What it read just before
    // is the lap just finished.
    if (f.lapElapsedS < prev.lapElapsedS - 1) {
      m.lastLapS = prev.lapElapsedS;
      m.bestLapS = m.bestLapS === null ? m.lastLapS : Math.min(m.bestLapS, m.lastLapS);
    }
    m.starts.forEach((b, i) => {
      if (!crossed(prev.lapDistPct, f.lapDistPct, b)) return;
      const atLine = i === 0;
      const endElapsed = atLine ? prev.lapElapsedS : f.lapElapsedS;
      const endDelta = atLine ? prev.deltaS : f.deltaS;
      if (m.open !== null && m.open.idx === (i - 1 + m.starts.length) % m.starts.length && typeof endDelta === "number") {
        m.current[m.open.idx] = { time: endElapsed - m.open.startElapsed, delta: endDelta - m.open.startDelta };
      }
      if (atLine) {
        m.previous = m.current;
        m.current = [];
      }
      m.open =
        typeof f.deltaS === "number"
          ? { idx: i, startElapsed: atLine ? 0 : f.lapElapsedS, startDelta: atLine ? 0 : f.deltaS }
          : null;
    });
  }
  m.prev = f;
}

function sectorsModel(s, m) {
  const sectors = m.starts.map((_, i) => {
    const done = m.current[i] ?? m.previous[i] ?? null;
    const live = m.open !== null && m.open.idx === i && m.current[i] === undefined && typeof s.frame?.deltaS === "number";
    const d = live ? s.frame.deltaS - m.open.startDelta : (done?.delta ?? null);
    return { name: `S${i + 1}`, number: i + 1, live, timeS: live ? null : (done?.time ?? null), deltaS: d, ...tone(d) };
  });
  const refS = s.reference?.lapTimeS ?? null;
  const best = s.race?.bestLapS ?? m.bestLapS;
  const last = s.race?.lastLapS ?? m.lastLapS;
  const vsRef = (v) => (v !== null && refS !== null ? v - refS : null);
  return {
    empty: s.reference === null,
    sectors,
    bestLapS: best,
    lastLapS: last,
    refLapS: refS,
    best: { deltaS: vsRef(best), ...tone(vsRef(best)) },
    last: { deltaS: vsRef(last), ...tone(vsRef(last)) },
  };
}

const SECTORS = `
<div class="panel sectors" data-class="is-empty: empty">
  <div class="card grow keep sectors-card">
    <div class="spread sectors-head"><span class="md">Delta</span><span class="muted">vs Ref</span></div>
    <div>
      <div data-each="sectors" class="sector" data-class="live: live">
        <span class="name" data-class="good: good; bad: bad">{{ name }}</span>
        <span class="t n"><x-group data-if="!live">{{ timeS | sectorTime }}</x-group></span>
        <span class="d n" data-class="good: good; bad: bad">{{ deltaS | signed:3 }}</span>
      </div>
    </div>
  </div>
  <div class="card" data-part="laps">
    <div class="laps3">
      <span class="cap">Best</span><span class="cap">Last</span><span class="cap">Ref</span>
      <span class="t n">{{ bestLapS | lapTime }}</span><span class="t n">{{ lastLapS | lapTime }}</span><span class="t n">{{ refLapS | lapTime }}</span>
      <span class="d n" data-class="good: best.good; bad: best.bad">{{ best.deltaS | signed:3 }}</span>
      <span class="d n" data-class="good: last.good; bad: last.bad">{{ last.deltaS | signed:3 }}</span>
      <span class="d faint">REF</span>
    </div>
  </div>
  <div class="empty">needs a reference lap and one crossing of the line</div>
</div>`;

export const sectors = templated({ template: SECTORS, model: sectorsModel, local: sectorsLocal, frame: sectorsFrame, rate: 150 });

// ---------------------------------------------------------------------------
// Corner analysis: the last corner — what it cost or gained, the apex speed
// against the reference's, and your speed through it over the reference's.
// ---------------------------------------------------------------------------

function cornersFrame(s, m) {
  const f = s.frame;
  const ref = s.reference;
  if (ref === null || m.prev === null || typeof f.deltaS !== "number") {
    m.prev = f;
    return;
  }
  for (const c of ref.corners) {
    if (crossed(m.prev.lapDistPct, f.lapDistPct, c.entryPct)) {
      m.open = { corner: c, startDelta: f.deltaS, mine: [], theirs: [] };
    }
  }
  if (m.open !== null) {
    m.open.mine.push(kph(f.speedMps));
    m.open.theirs.push(kph(sample(ref.speedMps, ref.gridSize, f.lapDistPct)));
    if (crossed(m.prev.lapDistPct, f.lapDistPct, m.open.corner.exitPct)) {
      m.result = {
        index: m.open.corner.index,
        delta: f.deltaS - m.open.startDelta,
        apex: Math.min(...m.open.mine) - Math.min(...m.open.theirs),
        mine: m.open.mine,
        theirs: m.open.theirs,
      };
      m.open = null;
    }
  }
  m.prev = f;
}

function cornersModel(s, m) {
  const r = m.result;
  return {
    empty: s.reference === null || s.reference.corners.length === 0,
    /** The corner last driven through, or being driven through before any is done. */
    corner: r?.index ?? m.open?.corner.index ?? null,
    done: r !== null,
    deltaS: r?.delta ?? null,
    ...tone(r?.delta ?? null),
    /** Your minimum speed through it minus the reference's, km/h. */
    apexKph: r?.apex ?? null,
    apexGain: r !== null && r.apex >= 0,
    /** For x-corner-chart: your speeds and the reference's through it. */
    mine: r?.mine ?? [],
    theirs: r?.theirs ?? [],
  };
}

function drawCornerChart(canvas, data) {
  if (data === null || data.mine.length === 0) return;
  const c = fit(canvas);
  if (c === null) return;
  const { ctx, w, h, r } = c;
  ctx.clearRect(0, 0, w, h);
  const all = [...data.mine, ...data.theirs];
  const lo = Math.min(...all) - 3;
  const hi = Math.max(...all) + 3;
  const pad = 8 * r;
  const line = (vals) =>
    vals.map((v, i) => [pad + (i / Math.max(1, vals.length - 1)) * (w - pad * 2), h - pad - ((v - lo) / (hi - lo)) * (h - pad * 2)]);
  const stroke = (pts, style, width, dash) => {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    ctx.setLineDash(dash);
    ctx.lineCap = "round";
    ctx.stroke();
    ctx.setLineDash([]);
  };
  stroke(line(data.mine), data.deltaS <= 0 ? COLORS.green : COLORS.red, 2.4 * r, []);
  stroke(line(data.theirs), alpha(COLORS.ink, 0.9), 2 * r, [2 * r, 3 * r]);
}

registerBlock(
  "x-corner-chart",
  { summary: "Your speed through the last corner over the reference's (dashed). Needs the Corners model.", attributes: {} },
  (el) => ({ paint: (s, data) => drawCornerChart(canvasIn(el), data) }),
);

const CORNERS = `
<div class="panel corners" data-class="is-empty: empty">
  <div class="titlebar keep">Corner Analysis</div>
  <div class="card grow">
    <div class="spread corner-head">
      <span class="lg">Corner {{ corner | or:— }}</span>
      <div class="r"><span class="xl n" data-class="good: good; bad: bad">{{ deltaS | signed:2 | or:— }}</span><span class="u">s</span>
        <div class="muted apex"><x-group data-if="done">{{ apexKph | signed:0 }} km/h apex</x-group><x-group data-if="!done">through the first corner…</x-group></div></div>
    </div>
    <div class="corner-chart"><x-corner-chart></x-corner-chart></div>
  </div>
  <div class="empty">needs a reference lap with its corners mapped</div>
</div>`;

export const corners = templated({
  template: CORNERS,
  model: cornersModel,
  local: () => ({ open: null, result: null, prev: null }),
  frame: cornersFrame,
});

// ---------------------------------------------------------------------------
// Comparison target: which lap every delta above is measured against. GO Fast
// lets you pick one here; ours follows the car setting in preferences, and
// this says which is loaded — a wrong reference makes every other number on
// screen wrong.
// ---------------------------------------------------------------------------

function referenceModel(s) {
  const ref = s.reference;
  const st = s.status;
  return {
    hasReference: ref !== null,
    lapTimeS: ref?.lapTimeS ?? null,
    carId: ref?.carId ?? "",
    noteSet: st?.noteSetId ?? (st?.phase === "running" ? "none for this track" : "—"),
  };
}

const REFERENCE = `
<div class="panel reference">
  <div class="card grow">
    <div class="md ref-title">Comparison Target</div>
    <div class="muted ref-sub">The lap every delta is measured against.</div>
    <div class="target">
      <span class="tag">REF LAP</span>
      <span class="lg n ref-time"><x-group data-if="hasReference">{{ lapTimeS | lapTime }}</x-group><x-group data-if="!hasReference">none</x-group></span>
      <span class="md">{{ carId }}</span>
    </div>
    <div class="cap ref-notes-cap">Note set</div>
    <div class="muted">{{ noteSet }}</div>
  </div>
</div>`;

export const reference = templated({ template: REFERENCE, model: referenceModel, rate: 250 });
