// Car panels — fuel, tyres, damage, weather. All from the race channel, so
// live sim only, like the race panels.

import { templated } from "./templated.js";
import { tempColour } from "./util.js";

const NO_RACE = (s) =>
  s.status?.phase === "running" ? "live sim only — this source has no car data" : "waiting for the sim";

const l = (v, digits = 1) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "—");

/** Why there is nothing to show, or null. Every car panel's model starts here. */
const emptyOf = (s) => (s.race === null ? NO_RACE(s) : null);

// ---------------------------------------------------------------------------
// Fuel calculator: what is in the tank, how far it goes, the per-lap
// prediction, and whether it reaches the flag.
// ---------------------------------------------------------------------------

function fuelModel(s) {
  const empty = emptyOf(s);
  if (empty !== null) return { empty };
  const race = s.race;
  const f = race.fuel;
  // "Ends": the lap the tank runs dry on, at that rate.
  const ends = (per) => (per > 0 ? l(race.lap + f.levelL / per) : "—");
  const usage = (label, per) => ({ label, perLap: l(per, 2), ends: ends(per), laps: per > 0 ? l(f.levelL / per) : "—" });
  // The lap time the tank is measured against: your last, else the reference's.
  const lapS = race.lastLapS ?? s.reference?.lapTimeS ?? null;
  const learning = f.marginL === null && f.perLapL === null;
  return {
    empty: null,
    lap: race.lap,
    lapsTotal: race.lapsTotal,
    timeRemainS: race.timeRemainS,
    levelL: l(f.levelL),
    levelPct: Math.round(Math.max(0, Math.min(1, f.levelPct)) * 100),
    /** The tank's size, from how full it is. */
    capacityL: f.levelPct > 0.01 ? Math.round(f.levelL / f.levelPct) : null,
    /** How long the fuel lasts at the average rate, in seconds. */
    timeLeftS: typeof f.lapsLeft === "number" && lapS !== null ? f.lapsLeft * lapS : null,
    /** 0–1, for scaling a bar. */
    level: Math.max(0, Math.min(1, f.levelPct)).toFixed(3),
    /** The used part of the bar, which covers the gradient from the right. */
    usedPct: Math.round((1 - Math.max(0, Math.min(1, f.levelPct))) * 100),
    lapsLeft: l(f.lapsLeft),
    perLapL: l(f.perLapL, 2),
    maxLapL: f.maxLapL === null ? null : l(f.maxLapL, 2),
    usage: [usage("LAST", f.lastLapL), usage("AVG", f.perLapL), usage("MAX", f.maxLapL)],
    toFinishL: f.toFinishL === null ? "—" : l(f.toFinishL),
    learning,
    hasMargin: f.marginL !== null,
    marginL: f.marginL === null ? null : `${f.marginL >= 0 ? "+" : "−"}${l(Math.abs(f.marginL))}`,
    spare: f.marginL !== null && f.marginL >= 0,
    short: f.marginL !== null && f.marginL < 0,
  };
}

const FUEL = `
<div class="panel fuel" data-class="is-empty: empty">
  <div class="titlebar split" data-part="header">
    <span class="lg">{{ lap }}<span data-if="lapsTotal" class="faint"> / {{ lapsTotal }}</span></span>
    <span class="lg n"><x-group data-if="timeRemainS">{{ timeRemainS | clock }}</x-group></span>
  </div>
  <div class="card grow">
    <div class="fuel-top">
      <span class="lg n">{{ levelL }}</span>
      <span class="muted"><x-icon name="pump" size="18"></x-icon></span>
      <span class="md n">{{ lapsLeft }} laps</span>
    </div>
    <div class="fuel-bar" data-part="bar"><i style="width:{{ usedPct }}%"></i></div>
    <div class="predict" data-part="predicted">
      <span class="good"><x-icon name="pump" size="26"></x-icon></span>
      <div class="predict-main">
        <div class="muted predict-label">Predicted Fuel / Lap</div>
        <div class="xl good n">{{ perLapL }} L</div>
      </div>
      <div class="r faint predict-max">vs max<br><span class="md muted n"><x-group data-if="maxLapL">{{ maxLapL }} L</x-group><x-group data-if="!maxLapL">—</x-group></span></div>
    </div>
    <div class="usage" data-part="usage">
      <span class="h">USAGE</span><span class="h c">/LAP</span><span class="h r">ENDS</span>
      <x-group data-each="usage"><span class="muted">{{ label }}</span><span class="c muted n">{{ perLap }}</span><span class="r n">{{ ends }}</span></x-group>
    </div>
    <div class="finish" data-part="finish">
      <div><div class="cap">To finish</div><span class="lg n">{{ toFinishL }}</span><span class="u">L</span></div>
      <div data-if="learning"><span class="lg n faint">learning</span><span class="u"> one clean lap</span></div>
      <div data-if="hasMargin"><span class="lg n" data-class="bad: short">{{ marginL }}</span><span class="u"><x-group data-if="spare"> L spare</x-group><x-group data-if="short"> L short</x-group></span></div>
    </div>
  </div>
  <div class="empty">{{ empty }}</div>
</div>`;

export const fuel = templated({ template: FUEL, model: fuelModel });

// ---------------------------------------------------------------------------
// Tyres: each tyre coloured across its tread by carcass temperature, with its
// pressure above and wear below.
//
// iRacing only updates these while the car is in its pit stall — on track
// they hold whatever they read when you left. That is the SDK, not us, and the
// panel says so rather than let a stale number pass for a live one.
// ---------------------------------------------------------------------------

const KPA_TO_PSI = 0.1450377;

function tyresModel(s) {
  const empty = emptyOf(s);
  if (empty !== null) return { empty };
  const tyre = (id, edges) => {
    const t = s.race.tyres[id];
    const [a, b, c] = t.tempC.map(tempColour);
    const mid = t.tempC[1] ?? 0;
    return {
      // The SDK reads a tread left to right as the car sees it, so on the
      // left tyres the outside edge comes first.
      edges,
      gradient: `linear-gradient(90deg, ${a}, ${b}, ${c})`,
      /** The tyre as one colour, by its centre temperature. */
      colour: b,
      tempsC: t.tempC.map((v) => Math.round(v)),
      tempC: mid > 0 ? `${mid.toFixed(0)}°` : "—",
      psi: t.coldPressureKpa > 0 ? (t.coldPressureKpa * KPA_TO_PSI).toFixed(1) : "—",
      wearPct: Math.round(Math.min(...t.wear) * 100),
      /** How much is worn away, 0–100: the tread left's complement. */
      wornPct: 100 - Math.round(Math.min(...t.wear) * 100),
    };
  };
  const left = ["O", "C", "I"];
  const right = ["I", "C", "O"];
  return { empty: null, lf: tyre("lf", left), rf: tyre("rf", right), lr: tyre("lr", left), rr: tyre("rr", right) };
}

/** One tyre's tile, for the template below: pressure, the tread coloured by temperature, wear. */
const tyreTile = (id) => `
  <div class="tyre">
    <span class="md n" data-part="pressure">{{ ${id}.psi }}</span>
    <div class="body" style="background:{{ ${id}.gradient }}"><span class="temp n" data-part="temps">{{ ${id}.tempC }}</span>
      <div class="ico"><span data-each="${id}.edges">{{ . }}</span></div></div>
    <span class="md n" data-part="wear">{{ ${id}.wearPct }}%</span>
  </div>`;

const TYRES = `
<div class="panel tyres" data-class="is-empty: empty">
  <div class="titlebar keep">Front</div>
  <div class="card"><div class="axle">${tyreTile("lf")}<span class="faint axle-key">psi · °C · wear</span>${tyreTile("rf")}</div></div>
  <div class="titlebar">Rear <span class="faint axle-note" data-part="note">last pit read</span></div>
  <div class="card"><div class="axle">${tyreTile("lr")}<span class="axle-key"></span>${tyreTile("rr")}</div></div>
  <div class="empty">{{ empty }}</div>
</div>`;

export const tyres = templated({ template: TYRES, model: tyresModel, deps: ["race"], rate: 250 });

// ---------------------------------------------------------------------------
// Damage: the repair time the sim has put on the car. It is the only damage
// the SDK reports — there is no per-panel state to draw — but "how long will
// the stop take" is the question damage actually raises mid-race.
// ---------------------------------------------------------------------------

function damageModel(s) {
  const empty = emptyOf(s);
  if (empty !== null) return { empty };
  return {
    empty: null,
    repairS: s.race.repairS.toFixed(0),
    optionalS: s.race.optionalRepairS.toFixed(0),
    needsRepair: s.race.repairS > 0,
  };
}

const DAMAGE = `
<div class="panel damage" data-class="is-empty: empty">
  <div class="card grow">
    <div class="row-flex damage-main">
      <span class="xl n damage-s" data-class="bad: needsRepair">{{ repairS }}</span>
      <span class="damage-unit">s</span>
      <span class="cap damage-cap">Repair</span>
    </div>
    <div class="muted damage-opt"><span class="n">{{ optionalS }}</span> s optional</div>
  </div>
  <div class="empty">{{ empty }}</div>
</div>`;

export const damage = templated({ template: DAMAGE, model: damageModel, deps: ["race"], rate: 250 });

// ---------------------------------------------------------------------------
// Weather conditions.
// ---------------------------------------------------------------------------

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const compass = (rad) => COMPASS[Math.round(((((rad * 180) / Math.PI) % 360) + 360) % 360 / 45) % 8];
const cap1 = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : "");

function weatherModel(s) {
  const empty = emptyOf(s);
  if (empty !== null) return { empty, windArrowDeg: 0 };
  const w = s.race.weather;
  const surface = w.declaredWet ? "Declared wet" : cap1(w.wetness);
  return {
    empty: null,
    skies: w.skies,
    sky: cap1(w.skies) || "—",
    surface: [surface.toUpperCase(), s.race.rubber].filter(Boolean).join(" · "),
    airC: w.airC.toFixed(0),
    trackC: w.trackC.toFixed(0),
    humidityPct: Math.round(w.humidity * 100),
    rainPct: Math.round(w.precipitation * 100),
    windKph: (w.windMps * 3.6).toFixed(0),
    windFrom: compass(w.windDirRad),
    // The arrow points the way the wind blows TO, as a weather map draws it.
    windArrowDeg: (((w.windDirRad * 180) / Math.PI + 180) % 360).toFixed(1),
  };
}

const WEATHER = `
<div class="panel weather" data-class="is-empty: empty">
  <div class="card grow">
    <div class="spread" data-part="sky">
      <span class="row-flex md"><x-icon name="sky" of="{{ skies }}"></x-icon><span>{{ sky }}</span></span>
      <span class="muted wx-surface">{{ surface }}</span>
    </div>
    <div class="wx-stats">
      <div class="grid">
        <span class="wx-stat"><span class="muted"><x-icon name="thermometer"></x-icon></span><b class="n">{{ airC }}</b><span class="cap">°C air</span></span>
        <span class="wx-stat"><span class="muted"><x-icon name="lanes"></x-icon></span><b class="n">{{ trackC }}</b><span class="cap">°C track</span></span>
        <span class="wx-stat" data-part="humidity"><span class="muted"><x-icon name="droplet"></x-icon></span><b class="n">{{ humidityPct }}</b><span class="cap">% hum</span></span>
        <span class="wx-stat" data-part="humidity"><span class="muted"><x-icon name="droplet"></x-icon></span><b class="n">{{ rainPct }}</b><span class="cap">% rain</span></span>
      </div>
      <div class="wx-wind" data-part="wind">
        <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden="true">
          <circle cx="22" cy="22" r="19" fill="none" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.2"></circle>
          <path d="M22 1.5l3 4h-6z" fill="currentColor"></path>
          <g transform="rotate({{ windArrowDeg }} 22 22)"><path d="M22 12l7 16-7-4-7 4z" fill="currentColor"></path></g>
        </svg>
        <div><b class="md n">{{ windKph }}</b> <span class="cap">kph</span><div class="cap">{{ windFrom }}</div></div>
      </div>
    </div>
  </div>
  <div class="empty">{{ empty }}</div>
</div>`;

export const weather = templated({ template: WEATHER, model: weatherModel, deps: ["race"], rate: 250 });
