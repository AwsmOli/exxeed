// Timing panels — how the lap is going against the reference (§7.2).
//
// The delta itself is computed in main (core's deltaSeconds); these panels
// only slice it. Sector and corner splits are the delta sampled at a boundary
// and subtracted, which is exact on the pct grid (§4.3) and needs no timing of
// its own.

import { $, COLORS, deltaClass, deltaTrend, fit, html, kph, lapTime, pctDelta, sample, setText, signed } from "./util.js";

/** Did the car cross `boundary` between `from` and `to`? Forwards only. */
const crossed = (from, to, boundary) =>
  pctDelta(to, boundary) >= 0 && pctDelta(from, boundary) < 0 && pctDelta(to, from) < 0.1;

/** "0:11.113" — sector times always carry the minute, as a timing screen does. */
const sectorTime = (s) => {
  if (typeof s !== "number" || !(s > 0)) return "—";
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(3).padStart(6, "0")}`;
};

// ---------------------------------------------------------------------------
// Delta bar (§7.2): a long pill filling from the centre, and the number in
// its own small card underneath. ±1 s fills a side.
// ---------------------------------------------------------------------------

const DELTA_FULL_S = 1;

export function delta() {
  const el = html(`
    <div class="panel is-empty" style="justify-content:flex-start">
      <div class="delta-track"><i data-k="fill"></i></div>
      <div class="delta-readout n" data-k="v" data-part="number">0.00</div>
      <div class="delta-dial">
        <canvas class="fill" data-k="dial"></canvas>
        <div class="delta-dial-mid" data-part="number"><span class="cap">Delta</span><b class="n" data-k="dv">0.00</b></div>
      </div>
      <div class="empty">no delta yet — waiting for a timed lap against a reference</div>
    </div>`);
  const value = $(el, '[data-k="v"]');
  const fill = $(el, '[data-k="fill"]');
  const dial = $(el, '[data-k="dial"]');
  const dialValue = $(el, '[data-k="dv"]');
  const trend = deltaTrend();

  return {
    el,
    draw(s) {
      const d = s.frame?.deltaS;
      el.classList.toggle("is-empty", typeof d !== "number");
      if (typeof d !== "number") return;

      const k = Math.min(1, Math.abs(d) / DELTA_FULL_S) * 50;
      // Which side and how far say where you are; the colour says which way
      // it is going (util.js deltaTrend).
      const colour = trend(d);
      // Ahead of the reference fills to the right, behind to the left, as the
      // sim's own bar does.
      const ahead = d < 0;
      fill.style.left = ahead ? "50%" : `${50 - k}%`;
      fill.style.width = `${k}%`;
      // Rounded on the outer end only, so the bar reads as growing out of the line.
      fill.style.borderRadius = ahead ? "0 99px 99px 0" : "99px 0 0 99px";
      fill.style.background = colour;
      // The number says where you are: green ahead, red behind. Only the bar
      // carries the trend.
      setText(value, signed(d));
      value.className = `delta-readout n ${deltaClass(d)}`;

      // The dial style: a ring that fills clockwise when ahead and
      // anticlockwise when behind, with the number in the middle.
      if (s.options.style !== "dial") return;
      setText(dialValue, signed(d, 3));
      dialValue.className = `n ${deltaClass(d)}`;
      const c = fit(dial);
      if (c === null) return;
      const { ctx, w, h, r } = c;
      ctx.clearRect(0, 0, w, h);
      const R = Math.min(w, h) / 2 - 7 * r;
      const top = -Math.PI / 2;
      ctx.lineCap = "round";
      ctx.lineWidth = 5 * r;
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, R, 0, Math.PI * 2);
      ctx.stroke();
      const sweep = Math.min(1, Math.abs(d) / DELTA_FULL_S) * Math.PI * 1.9;
      ctx.strokeStyle = colour;
      ctx.shadowColor = colour;
      ctx.shadowBlur = COLORS.glow * 1.5 * r;
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, R, top, ahead ? top + sweep : top - sweep, !ahead);
      ctx.stroke();
      ctx.shadowBlur = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Delta sectors: each sector's time and what it gained or lost, the one in
// progress highlighted, then best, last and reference laps in their own card.
// ---------------------------------------------------------------------------

const DEFAULT_SECTORS = [0, 1 / 3, 2 / 3];

export function sectors() {
  const el = html(`
    <div class="panel is-empty">
      <div class="card grow keep" style="padding:0">
        <div class="spread" style="padding:7px 12px"><span class="md">Delta</span><span class="muted">vs Ref</span></div>
        <div data-k="sectors"></div>
      </div>
      <div class="card" data-part="laps">
        <div class="laps3">
          <span class="cap">Best</span><span class="cap">Last</span><span class="cap">Ref</span>
          <span class="t n" data-k="best">—</span><span class="t n" data-k="last">—</span><span class="t n" data-k="ref">—</span>
          <span class="d n" data-k="bestd"></span><span class="d n" data-k="lastd"></span><span class="d faint">REF</span>
        </div>
      </div>
      <div class="empty">needs a reference lap and one crossing of the line</div>
    </div>`);
  const k = (name) => $(el, `[data-k="${name}"]`);

  let starts = DEFAULT_SECTORS;
  let current = [];
  let previous = [];
  let open = null;
  let prev = null;
  let lastLapS = null;
  let bestLapS = null;
  let built = -Infinity;

  const rebuild = (s) => {
    const rows = starts.map((_, i) => {
      const done = current[i] ?? previous[i] ?? null;
      const live = open !== null && open.idx === i && current[i] === undefined && typeof s.frame?.deltaS === "number";
      const d = live ? s.frame.deltaS - open.startDelta : done?.delta ?? null;
      const tone = deltaClass(d);
      return `<div class="sector${live ? " live" : ""}">
        <span class="name ${tone}">S${i + 1}</span>
        <span class="t n">${live ? "" : sectorTime(done?.time)}</span>
        <span class="d n ${tone}">${d === null ? "" : signed(d, 3)}</span>
      </div>`;
    });
    k("sectors").innerHTML = rows.join("");

    const refS = s.reference?.lapTimeS ?? null;
    const best = s.race?.bestLapS ?? bestLapS;
    const last = s.race?.lastLapS ?? lastLapS;
    setText(k("best"), lapTime(best));
    setText(k("last"), lapTime(last));
    setText(k("ref"), lapTime(refS));
    for (const [key, v] of [["bestd", best], ["lastd", last]]) {
      const d = v !== null && refS !== null ? v - refS : null;
      setText(k(key), d === null ? "" : signed(d, 3));
      k(key).className = `d n ${deltaClass(d)}`;
    }
  };

  return {
    el,
    frame(s) {
      const f = s.frame;
      if (s.race?.sectorStartPcts?.length > 1) starts = s.race.sectorStartPcts;
      if (prev !== null && typeof f.lapElapsedS === "number" && typeof prev.lapElapsedS === "number") {
        // The lap clock going backwards is the line. What it read just before
        // is the lap just finished.
        if (f.lapElapsedS < prev.lapElapsedS - 1) {
          lastLapS = prev.lapElapsedS;
          bestLapS = bestLapS === null ? lastLapS : Math.min(bestLapS, lastLapS);
        }
        starts.forEach((b, i) => {
          if (!crossed(prev.lapDistPct, f.lapDistPct, b)) return;
          const atLine = i === 0;
          const endElapsed = atLine ? prev.lapElapsedS : f.lapElapsedS;
          const endDelta = atLine ? prev.deltaS : f.deltaS;
          if (open !== null && open.idx === (i - 1 + starts.length) % starts.length && typeof endDelta === "number") {
            current[open.idx] = { time: endElapsed - open.startElapsed, delta: endDelta - open.startDelta };
          }
          if (atLine) {
            previous = current;
            current = [];
          }
          open =
            typeof f.deltaS === "number"
              ? { idx: i, startElapsed: atLine ? 0 : f.lapElapsedS, startDelta: atLine ? 0 : f.deltaS }
              : null;
        });
      }
      prev = f;
    },
    draw(s) {
      el.classList.toggle("is-empty", s.reference === null);
      const now = performance.now();
      if (now - built < 150) return;
      built = now;
      rebuild(s);
    },
  };
}

// ---------------------------------------------------------------------------
// Corner analysis: the last corner — what it cost or gained, the apex speed
// against the reference's, and your speed through it over the reference's.
// ---------------------------------------------------------------------------

export function corners() {
  const el = html(`
    <div class="panel is-empty">
      <div class="titlebar keep">Corner Analysis</div>
      <div class="card grow">
        <div class="spread" style="align-items:flex-start">
          <span class="lg" data-k="name">Corner —</span>
          <div class="r"><span class="xl n" data-k="delta">—</span><span class="u">s</span>
            <div class="muted" style="font-size:11px;margin-top:3px" data-k="apex"></div></div>
        </div>
        <div style="flex:1;min-height:0;margin-top:6px"><canvas class="fill"></canvas></div>
      </div>
      <div class="empty">needs a reference lap with its corners mapped</div>
    </div>`);
  const k = (name) => $(el, `[data-k="${name}"]`);
  const canvas = $(el, "canvas");

  let open = null;
  let result = null;
  let prev = null;

  return {
    el,
    frame(s) {
      const f = s.frame;
      const ref = s.reference;
      if (ref === null || prev === null || typeof f.deltaS !== "number") {
        prev = f;
        return;
      }
      for (const c of ref.corners) {
        if (crossed(prev.lapDistPct, f.lapDistPct, c.entryPct)) {
          open = { corner: c, startDelta: f.deltaS, mine: [], theirs: [] };
        }
      }
      if (open !== null) {
        open.mine.push(kph(f.speedMps));
        open.theirs.push(kph(sample(ref.speedMps, ref.gridSize, f.lapDistPct)));
        if (crossed(prev.lapDistPct, f.lapDistPct, open.corner.exitPct)) {
          result = {
            index: open.corner.index,
            delta: f.deltaS - open.startDelta,
            apex: Math.min(...open.mine) - Math.min(...open.theirs),
            mine: open.mine,
            theirs: open.theirs,
          };
          open = null;
        }
      }
      prev = f;
    },
    draw(s) {
      el.classList.toggle("is-empty", s.reference === null || s.reference.corners.length === 0);
      if (result === null) {
        setText(k("name"), open === null ? "Corner —" : `Corner ${open.corner.index}`);
        setText(k("apex"), "through the first corner…");
        return;
      }
      setText(k("name"), `Corner ${result.index}`);
      setText(k("delta"), signed(result.delta));
      k("delta").className = `xl n ${deltaClass(result.delta)}`;
      setText(k("apex"), `${result.apex >= 0 ? "+" : "−"}${Math.abs(result.apex).toFixed(0)} km/h apex`);

      const c = fit(canvas);
      if (c === null) return;
      const { ctx, w, h, r } = c;
      ctx.clearRect(0, 0, w, h);
      const all = [...result.mine, ...result.theirs];
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
      stroke(line(result.mine), result.delta <= 0 ? COLORS.green : COLORS.red, 2.4 * r, []);
      stroke(line(result.theirs), "rgba(255,255,255,0.9)", 2 * r, [2 * r, 3 * r]);
    },
  };
}

// ---------------------------------------------------------------------------
// Comparison target: which lap every delta above is measured against. GO Fast
// lets you pick one here; ours follows the car setting in preferences, and
// this says which is loaded — a wrong reference makes every other number on
// screen wrong.
// ---------------------------------------------------------------------------

export function reference() {
  const el = html(`
    <div class="panel">
      <div class="card grow">
        <div class="md" style="font-weight:700">Comparison Target</div>
        <div class="muted" style="margin:2px 0 10px">The lap every delta is measured against.</div>
        <div class="target">
          <span class="tag">REF LAP</span>
          <span class="lg n" style="margin-left:auto;font-weight:600" data-k="time">—</span>
          <span class="md" data-k="car"></span>
        </div>
        <div class="cap" style="margin:10px 0 4px">Note set</div>
        <div class="muted" data-k="notes">—</div>
      </div>
    </div>`);
  const k = (name) => $(el, `[data-k="${name}"]`);

  return {
    el,
    draw(s) {
      const ref = s.reference;
      setText(k("time"), ref === null ? "none" : lapTime(ref.lapTimeS));
      setText(k("car"), ref === null ? "" : ref.carId);
      const st = s.status;
      setText(k("notes"), st?.noteSetId ?? (st?.phase === "running" ? "none for this track" : "—"));
    },
  };
}
