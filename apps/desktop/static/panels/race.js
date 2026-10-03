// Race panels — the field around the car. Everything here comes off the race
// channel, which only the live sim fills: a replay is the driver's own car and
// nothing else, so these say so rather than sit blank.

import { canvasIn, registerBlock } from "./blocks.js";
import { templated } from "./templated.js";
import { alpha, chevron, classColour, COLORS, licenceColour, fit, playerClassColour, roundRect } from "./util.js";

const NO_RACE = (s) =>
  s.status?.phase === "running" ? "live sim only — this source has no other cars" : "waiting for the sim";

/** A grid's column widths, leaving out the ones switched off. */
const columns = (...cols) => cols.filter(Boolean).join(" ");

function lapsLine(race) {
  return race.lapsTotal !== null ? `Lap ${race.lap}/${race.lapsTotal}` : `Lap ${race.lap}`;
}

function sessionLetter(race) {
  return (race.sessionType || "").charAt(0).toUpperCase() || "—";
}

// ---------------------------------------------------------------------------
// Standings: the field by class, fastest class first, each class its own
// card under its own header.
//
// A model and a template (templated.js): a theme can lay the same rows out
// its own way. What the template can read:
//
//   empty            why there is nothing to show, or null
//   session          "R", "Q", "P"…    lap, lapsTotal, lapsLine, timeRemainS
//   show.*           number, license, irating, chip, gap, interval, last, best:
//                    the columns the driver has on (panel options)
//   cols             grid-template-columns for those columns
//   player           your row (below), or null
//   playerClass      your class (as in classes[]), or null
//   fieldSize        cars in your class
//   classes[]        name, colour, mine (your class), sof, size, rows[]
//     rows[]         colour (the class's), myClass, position, carNumber, name, onPitRoad, isPlayer,
//                    license, licenceColour, iRating, gapS, intervalS,
//                    lastLapS, bestLapS, fastest,
//                    aheadOfPlayer, behindPlayer (the cars either side of you),
//                    behindS (for your row: the car behind's interval to you)
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

/** The columns switched on, for a template's data-if. */
function shown(hidden, ids) {
  const out = {};
  for (const id of ids) out[id] = !hidden.has(id);
  out.chip = out.license || out.irating;
  return out;
}

/** The parts of a race view both race panels' models start from. */
function raceBasics(s) {
  const race = s.race;
  return {
    empty: race === null ? NO_RACE(s) : null,
    session: race === null ? "" : sessionLetter(race),
    /** "Race", "Qualify", "Practice": the sim's own word for the session. */
    sessionName: race?.sessionType ?? "",
    lap: race?.lap ?? null,
    lapsTotal: race?.lapsTotal ?? null,
    lapsLine: race === null ? "" : lapsLine(race),
    timeRemainS: race?.timeRemainS ?? null,
    incidents: race?.incidents ?? null,
  };
}

function standingsModel(s) {
  const basics = raceBasics(s);
  const race = s.race;
  const show = shown(s.options.hidden, ["header", "number", "license", "irating", "gap", "interval", "last", "best"]);
  // Lap-time columns wide enough for "1:57.870" in a monospace face too.
  const cols = columns(
    "30px",
    show.number && "36px",
    "minmax(70px,1fr)",
    show.chip && "64px",
    show.gap && "46px",
    show.interval && "40px",
    show.last && "72px",
    show.best && "72px",
  );
  let player = null;
  let playerClass = null;
  let fieldSize = 0;
  const classes = (race?.classes ?? []).map((sim) => {
    const colour = classColour(race, sim.classColor);
    const all = sim.rows;
    const me = all.findIndex((r) => r.isPlayer);
    if (me >= 0) fieldSize = all.length;
    const rows = condense(all).map((r) => {
      const at = all.indexOf(r);
      const row = {
        colour,
        myClass: me >= 0,
        position: r.classPosition || "",
        carNumber: r.carNumber,
        name: r.name,
        onPitRoad: r.onPitRoad,
        isPlayer: r.isPlayer,
        license: r.license,
        licenceColour: licenceColour(r.license, r.licenseColor),
        iRating: r.iRating,
        gapS: r.gapS,
        intervalS: r.intervalS,
        lastLapS: r.lastLapS,
        bestLapS: r.bestLapS,
        fastest: r.fastest,
        aheadOfPlayer: me >= 0 && at === me - 1,
        behindPlayer: me >= 0 && at === me + 1,
        behindS: r.isPlayer ? (all[at + 1]?.intervalS ?? null) : null,
      };
      if (r.isPlayer) player = row;
      return row;
    });
    const cls = { name: sim.className || "", colour, mine: me >= 0, sof: sim.sof ?? null, size: all.length, rows };
    if (me >= 0) playerClass = cls;
    return cls;
  });
  const carCount = classes.reduce((n, c) => n + c.size, 0);
  return { ...basics, show, cols, classes, player, playerClass, fieldSize, carCount };
}

const STANDINGS = `
<div class="panel standings" data-class="is-empty: empty">
  <div class="titlebar session-head keep" data-part="header">
    <span class="md">{{ session }}</span>
    <span>{{ lapsLine }}</span>
    <span class="clock muted n">{{ timeRemainS | clock }}</span>
  </div>
  <div class="class-list">
    <x-group data-each="classes">
      <div class="titlebar class-head" style="--cls:{{ colour }}">
        <span class="tag outline">{{ name | or:CLASS }}</span>
        <span class="muted">SoF {{ sof | or:— }}</span>
        <span class="spacer"></span>
        <span data-if="show.gap" class="cap c-gap">Gap</span>
        <span data-if="show.interval" class="cap c-int">Int</span>
        <span data-if="show.last" class="cap c-last">Last</span>
        <span data-if="show.best" class="cap c-best">Best</span>
      </div>
      <div class="card rows">
        <div data-each="rows" class="row" data-class="me: isPlayer; pit: onPitRoad" style="grid-template-columns:{{ cols }};--cls:{{ colour }}">
          <span class="pos">{{ position }}</span>
          <span data-if="show.number" class="num">#{{ carNumber }}</span>
          <span class="who">{{ name }} <span data-if="onPitRoad" class="tag">PIT</span></span>
          <span data-if="show.chip" class="irk" style="--lic:{{ licenceColour }}"><i data-if="show.license"></i><x-group data-if="show.license">{{ license | first }} </x-group><x-group data-if="show.irating">{{ iRating | irating }}</x-group></span>
          <span data-if="show.gap" class="r n">{{ gapS | gap }}</span>
          <span data-if="show.interval" class="r n muted">{{ intervalS | gap }}</span>
          <span data-if="show.last" class="r n">{{ lastLapS | lapTime }}</span>
          <span data-if="show.best" class="r n" data-class="fast: fastest; muted: !fastest">{{ bestLapS | lapTime }}</span>
        </div>
      </div>
    </x-group>
  </div>
  <div class="empty">{{ empty }}</div>
</div>`;

export const standings = templated({ template: STANDINGS, model: standingsModel, deps: ["race"], rate: 250 });

// ---------------------------------------------------------------------------
// Relatives: who is around you on the road, by time, between a header of the
// session's conditions and a footer of where the race is.
//
// Template data: the race basics above (empty, session, lapsLine,
// timeRemainS, incidents), and
//
//   airC, trackC, sof, brakeBiasPct, clock (the time of day, "14:48")
//   show.*        number, lap, license, irating, chip, header, footer
//   cols          grid-template-columns for those columns
//   rows[]        position, carNumber, name, lap, lapState (1 lapping you,
//                 −1 being lapped), lappingYou, lappedByYou, classColour, myClass, license, licenceColour, iRating, gapS
//                 (unsigned seconds), ahead (true for cars in front),
//                 isPlayer, onPitRoad
// ---------------------------------------------------------------------------

function relativeModel(s) {
  const basics = raceBasics(s);
  const race = s.race;
  const w = race?.weather ?? null;
  const show = shown(s.options.hidden, ["header", "number", "lap", "license", "irating", "footer"]);
  const cols = columns("34px", show.number && "40px", "minmax(70px,1fr)", show.lap && "38px", show.chip && "56px", "42px");
  const mine = race?.classes.find((c) => c.rows.some((r) => r.isPlayer)) ?? null;
  const rows = (race?.relatives ?? []).map((r) => {
    const colour = classColour(race, r.classColor);
    return {
      position: r.position || "",
      carNumber: r.carNumber,
      name: r.name,
      lap: r.lap,
      lapState: r.lapState,
      lappingYou: r.lapState > 0,
      lappedByYou: r.lapState < 0,
      classColour: colour,
      myClass: r.classColor === playerClassColour(race),
      license: r.license,
      licenceColour: licenceColour(r.license, r.licenseColor),
      iRating: r.iRating,
      gapS: r.isPlayer ? 0 : Math.abs(r.gapS),
      ahead: !r.isPlayer && r.gapS < 0,
      isPlayer: r.isPlayer,
      onPitRoad: r.onPitRoad,
    };
  });
  return {
    ...basics,
    show,
    cols,
    rows,
    airC: w?.airC ?? null,
    trackC: w?.trackC ?? null,
    sof: mine?.sof ?? null,
    brakeBiasPct: race?.brakeBiasPct ?? null,
    clock: new Date().toTimeString().slice(0, 5),
  };
}

const RELATIVE = `
<div class="panel relative" data-class="is-empty: empty">
  <div class="titlebar conditions keep" data-part="header">
    <span class="n">{{ airC | fixed }}°C</span><span class="n">{{ trackC | fixed }}°C</span>
    <span data-if="sof">SoF {{ sof }}</span>
    <span data-if="brakeBiasPct">BB {{ brakeBiasPct | fixed:1 }}%</span>
    <span>✕ {{ incidents }}x</span><span class="n">{{ clock }}</span>
  </div>
  <div class="card rows grow">
    <div data-each="rows" class="row" data-class="me: isPlayer; pit: onPitRoad; lapping: lappingYou; lapped: lappedByYou" style="grid-template-columns:{{ cols }};--cls:{{ classColour }}">
      <span class="pos">{{ position }}</span>
      <span data-if="show.number" class="num">#{{ carNumber }}</span>
      <span class="who">{{ name }}</span>
      <span data-if="show.lap" class="tag lap">L{{ lap }}</span>
      <span data-if="show.chip" class="irk" style="--lic:{{ licenceColour }}"><i data-if="show.license"></i><x-group data-if="show.license">{{ license | first }} </x-group><x-group data-if="show.irating">{{ iRating | irating }}</x-group></span>
      <span class="gap r n">{{ gapS | fixed:1 }}</span>
    </div>
  </div>
  <div class="titlebar split footer" data-part="footer">
    <span class="laps">{{ lapsLine }}</span><span class="n">{{ timeRemainS | clock }}</span>
  </div>
  <div class="empty">{{ empty }}</div>
</div>`;

export const relative = templated({ template: RELATIVE, model: relativeModel, deps: ["race"], rate: 200 });

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

/**
 * RaceLab's radar: no disc and no rings. Your car and the others as plain
 * white shapes; a car alongside lights a red bar down that side, fading
 * outwards; a car close behind or ahead a yellow glow at that end, stronger
 * the closer it is.
 */
function drawGlowRadar(ctx, cx, cy, R, m, r, cars, s) {
  const cw = CAR_W_M * m;
  const ch = CAR_LEN_M * m;
  const spotter = s.race?.radar.spotter ?? "off";
  const left = spotter === "left" || spotter === "twoLeft" || spotter === "both";
  const right = spotter === "right" || spotter === "twoRight" || spotter === "both";
  const bar = (side) => {
    const x0 = side < 0 ? cx - cw * 0.7 : cx + cw * 0.7;
    const x1 = side < 0 ? x0 - R * 0.55 : x0 + R * 0.55;
    const g = ctx.createLinearGradient(x0, 0, x1, 0);
    g.addColorStop(0, "rgba(232, 40, 40, 0.95)");
    g.addColorStop(1, "rgba(232, 40, 40, 0)");
    ctx.fillStyle = g;
    ctx.fillRect(Math.min(x0, x1), cy - ch * 0.95, Math.abs(x1 - x0), ch * 1.9);
    // Two thin lines through it, as RaceLab draws them.
    ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
    ctx.fillRect(Math.min(x0, x1), cy - ch * 0.2, Math.abs(x1 - x0) * 0.6, 1.5 * r);
  };
  if (left) bar(-1);
  if (right) bar(1);
  for (const car of cars) {
    if (car.alongside) continue;
    const d = Math.abs(car.y - cy);
    const k = Math.max(0, 1 - d / R);
    if (k <= 0) continue;
    const g = ctx.createRadialGradient(cx, car.y, 0, cx, car.y, R * 0.7);
    g.addColorStop(0, `rgba(228, 190, 40, ${(0.75 * k).toFixed(2)})`);
    g.addColorStop(1, "rgba(228, 190, 40, 0)");
    ctx.fillStyle = g;
    ctx.fillRect(cx - R, car.y - R * 0.7, R * 2, R * 1.4);
  }
  const shape = (x, y) => {
    roundRect(ctx, x - cw / 2, y - ch / 2, cw, ch, 3 * r);
    ctx.fillStyle = "#ffffff";
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = 4 * r;
    ctx.fill();
    ctx.shadowBlur = 0;
  };
  for (const car of cars) shape(car.x, car.y);
  shape(cx, cy);
}

function radarBlock(el) {
  const canvas = canvasIn(el);

  return {
    paint(s) {
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

      if (el.getAttribute("look") === "glow") {
        drawGlowRadar(ctx, cx, cy, R, m, r, cars, s);
        ctx.restore();
        return;
      }
      const chevrons = el.getAttribute("cars") === "chevron";
      const bare = el.getAttribute("disc") === "none";
      if (el.getAttribute("road") === "strip") {
        // Gran Turismo's radar: the road as a lighter strip through the
        // middle, a crosshair through you, fading out towards the edge.
        const lane = CAR_W_M * m * 3.4;
        const strip = ctx.createLinearGradient(0, cy - R, 0, cy + R);
        strip.addColorStop(0, "rgba(255,255,255,0)");
        strip.addColorStop(0.25, "rgba(255,255,255,0.16)");
        strip.addColorStop(0.75, "rgba(255,255,255,0.16)");
        strip.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = strip;
        ctx.fillRect(cx - lane / 2, cy - R, lane, R * 2);
        ctx.strokeStyle = alpha(COLORS.ink, 0.45);
        ctx.lineWidth = 1 * r;
        ctx.beginPath();
        ctx.moveTo(cx - R, cy);
        ctx.lineTo(cx + R, cy);
        ctx.moveTo(cx, cy - R * 0.95);
        ctx.lineTo(cx, cy + R * 0.95);
        ctx.stroke();
      }
      if (!bare) {
        const disc = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R);
        disc.addColorStop(0, "rgba(60,64,70,0.55)");
        disc.addColorStop(0.7, "rgba(25,27,30,0.75)");
        disc.addColorStop(1, "rgba(10,11,12,0.85)");
        ctx.fillStyle = disc;
        ctx.fillRect(0, 0, w, h);
      }

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

      const rimless = el.getAttribute("rim") === "none";
      if (neon) {
        // The rim as a sweep from one warning colour to the next.
        const rim = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
        rim.addColorStop(0, COLORS.red);
        rim.addColorStop(0.5, COLORS.orange);
        rim.addColorStop(1, COLORS.danger);
        ctx.strokeStyle = rim;
        ctx.lineWidth = 1.6 * r;
      } else {
        ctx.strokeStyle = alpha(COLORS.ink, bare ? 0.4 : 0.18);
        ctx.lineWidth = 1 * r;
      }
      // No outer ring with rim="none": the theme's backdrop is the edge.
      if (!rimless) {
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, Math.PI * 2);
        ctx.stroke();
      }

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
      if (chevrons) {
        // Gran Turismo's arrowheads, pointing up the road: the accent colour
        // for the others, red for you.
        const size = CAR_LEN_M * m * 0.55;
        for (const car of cars) chevron(ctx, car.x, car.y, -Math.PI / 2, size, COLORS.blue, r);
        chevron(ctx, cx, cy, -Math.PI / 2, size, COLORS.red, r);
        return;
      }
      for (const car of cars) drawCar(car.x, car.y);
      drawCar(cx, cy);
    },
  };
}

registerBlock(
  "x-radar",
  {
    summary:
      "Cars within a few lengths ahead and behind, with a warning wedge towards each, pushed to the side the spotter calls.",
    attributes: {
      cars: "car (default, a top-down car) | chevron — arrowheads, yours in red",
      disc: "shaded (default) | none — just the rings, over the scene",
      road: "none (default) | strip — the road as a lighter strip with a crosshair, as Gran Turismo's",
      rim: "shown (default) | none — no outer ring",
      look: "rings (default) | glow — no disc or rings: red bars beside you for a car alongside, a yellow glow for one close behind or ahead, as RaceLab's",
    },
  },
  radarBlock,
);

const RADAR = `
<div class="panel radar">
  <x-radar></x-radar>
</div>`;

export const radar = templated({ template: RADAR, model: () => ({}), rate: 1000 });

// ---------------------------------------------------------------------------
// Blind spot: a window per side — Blind Spot Left and Right — each a box
// that lights when the spotter says a car is there. The sim's spotter is the
// one lateral fact it gives (see Radar). One template serves both: a theme
// writes templates/spotter.html, and it can tell the sides apart by `side`.
//
// Template data: empty, side ("left" or "right"), on (a car alongside on
// this side), twoWide (two cars this side), threeWide (one each side),
// spotter (the sim's word).
// ---------------------------------------------------------------------------

function spotterModel(side) {
  return (s) => {
    const sp = s.race?.radar.spotter ?? "off";
    const left = sp === "left" || sp === "twoLeft" || sp === "both";
    const right = sp === "right" || sp === "twoRight" || sp === "both";
    return {
      empty: s.race === null ? NO_RACE(s) : null,
      side,
      isLeft: side === "left",
      on: side === "left" ? left : right,
      twoWide: side === "left" ? sp === "twoLeft" : sp === "twoRight",
      threeWide: sp === "both",
      spotter: sp,
    };
  };
}

const SPOTTER_TEMPLATE = `
<div class="panel spotter" data-class="is-empty: empty; idle: !on">
  <div class="spot-box" data-class="on: on">
    <span class="spot-cap">Blind spot</span><i></i><span class="spot-cap">{{ side | upper }}</span>
  </div>
  <div class="empty">{{ empty }}</div>
</div>`;

export const spotterLeft = templated({ template: SPOTTER_TEMPLATE, model: spotterModel("left"), deps: ["race"] });
export const spotterRight = templated({ template: SPOTTER_TEMPLATE, model: spotterModel("right"), deps: ["race"] });
// A theme's templates/spotter.html serves both.
spotterLeft.family = "spotter";
spotterRight.family = "spotter";

// ---------------------------------------------------------------------------
// Flags: the flag out now, drawn as the flag itself, waving when it is
// waved, with what it means beside it. Nothing at all when there is none.
//
// Template data: flag (null for none), kind (green, yellow, blue, white,
// red, black, meatball, checkered, debris, disqualify), waving, label, hint.
// ---------------------------------------------------------------------------

const FLAG_WORDS = {
  green: ["Green", "Racing"],
  yellow: ["Yellow", "Caution — no overtaking"],
  blue: ["Blue", "Faster car behind — let it by"],
  white: ["White", "Final lap"],
  red: ["Red", "Session stopped"],
  black: ["Black", "Penalty — to the pits"],
  meatball: ["Repair", "Damage — to the pits"],
  checkered: ["Chequered", "Finish"],
  debris: ["Debris", "Surface — take care"],
  disqualify: ["Disqualified", ""],
};

function flagsModel(s) {
  const f = s.race?.flag ?? null;
  if (f === null) return { flag: null, kind: "", waving: false, label: "", hint: "" };
  const [label, hint] = FLAG_WORDS[f.kind] ?? [f.kind, ""];
  return { flag: f, kind: f.kind, waving: f.waving, label, hint };
}

const FLAGS_TEMPLATE = `
<div class="panel flags">
  <div class="flag-card" data-if="flag">
    <i class="flag-cloth {{ kind }}" data-class="waving: waving"></i>
    <div class="flag-words"><b>{{ label }}</b><span>{{ hint }}</span></div>
  </div>
</div>`;

export const flags = templated({ template: FLAGS_TEMPLATE, model: flagsModel, deps: ["race"] });
