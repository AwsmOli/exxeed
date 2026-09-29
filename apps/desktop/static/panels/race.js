// Race panels — the field around the car. Everything here comes off the race
// channel, which only the live sim fills: a replay is the driver's own car and
// nothing else, so these say so rather than sit blank.

import { $, alpha, clock, fit, html, irating, lapTime, roundRect, setText } from "./util.js";

const NO_RACE = (s) =>
  s.status?.phase === "running" ? "live sim only — this source has no other cars" : "waiting for the sim";

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const gap = (v) => (v === null || v === undefined ? "" : `+${Math.max(0, v).toFixed(1)}`);

/** The class colour, bleeding in from the left behind the position. */
const posCell = (pos, colour) =>
  `<span class="pos" style="background:linear-gradient(90deg, ${alpha(colour, 0.7)}, ${alpha(colour, 0)})">${pos || ""}</span>`;

const irChip = (lic, colour, ir) =>
  `<span class="irk"><i style="background:${colour}"></i>${esc(lic.split(" ")[0] ?? "")} ${irating(ir)}</span>`;

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

const STANDINGS_COLS = "30px 36px minmax(70px,1fr) 64px 46px 40px 60px 60px";

export function standings() {
  const el = html(`
    <div class="panel is-empty">
      <div class="titlebar split keep" style="justify-content:flex-start">
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

    k("classes").innerHTML = race.classes
      .map((cls) => {
        const head = `<div class="titlebar" style="justify-content:flex-start;height:26px">
            <span class="tag outline" style="color:${cls.classColor}">${esc(cls.className || "CLASS")}</span>
            <span class="muted">SoF ${cls.sof ?? "—"}</span>
            <span class="cap" style="margin-left:auto;width:46px;text-align:right">Gap</span>
            <span class="cap" style="width:40px;text-align:right">Int</span>
            <span class="cap" style="width:60px;text-align:right">Last</span>
            <span class="cap" style="width:60px;text-align:right;margin-right:-4px">Best</span>
          </div>`;
        const rows = condense(cls.rows)
          .map(
            (r) => `<div class="row${r.isPlayer ? " me" : ""}${r.onPitRoad ? " pit" : ""}" style="grid-template-columns:${STANDINGS_COLS}">
              ${posCell(r.classPosition, cls.classColor)}
              <span class="num">#${esc(r.carNumber)}</span>
              <span>${esc(r.name)}${r.onPitRoad ? ' <span class="tag">PIT</span>' : ""}</span>
              ${irChip(r.license, r.licenseColor, r.iRating)}
              <span class="r n">${r.gapS === null ? "" : gap(r.gapS)}</span>
              <span class="r n muted">${r.intervalS === null ? "" : gap(r.intervalS)}</span>
              <span class="r n">${lapTime(r.lastLapS)}</span>
              <span class="r n ${r.fastest ? "fast" : "muted"}">${lapTime(r.bestLapS)}</span>
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

const RELATIVE_COLS = "34px 40px minmax(70px,1fr) 38px 56px 42px";

export function relative() {
  const el = html(`
    <div class="panel is-empty">
      <div class="titlebar keep" style="justify-content:space-around">
        <span class="n" data-k="air"></span><span class="n" data-k="track"></span>
        <span data-k="sof"></span><span data-k="bb"></span>
        <span data-k="inc"></span><span class="n" data-k="clock"></span>
      </div>
      <div class="card rows grow" style="padding:0" data-k="rows"></div>
      <div class="titlebar split">
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

    k("rows").innerHTML = race.relatives
      .map((r) => {
        // Lapping you reads red, being lapped reads blue — the convention on
        // every relative, because it says who you should not be fighting.
        const tone = r.lapState > 0 ? "color:#ff8a7a" : r.lapState < 0 ? "color:#7ab8ff" : "";
        return `<div class="row${r.isPlayer ? " me" : ""}${r.onPitRoad ? " pit" : ""}" style="grid-template-columns:${RELATIVE_COLS};height:30px;font-size:14px;${tone}">
          ${posCell(r.position, r.classColor)}
          <span class="num">#${esc(r.carNumber)}</span>
          <span>${esc(r.name)}</span>
          <span class="tag">L${r.lap}</span>
          ${irChip(r.license, r.licenseColor, r.iRating)}
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

      // A wedge per car, amber, red when it is alongside.
      for (const car of cars) {
        const a = Math.atan2(car.y - cy, car.x - cx);
        const spread = car.alongside ? 0.55 : 0.38;
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
        const hue = car.alongside ? "255,70,40" : "255,200,60";
        g.addColorStop(0, `rgba(${hue},0.45)`);
        g.addColorStop(1, `rgba(${hue},0.05)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, R, a - spread, a + spread);
        ctx.closePath();
        ctx.fill();
      }

      ctx.strokeStyle = "rgba(255,255,255,0.55)";
      ctx.lineWidth = 1 * r;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.25, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      ctx.strokeStyle = "rgba(255,255,255,0.18)";
      ctx.lineWidth = 1 * r;
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
