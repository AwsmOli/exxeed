// Race panels — the field around the car. Everything here comes off the race
// channel, which only the live sim fills: a replay is the driver's own car and
// nothing else, so these say so rather than sit blank.

import { $, alpha, classColour, clock, COLORS, licenceColour, fit, html, irating, lapTime, roundRect, setText } from "./util.js";

const NO_RACE = (s) =>
  s.status?.phase === "running" ? "live sim only — this source has no other cars" : "waiting for the sim";

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const gap = (v) => (v === null || v === undefined ? "" : `+${Math.max(0, v).toFixed(1)}`);

/** The class colour, bleeding in from the left behind the position. */
const posCell = (pos, colour) =>
  `<span class="pos" style="background:linear-gradient(90deg, ${alpha(colour, 0.7)}, ${alpha(colour, 0)})">${pos || ""}</span>`;

/** Licence and iRating in one chip; either half can be switched off (panel-options.ts). */
const irChip = (lic, simColour, ir, hidden) => {
  const colour = licenceColour(lic, simColour);
  const licence = hidden.has("license") ? "" : `<i style="background:${colour}"></i>${esc(lic.split(" ")[0] ?? "")}`;
  const rating = hidden.has("irating") ? "" : irating(ir);
  return `<span class="irk" style="--lic:${colour}">${[licence, rating].filter(Boolean).join(" ")}</span>`;
};

/** A grid's column widths, leaving out the ones switched off. */
const columns = (...cols) => cols.filter(Boolean).join(" ");

/** Rebuild at human speed, and only when something arrived. */
function throttled(ms, fn) {
  let at = -Infinity;
  let seen = -1;
  return (s) => {
    const now = performance.now();
    if (s.v.race === seen || now - at < ms) return;
    at = now;
    seen = s.v.race;
    fn(s);
  };
}

function lapsLine(race) {
  return race.lapsTotal !== null ? `Lap ${race.lap}/${race.lapsTotal}` : `Lap ${race.lap}`;
}

function sessionLetter(race) {
  return (race.sessionType || "").charAt(0).toUpperCase() || "—";
}

// ---------------------------------------------------------------------------
// Standings: the field by class, fastest class first, each class its own
// card under its own header.
// ---------------------------------------------------------------------------

/** Past this many rows a class is condensed to its top and the player's neighbourhood. */
const MAX_ROWS = 8;

function condense(rows) {
  if (rows.length <= MAX_ROWS) return rows;
  const me = rows.findIndex((r) => r.isPlayer);
  const keep = new Set([0, 1, 2]);
  if (me >= 0) for (let i = me - 2; i <= me + 2; i++) if (i >= 0 && i < rows.length) keep.add(i);
  for (let i = 3; keep.size < MAX_ROWS && i < rows.length; i++) keep.add(i);
  return rows.filter((_, i) => keep.has(i));
}


export function standings() {
  const el = html(`
    <div class="panel is-empty">
      <div class="titlebar split keep" style="justify-content:flex-start" data-part="header">
        <span class="md" data-k="kind">R</span>
        <span data-k="laps"></span>
        <span class="muted n" style="margin-left:auto" data-k="time"></span>
      </div>
      <div data-k="classes" style="display:flex;flex-direction:column;gap:var(--gap);min-height:0;overflow:hidden"></div>
      <div class="empty" data-k="why"></div>
    </div>`);
  const k = (name) => $(el, `[data-k="${name}"]`);

  const build = throttled(250, (s) => {
    const race = s.race;
    setText(k("kind"), sessionLetter(race));
    setText(k("laps"), lapsLine(race));
    setText(k("time"), race.timeRemainS !== null ? clock(race.timeRemainS) : "");

    // Columns the driver switched off are left out of the grid, not just blanked.
    const off = s.options.hidden;
    const chip = !off.has("license") || !off.has("irating");
    // Lap-time columns wide enough for "1:57.870" in a monospace face too.
    const cols = columns(
      "30px",
      !off.has("number") && "36px",
      "minmax(70px,1fr)",
      chip && "64px",
      !off.has("gap") && "46px",
      !off.has("interval") && "40px",
      !off.has("last") && "72px",
      !off.has("best") && "72px",
    );

    k("classes").innerHTML = race.classes
      .map((sim) => {
        const cls = { ...sim, classColor: classColour(race, sim.classColor) };
        const head = `<div class="titlebar class-head" style="justify-content:flex-start;height:26px;--cls:${cls.classColor}">
            <span class="tag outline" style="color:${cls.classColor}">${esc(cls.className || "CLASS")}</span>
            <span class="muted">SoF ${cls.sof ?? "—"}</span>
            <span style="margin-left:auto"></span>
            ${off.has("gap") ? "" : '<span class="cap" style="width:46px;text-align:right">Gap</span>'}
            ${off.has("interval") ? "" : '<span class="cap" style="width:40px;text-align:right">Int</span>'}
            ${off.has("last") ? "" : '<span class="cap" style="width:72px;text-align:right">Last</span>'}
            ${off.has("best") ? "" : '<span class="cap" style="width:72px;text-align:right;margin-right:-4px">Best</span>'}
          </div>`;
        const rows = condense(cls.rows)
          .map(
            (r) => `<div class="row${r.isPlayer ? " me" : ""}${r.onPitRoad ? " pit" : ""}" style="grid-template-columns:${cols};--cls:${cls.classColor}">
              ${posCell(r.classPosition, cls.classColor)}
              ${off.has("number") ? "" : `<span class="num">#${esc(r.carNumber)}</span>`}
              <span class="who">${esc(r.name)}${r.onPitRoad ? ' <span class="tag">PIT</span>' : ""}</span>
              ${chip ? irChip(r.license, r.licenseColor, r.iRating, off) : ""}
              ${off.has("gap") ? "" : `<span class="r n">${r.gapS === null ? "" : gap(r.gapS)}</span>`}
              ${off.has("interval") ? "" : `<span class="r n muted">${r.intervalS === null ? "" : gap(r.intervalS)}</span>`}
              ${off.has("last") ? "" : `<span class="r n">${lapTime(r.lastLapS)}</span>`}
              ${off.has("best") ? "" : `<span class="r n ${r.fastest ? "fast" : "muted"}">${lapTime(r.bestLapS)}</span>`}
            </div>`,
          )
          .join("");
        return `${head}<div class="card rows" style="padding:0">${rows}</div>`;
      })
      .join("");
  });

  return {
    el,
    draw(s) {
      el.classList.toggle("is-empty", s.race === null);
      if (s.race === null) {
        setText(k("why"), NO_RACE(s));
        return;
      }
      build(s);
    },
  };
}

// ---------------------------------------------------------------------------
// Relatives: who is around you on the road, by time, between a header of the
// session's conditions and a footer of where the race is.
// ---------------------------------------------------------------------------


export function relative() {
  const el = html(`
    <div class="panel is-empty">
      <div class="titlebar keep" style="justify-content:space-around" data-part="header">
        <span class="n" data-k="air"></span><span class="n" data-k="track"></span>
        <span data-k="sof"></span><span data-k="bb"></span>
        <span data-k="inc"></span><span class="n" data-k="clock"></span>
      </div>
      <div class="card rows grow" style="padding:0" data-k="rows"></div>
      <div class="titlebar split" data-part="footer">
        <span style="font-weight:700" data-k="laps"></span><span class="n" data-k="remain"></span>
      </div>
      <div class="empty" data-k="why"></div>
    </div>`);
  const k = (name) => $(el, `[data-k="${name}"]`);

  const build = throttled(200, (s) => {
    const race = s.race;
    const w = race.weather;
    setText(k("air"), `${w.airC.toFixed(0)}°C`);
    setText(k("track"), `${w.trackC.toFixed(0)}°C`);
    const mine = race.classes.find((c) => c.rows.some((r) => r.isPlayer));
    setText(k("sof"), mine?.sof ? `SoF ${mine.sof}` : "");
    setText(k("bb"), race.brakeBiasPct === null ? "" : `BB ${race.brakeBiasPct.toFixed(1)}%`);
    setText(k("inc"), `✕ ${race.incidents}x`);
    setText(k("clock"), new Date().toTimeString().slice(0, 5));
    setText(k("laps"), lapsLine(race));
    setText(k("remain"), race.timeRemainS !== null ? clock(race.timeRemainS) : "");

    const off = s.options.hidden;
    const chip = !off.has("license") || !off.has("irating");
    const cols = columns(
      "34px",
      !off.has("number") && "40px",
      "minmax(70px,1fr)",
      !off.has("lap") && "38px",
      chip && "56px",
      "42px",
    );

    k("rows").innerHTML = race.relatives
      .map((r) => {
        // Lapping you reads red, being lapped reads blue — the convention on
        // every relative, because it says who you should not be fighting.
        const tone = r.lapState > 0 ? `color:${COLORS.lapAhead}` : r.lapState < 0 ? `color:${COLORS.lapBehind}` : "";
        const colour = classColour(race, r.classColor);
        return `<div class="row${r.isPlayer ? " me" : ""}${r.onPitRoad ? " pit" : ""}" style="grid-template-columns:${cols};height:30px;font-size:14px;--cls:${colour};${tone}">
          ${posCell(r.position, colour)}
          ${off.has("number") ? "" : `<span class="num">#${esc(r.carNumber)}</span>`}
          <span class="who">${esc(r.name)}</span>
          ${off.has("lap") ? "" : `<span class="tag lap">L${r.lap}</span>`}
          ${chip ? irChip(r.license, r.licenseColor, r.iRating, off) : ""}
          <span class="r n" style="font-weight:600">${r.isPlayer ? "0.0" : Math.abs(r.gapS).toFixed(1)}</span>
        </div>`;
      })
      .join("");
  });

  return {
    el,
    draw(s) {
      el.classList.toggle("is-empty", s.race === null);
      if (s.race === null) {
        setText(k("why"), NO_RACE(s));
        return;
      }
      build(s);
    },
  };
}

// ---------------------------------------------------------------------------
// Radar: cars within a few lengths, ahead and behind, each with a wedge of
// warning pointing at it, and pushed to the side the spotter is calling.
//
// The sim gives distance along the road for every car but lateral position
// for none — only the spotter's "car left / car right". So a car is drawn at
// its true distance ahead or behind, and pushed to a side only when the
// spotter says one is there. That is the honest version of a radar on this
// SDK; anything more precise would be made up.
// ---------------------------------------------------------------------------

const RADAR_RANGE_M = 20;
const CAR_LEN_M = 4.6;
const CAR_W_M = 2;

export function radar() {
  const el = html(`<div class="panel"><canvas class="fill"></canvas></div>`);
  const canvas = $(el, "canvas");

  return {
    el,
    draw(s) {
      const c = fit(canvas);
      if (c === null) return;
      const { ctx, w, h, r } = c;
      ctx.clearRect(0, 0, w, h);

      const cx = w / 2;
      const cy = h / 2;
      const R = Math.min(w, h) / 2 - 2 * r;
      const m = (R * 0.85) / RADAR_RANGE_M;

      const spotter = s.race?.radar.spotter ?? "off";
      const left = spotter === "left" || spotter === "twoLeft" || spotter === "both";
      const right = spotter === "right" || spotter === "twoRight" || spotter === "both";

      // Place the cars first: the wedges point at them.
      let usedLeft = false;
      const cars = (s.race?.radar.nearby ?? []).map((car) => {
        let x = cx;
        const alongside = Math.abs(car.aheadM) < CAR_LEN_M * 1.2;
        if (alongside && left && !usedLeft) {
          x = cx - CAR_W_M * m * 1.5;
          usedLeft = true;
        } else if (alongside && right) {
          x = cx + CAR_W_M * m * 1.5;
        }
        return { x, y: cy - car.aheadM * m, alongside };
      });

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.clip();

      const disc = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R);
      disc.addColorStop(0, "rgba(60,64,70,0.55)");
      disc.addColorStop(0.7, "rgba(25,27,30,0.75)");
      disc.addColorStop(1, "rgba(10,11,12,0.85)");
      ctx.fillStyle = disc;
      ctx.fillRect(0, 0, w, h);

      // A wedge per car, fading outwards through the theme's warning colours:
      // orange into red for a car nearby, the strongest warning into red and
      // orange when it is alongside.
      for (const car of cars) {
        const a = Math.atan2(car.y - cy, car.x - cx);
        const spread = car.alongside ? 0.55 : 0.38;
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
        if (car.alongside) {
          g.addColorStop(0, alpha(COLORS.danger, 0.62));
          g.addColorStop(0.45, alpha(COLORS.red, 0.4));
          g.addColorStop(1, alpha(COLORS.orange, 0.06));
        } else {
          g.addColorStop(0, alpha(COLORS.orange, 0.45));
          g.addColorStop(0.55, alpha(COLORS.red, 0.2));
          g.addColorStop(1, alpha(COLORS.red, 0.03));
        }
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, R, a - spread, a + spread);
        ctx.closePath();
        ctx.fill();
      }

      // The range rings. In a theme that glows they take its colours.
      const neon = COLORS.glow > 6;
      ctx.strokeStyle = neon ? alpha(COLORS.red, 0.75) : alpha(COLORS.ink, 0.55);
      ctx.lineWidth = 1 * r;
      if (neon) {
        ctx.shadowColor = COLORS.red;
        ctx.shadowBlur = 8 * r;
      }
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = neon ? alpha(COLORS.orange, 0.5) : alpha(COLORS.ink, 0.12);
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.25, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      if (neon) {
        // The rim as a sweep from one warning colour to the next.
        const rim = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
        rim.addColorStop(0, COLORS.red);
        rim.addColorStop(0.5, COLORS.orange);
        rim.addColorStop(1, COLORS.danger);
        ctx.strokeStyle = rim;
        ctx.lineWidth = 1.6 * r;
      } else {
        ctx.strokeStyle = alpha(COLORS.ink, 0.18);
        ctx.lineWidth = 1 * r;
      }
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.stroke();

      const drawCar = (x, y) => {
        const cw = CAR_W_M * m;
        const ch = CAR_LEN_M * m;
        roundRect(ctx, x - cw / 2, y - ch / 2, cw, ch, 4 * r);
        ctx.fillStyle = "#ffffff";
        ctx.shadowColor = "rgba(0,0,0,0.5)";
        ctx.shadowBlur = 4 * r;
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = "rgba(0,0,0,0.6)";
        ctx.lineWidth = 1 * r;
        ctx.stroke();
        // Which way it is pointing.
        ctx.fillStyle = "#555a60";
        ctx.beginPath();
        ctx.moveTo(x, y - ch / 2 + 3 * r);
        ctx.lineTo(x + cw * 0.28, y - ch / 2 + 3 * r + cw * 0.3);
        ctx.lineTo(x - cw * 0.28, y - ch / 2 + 3 * r + cw * 0.3);
        ctx.closePath();
        ctx.fill();
      };
      for (const car of cars) drawCar(car.x, car.y);
      drawCar(cx, cy);
    },
  };
}
