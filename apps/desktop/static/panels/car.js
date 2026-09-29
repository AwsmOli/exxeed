// Car panels — fuel, tyres, damage, weather. All from the race channel, so
// live sim only, like the race panels.

import { droplet, lanes, pump, sky, thermometer } from "./icons.js";
import { $, clock, html, setText, tempColour } from "./util.js";

const NO_RACE = (s) =>
  s.status?.phase === "running" ? "live sim only — this source has no car data" : "waiting for the sim";

const l = (v, digits = 1) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "—");

function emptyState(el, s) {
  const empty = s.race === null;
  el.classList.toggle("is-empty", empty);
  if (empty) setText($(el, ".empty"), NO_RACE(s));
  return empty;
}

// ---------------------------------------------------------------------------
// Fuel calculator: what is in the tank, how far it goes, the per-lap
// prediction, and whether it reaches the flag.
// ---------------------------------------------------------------------------

export function fuel() {
  const el = html(`
    <div class="panel is-empty">
      <div class="titlebar split">
        <span class="lg"><span data-k="lap">—</span><span class="faint" data-k="of"></span></span>
        <span class="lg n" data-k="clock"></span>
      </div>
      <div class="card grow">
        <div class="fuel-top">
          <span class="lg n" data-k="level">—</span>
          <span class="muted">${pump(18)}</span>
          <span class="md n"><span data-k="left">—</span> laps</span>
        </div>
        <div class="fuel-bar"><i data-k="bar"></i></div>
        <div class="predict">
          <span class="good">${pump(26)}</span>
          <div style="flex:1">
            <div class="muted" style="font-size:13px">Predicted Fuel / Lap</div>
            <div class="xl good n"><span data-k="avg">—</span> L</div>
          </div>
          <div class="r faint" style="font-size:11px">vs max<br><span class="md muted n" data-k="max">—</span></div>
        </div>
        <div class="usage">
          <span class="h">USAGE</span><span class="h c">/LAP</span><span class="h r">ENDS</span>
          <span class="muted">LAST</span><span class="c muted n" data-k="lastL">—</span><span class="r n" data-k="lastE">—</span>
          <span class="muted">AVG</span><span class="c muted n" data-k="avgL">—</span><span class="r n" data-k="avgE">—</span>
          <span class="muted">MAX</span><span class="c muted n" data-k="maxL">—</span><span class="r n" data-k="maxE">—</span>
        </div>
        <div class="finish">
          <div><div class="cap">To finish</div><span class="lg n" data-k="finish">—</span><span class="u">L</span></div>
          <div><span class="lg n" data-k="margin">—</span><span class="u" data-k="marginU"></span></div>
        </div>
      </div>
      <div class="empty"></div>
    </div>`);
  const k = (name) => $(el, `[data-k="${name}"]`);

  return {
    el,
    draw(s) {
      if (emptyState(el, s)) return;
      const race = s.race;
      const f = race.fuel;

      setText(k("lap"), String(race.lap));
      setText(k("of"), race.lapsTotal !== null ? ` / ${race.lapsTotal}` : "");
      setText(k("clock"), race.timeRemainS !== null ? clock(race.timeRemainS) : "");
      setText(k("level"), l(f.levelL));
      setText(k("left"), l(f.lapsLeft));
      k("bar").style.width = `${Math.round((1 - Math.max(0, Math.min(1, f.levelPct))) * 100)}%`;
      setText(k("avg"), l(f.perLapL, 2));
      setText(k("max"), f.maxLapL === null ? "—" : `${l(f.maxLapL, 2)} L`);

      // "Ends": the lap the tank runs dry on, at that rate.
      const ends = (per) => (per > 0 ? l(race.lap + f.levelL / per) : "—");
      for (const [key, per] of [["last", f.lastLapL], ["avg", f.perLapL], ["max", f.maxLapL]]) {
        setText(k(`${key}L`), l(per, 2));
        setText(k(`${key}E`), ends(per));
      }

      setText(k("finish"), f.toFinishL === null ? "—" : l(f.toFinishL));
      if (f.marginL === null) {
        setText(k("margin"), f.perLapL === null ? "learning" : "—");
        setText(k("marginU"), f.perLapL === null ? " one clean lap" : "");
        k("margin").className = "lg n faint";
      } else {
        setText(k("margin"), `${f.marginL >= 0 ? "+" : "−"}${l(Math.abs(f.marginL))}`);
        setText(k("marginU"), f.marginL >= 0 ? " L spare" : " L short");
        k("margin").className = `lg n ${f.marginL >= 0 ? "" : "bad"}`;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tyres: each tyre coloured across its tread by carcass temperature, with its
// pressure above and wear below.
//
// iRacing only updates these while the car is in its pit stall — on track
// they hold whatever they read when you left. That is the SDK, not us, and the
// panel says so rather than let a stale number pass for a live one.
// ---------------------------------------------------------------------------

const KPA_TO_PSI = 0.1450377;

function tyreHtml(id, labels) {
  return `<div class="tyre" data-t="${id}">
    <span class="md n" data-k="p">—</span>
    <div class="body"><span class="temp n" data-k="t">—</span>
      <div class="ico">${labels.map((x) => `<span>${x}</span>`).join("")}</div></div>
    <span class="md n" data-k="w">—</span>
  </div>`;
}

export function tyres() {
  // The SDK reads a tread left to right as the car sees it, so on the left
  // tyres the outside edge comes first.
  const left = ["O", "C", "I"];
  const right = ["I", "C", "O"];
  const el = html(`
    <div class="panel is-empty">
      <div class="titlebar keep">Front</div>
      <div class="card"><div class="axle" style="justify-content:space-around">${tyreHtml("lf", left)}<span class="faint" style="font-size:10px;width:70px;text-align:center">psi · °C · wear</span>${tyreHtml("rf", right)}</div></div>
      <div class="titlebar">Rear <span class="faint" style="font-size:11px">last pit read</span></div>
      <div class="card"><div class="axle" style="justify-content:space-around">${tyreHtml("lr", left)}<span style="width:70px"></span>${tyreHtml("rr", right)}</div></div>
      <div class="empty"></div>
    </div>`);

  return {
    el,
    draw(s) {
      if (emptyState(el, s)) return;
      for (const id of ["lf", "rf", "lr", "rr"]) {
        const t = s.race.tyres[id];
        const tile = $(el, `[data-t="${id}"]`);
        const [a, b, c] = t.tempC.map(tempColour);
        $(tile, ".body").style.background = `linear-gradient(90deg, ${a}, ${b}, ${c})`;
        const mid = t.tempC[1] ?? 0;
        setText($(tile, '[data-k="t"]'), mid > 0 ? `${mid.toFixed(0)}°` : "—");
        setText($(tile, '[data-k="p"]'), t.coldPressureKpa > 0 ? (t.coldPressureKpa * KPA_TO_PSI).toFixed(1) : "—");
        setText($(tile, '[data-k="w"]'), `${Math.round(Math.min(...t.wear) * 100)}%`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Damage: the repair time the sim has put on the car. It is the only damage
// the SDK reports — there is no per-panel state to draw — but "how long will
// the stop take" is the question damage actually raises mid-race.
// ---------------------------------------------------------------------------

export function damage() {
  const el = html(`
    <div class="panel is-empty">
      <div class="card grow">
        <div class="row-flex" style="align-items:baseline">
          <span class="xl n" style="font-size:32px;font-weight:600" data-k="req">0</span>
          <span style="color:var(--orange);font-weight:700">s</span>
          <span class="cap" style="letter-spacing:0.12em;margin-left:6px">Repair</span>
        </div>
        <div class="muted" style="margin-top:8px"><span class="n" data-k="opt">0</span> s optional</div>
      </div>
      <div class="empty"></div>
    </div>`);
  const k = (name) => $(el, `[data-k="${name}"]`);

  return {
    el,
    draw(s) {
      if (emptyState(el, s)) return;
      setText(k("req"), s.race.repairS.toFixed(0));
      setText(k("opt"), s.race.optionalRepairS.toFixed(0));
      k("req").style.color = s.race.repairS > 0 ? "var(--red)" : "";
    },
  };
}

// ---------------------------------------------------------------------------
// Weather conditions.
// ---------------------------------------------------------------------------

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const compass = (rad) => COMPASS[Math.round(((((rad * 180) / Math.PI) % 360) + 360) % 360 / 45) % 8];
const cap1 = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : "");

export function weather() {
  const el = html(`
    <div class="panel is-empty">
      <div class="card grow">
        <div class="spread">
          <span class="row-flex md"><span data-k="icon"></span><span data-k="sky">—</span></span>
          <span class="muted" style="font-size:11.5px" data-k="wet"></span>
        </div>
        <div class="wx-stats">
          <div class="grid">
            <span class="wx-stat"><span class="muted">${thermometer()}</span><b class="n" data-k="air">—</b><span class="cap">°C air</span></span>
            <span class="wx-stat"><span class="muted">${lanes()}</span><b class="n" data-k="track">—</b><span class="cap">°C track</span></span>
            <span class="wx-stat"><span class="muted">${droplet()}</span><b class="n" data-k="hum">—</b><span class="cap">% hum</span></span>
            <span class="wx-stat" data-k="rainRow"><span class="muted">${droplet()}</span><b class="n" data-k="rain">—</b><span class="cap">% rain</span></span>
          </div>
          <div class="wx-wind">
            <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden="true">
              <circle cx="22" cy="22" r="19" fill="none" stroke="rgba(255,255,255,0.35)" stroke-width="1.2"/>
              <path d="M22 1.5l3 4h-6z" fill="#fff"/>
              <g data-k="arrow"><path d="M22 12l7 16-7-4-7 4z" fill="#fff"/></g>
            </svg>
            <div><b class="md n" data-k="wind">—</b> <span class="cap">kph</span><div class="cap" data-k="dir"></div></div>
          </div>
        </div>
      </div>
      <div class="empty"></div>
    </div>`);
  const k = (name) => $(el, `[data-k="${name}"]`);
  let skyWas = null;

  return {
    el,
    draw(s) {
      if (emptyState(el, s)) return;
      const w = s.race.weather;
      if (w.skies !== skyWas) {
        k("icon").innerHTML = sky(w.skies);
        skyWas = w.skies;
      }
      setText(k("sky"), cap1(w.skies) || "—");
      const surface = w.declaredWet ? "Declared wet" : cap1(w.wetness);
      setText(k("wet"), [surface.toUpperCase(), s.race.rubber].filter(Boolean).join(" · "));
      setText(k("air"), w.airC.toFixed(0));
      setText(k("track"), w.trackC.toFixed(0));
      setText(k("hum"), String(Math.round(w.humidity * 100)));
      setText(k("rain"), String(Math.round(w.precipitation * 100)));
      setText(k("wind"), (w.windMps * 3.6).toFixed(0));
      setText(k("dir"), compass(w.windDirRad));
      // The arrow points the way the wind blows TO, as a weather map draws it.
      k("arrow").setAttribute("transform", `rotate(${((w.windDirRad * 180) / Math.PI + 180) % 360} 22 22)`);
    },
  };
}
