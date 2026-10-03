// Track panels — the circuit, and where everyone is on it.
//
// No card behind either: a grey road with a soft glow, straight over the sim,
// and every car as a badge carrying its position in its class colour.
//
// The centreline shares the pct grid with everything else (§4.1.1), so a lap
// position is an index into it with no lookup to do — for the player and, off
// the race channel, for every other car too.

import { $, alpha, classColour, COLORS, deltaTrend, fit, html, mix, setText, wrap01 } from "./util.js";

const PAD = 16;

const indexAt = (map, p) => Math.min(map.x.length - 1, Math.floor(wrap01(p) * map.x.length));

const font = () => COLORS.font;

/** The road: a dark glow, then a light grey surface. Holds over any sky. */
function road(ctx, path, width, r, dark = false) {
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  if (dark) {
    // The "dark road" style: a near-black track with a thin white edge.
    ctx.strokeStyle = "rgba(255,255,255,0.92)";
    ctx.lineWidth = width + 2.2 * r;
    ctx.stroke(path);
    ctx.strokeStyle = "#232323";
    ctx.lineWidth = width;
    ctx.stroke(path);
    return;
  }
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.75)";
  ctx.shadowBlur = 10 * r;
  ctx.strokeStyle = COLORS.roadEdge;
  ctx.lineWidth = width + 3 * r;
  ctx.stroke(path);
  ctx.restore();
  ctx.strokeStyle = COLORS.road;
  ctx.lineWidth = width;
  ctx.stroke(path);
}

/** A car: a filled disc in its class colour with its position on it. */
function badge(ctx, x, y, label, colour, r, big = false) {
  const R = (big ? 9 : 7.5) * r;
  if (big) {
    ctx.save();
    ctx.shadowColor = colour;
    ctx.shadowBlur = 14 * r;
    ctx.beginPath();
    ctx.arc(x, y, R + 3 * r, 0, Math.PI * 2);
    ctx.fillStyle = alpha(colour, 0.35);
    ctx.fill();
    ctx.restore();
  }
  // In a theme that glows, every car is a small neon light: its colour
  // bleeding out round it, and a pale rim instead of a dark one.
  const neon = COLORS.glow > 6;
  ctx.beginPath();
  ctx.arc(x, y, R, 0, Math.PI * 2);
  ctx.fillStyle = colour;
  if (neon) {
    ctx.save();
    ctx.shadowColor = colour;
    ctx.shadowBlur = 12 * r;
    ctx.fill();
    ctx.fill();
    ctx.restore();
  } else {
    ctx.fill();
  }
  ctx.strokeStyle = neon ? mix(colour, "#ffffff", 0.6) : "rgba(0,0,0,0.55)";
  ctx.lineWidth = 1.4 * r;
  ctx.stroke();
  if (label !== "") {
    ctx.fillStyle = "#08090a";
    ctx.font = `800 ${(big ? 10 : 8.5) * r}px ${font()}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x, y + 0.5 * r);
    ctx.textAlign = "start";
  }
}

/** Positions by car, from the standings — what each badge prints. */
function positions(race) {
  const out = new Map();
  for (const cls of race?.classes ?? []) for (const row of cls.rows) out.set(row.carIdx, row.classPosition);
  return out;
}

/** Everyone else, then the player on top. */
function drawCars(ctx, s, project, r, inView = () => true) {
  const pos = positions(s.race);
  const others = !s.options.hidden.has("cars");
  let me = null;
  for (const car of s.race?.cars ?? []) {
    if (car.isPlayer) me = car;
    if (!others) continue;
    if (car.onPitRoad) continue;
    if (car.isPlayer) {
      me = car;
      continue;
    }
    const [x, y] = project(car.lapDistPct);
    if (inView(x, y)) badge(ctx, x, y, String(pos.get(car.carIdx) ?? ""), classColour(s.race, car.classColor), r);
  }

  // Without race data the player is still known from the frame.
  const f = s.frame;
  if (f === null || typeof f.lapDistPct !== "number") return;
  const [x, y] = project(f.lapDistPct);
  const label = me === null ? "" : String(pos.get(me.carIdx) ?? "");
  badge(ctx, x, y, label, f.suppressedBy ? COLORS.orange : COLORS.green, r, true);
}

// ---------------------------------------------------------------------------
// Track map: the whole circuit.
// ---------------------------------------------------------------------------

const ROAD_W = 4.5;
/** Thirds of the lap, until the sim says where its own sectors are — as Delta Sectors does. */
const DEFAULT_SECTORS = [0, 1 / 3, 2 / 3];

export function map() {
  const el = html(`
    <div class="panel is-empty">
      <canvas class="fill"></canvas>
      <div class="empty" data-k="why">waiting for the sim</div>
    </div>`);
  const canvas = $(el, "canvas");
  const why = $(el, '[data-k="why"]');

  let path = null;
  let pathKey = "";

  // The heat map: for each point of the track, the colour the delta bar was
  // when the car last drove over it — green where time was being gained, red
  // where it was being lost (util.js deltaTrend). Kept across laps and
  // overwritten as each stretch is driven again, so it always shows the most
  // recent pass. Painted into its own layer a segment at a time; a paint only
  // copies the layer.
  const trend = deltaTrend();
  let heat = null; // colour per map point, or undefined where not yet driven
  let heatLayer = null;
  let heatKey = "";
  let lastIdx = null;

  const paintHeat = (mv, at, from, to, r) => {
    const g = heatLayer.getContext("2d");
    const n = mv.x.length;
    g.lineWidth = ROAD_W * r;
    g.lineCap = "round";
    g.lineJoin = "round";
    for (let i = from; i !== to; i = (i + 1) % n) {
      const colour = heat[i];
      if (colour === undefined) continue;
      g.strokeStyle = colour;
      g.beginPath();
      g.moveTo(...at(i));
      g.lineTo(...at((i + 1) % n));
      g.stroke();
    }
  };

  return {
    el,
    draw(s) {
      el.classList.toggle("is-empty", s.map === null);
      if (s.map === null) {
        // A blank panel is indistinguishable from a broken one; the status
        // already knows why there is no map, so borrow the sentence.
        const st = s.status;
        setText(
          why,
          st?.phase === "running"
            ? st.recordingTo === null
              ? "no map for this track"
              : "recording — no map yet"
            : st?.phase === "waiting"
              ? "waiting for the sim"
              : "stopped",
        );
        return;
      }

      const c = fit(canvas);
      if (c === null) return;
      const { ctx, w, h, r } = c;
      const mv = s.map;
      const pad = PAD * r;
      const at = (i) => [pad + mv.x[i] * (w - pad * 2), pad + mv.y[i] * (h - pad * 2)];

      const key = `${s.v.map}:${w}x${h}`;
      if (key !== pathKey) {
        path = new Path2D();
        const [x0, y0] = at(0);
        path.moveTo(x0, y0);
        for (let i = 1; i < mv.x.length; i++) path.lineTo(...at(i));
        path.closePath();
        pathKey = key;
      }

      // A new map starts a new heat map; a resize repaints the one there is.
      const n = mv.x.length;
      if (heat === null || heat.length !== n || heatKey.split(":")[0] !== String(s.v.map)) {
        heat = new Array(n);
        lastIdx = null;
      }
      if (heatKey !== key) {
        heatLayer = document.createElement("canvas");
        heatLayer.width = w;
        heatLayer.height = h;
        heatKey = key;
        paintHeat(mv, at, 0, n - 1, r);
      }

      // Colour the stretch driven since the last paint.
      const f = s.frame;
      if (f !== null && typeof f.deltaS === "number" && typeof f.lapDistPct === "number" && f.connected) {
        const colour = trend(f.deltaS);
        const idx = indexAt(mv, f.lapDistPct);
        // A jump (a reset, a tow, the first frame) is not a stretch of driving.
        const from = lastIdx === null || (idx - lastIdx + n) % n > n / 20 ? idx : lastIdx;
        for (let i = from; ; i = (i + 1) % n) {
          heat[i] = colour;
          if (i === idx) break;
        }
        paintHeat(mv, at, from, (idx + 1) % n, r);
        lastIdx = idx;
      }

      const off = s.options.hidden;
      const dark = s.options.style === "dark";
      ctx.clearRect(0, 0, w, h);
      road(ctx, path, (dark ? ROAD_W + 1.5 : ROAD_W) * r, r, dark);
      if (!off.has("heat")) ctx.drawImage(heatLayer, 0, 0);

      // The dark style numbers the turns: a small dark bubble beside each apex.
      if (dark) {
        ctx.font = `italic 800 ${8.5 * r}px ${COLORS.font}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        for (const corner of s.reference?.corners ?? []) {
          const j = indexAt(mv, corner.apexPct);
          const [x, y] = at(j);
          const [ax, ay] = at((j + 2) % n);
          const len = Math.hypot(ax - x, ay - y) || 1;
          let nx = -(ay - y) / len;
          let ny = (ax - x) / len;
          if (nx * (x - w / 2) + ny * (y - h / 2) < 0) {
            nx = -nx;
            ny = -ny;
          }
          const bx = x + nx * 15 * r;
          const by = y + ny * 15 * r;
          ctx.fillStyle = "#232323";
          ctx.beginPath();
          ctx.arc(bx, by, 7.5 * r, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "rgba(255,255,255,0.8)"; // on its own dark bubble, whatever the theme
          ctx.fillText(String(corner.index), bx, by + 0.5 * r);
        }
        ctx.textAlign = "start";
      }

      // Sector boundaries: a tick across the road and the sector's name beside
      // it, on the side away from the middle of the map. The line itself is S1.
      const starts = off.has("sectors")
        ? []
        : s.race?.sectorStartPcts?.length > 1
          ? s.race.sectorStartPcts
          : DEFAULT_SECTORS;
      ctx.font = `700 ${9.5 * r}px ${COLORS.font}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      starts.forEach((p, i) => {
        const j = indexAt(mv, p);
        const [x, y] = at(j);
        const [ax, ay] = at((j + 2) % n);
        const len = Math.hypot(ax - x, ay - y) || 1;
        let nx = -(ay - y) / len;
        let ny = (ax - x) / len;
        // Outwards: away from the centre of the panel.
        if (nx * (x - w / 2) + ny * (y - h / 2) < 0) {
          nx = -nx;
          ny = -ny;
        }
        if (i > 0) {
          ctx.strokeStyle = COLORS.text;
          ctx.lineWidth = 1.6 * r;
          ctx.beginPath();
          ctx.moveTo(x - nx * 5.5 * r, y - ny * 5.5 * r);
          ctx.lineTo(x + nx * 5.5 * r, y + ny * 5.5 * r);
          ctx.stroke();
        }
        ctx.fillStyle = COLORS.text;
        ctx.globalAlpha = 0.75;
        ctx.fillText(`S${i + 1}`, x + nx * 15 * r, y + ny * 15 * r);
        ctx.globalAlpha = 1;
      });
      ctx.textAlign = "start";

      // Start/finish: a short dark bar across the road.
      const i0 = mv.startIndex;
      const [sx, sy] = at(i0);
      const [nx, ny] = at((i0 + 2) % mv.x.length);
      const ang = Math.atan2(ny - sy, nx - sx) + Math.PI / 2;
      ctx.strokeStyle = "#111";
      ctx.lineWidth = 2.5 * r;
      ctx.beginPath();
      ctx.moveTo(sx - Math.cos(ang) * 6 * r, sy - Math.sin(ang) * 6 * r);
      ctx.lineTo(sx + Math.cos(ang) * 6 * r, sy + Math.sin(ang) * 6 * r);
      ctx.stroke();

      // Where each note speaks, small on the road — the quickest check that
      // a note set and a map agree about the same track.
      ctx.fillStyle = alpha(COLORS.blue, 0.95);
      for (const note of off.has("callouts") ? [] : mv.notes) {
        const [x, y] = at(note.index);
        ctx.beginPath();
        ctx.arc(x, y, 2.2 * r, 0, Math.PI * 2);
        ctx.fill();
      }

      drawCars(ctx, s, (p) => at(indexAt(mv, p)), r);
    },
  };
}

// ---------------------------------------------------------------------------
// Mini map: the next few hundred metres in a disc, turned so the road ahead
// is up.
// ---------------------------------------------------------------------------

const AHEAD_M = 260;

export function minimap() {
  const el = html(`
    <div class="panel is-empty">
      <canvas class="fill"></canvas>
      <div class="empty">no map for this track</div>
    </div>`);
  const canvas = $(el, "canvas");

  /** Metres per normalised map unit — the map is aspect-corrected, not scaled. */
  let metresPerUnit = null;
  let seen = -1;

  return {
    el,
    draw(s) {
      el.classList.toggle("is-empty", s.map === null);
      if (s.map === null || s.frame === null) return;
      const mv = s.map;
      const n = mv.x.length;

      if (seen !== s.v.map) {
        let len = 0;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          len += Math.hypot(mv.x[j] - mv.x[i], mv.y[j] - mv.y[i]);
        }
        metresPerUnit = len > 0 ? mv.lengthM / len : null;
        seen = s.v.map;
      }
      if (metresPerUnit === null) return;

      const c = fit(canvas);
      if (c === null) return;
      const { ctx, w, h, r } = c;
      ctx.clearRect(0, 0, w, h);

      const cx = w / 2;
      const cy = h / 2;
      const R = Math.min(w, h) / 2 - 2 * r;

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.clip();
      // Darker in a theme that glows, so the lights on it have something to glow against.
      const neon = COLORS.glow > 6;
      const disc = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R);
      disc.addColorStop(0, neon ? "rgba(26,26,32,0.8)" : "rgba(70,74,80,0.55)");
      disc.addColorStop(1, neon ? "rgba(6,6,9,0.9)" : "rgba(14,15,17,0.85)");
      ctx.fillStyle = disc;
      ctx.fillRect(0, 0, w, h);

      const here = s.frame.lapDistPct;
      const i0 = indexAt(mv, here);
      const step = Math.max(1, Math.round(n * (20 / mv.lengthM)));
      const ia = (i0 + step) % n;
      const ib = (i0 - step + n) % n;
      const heading = Math.atan2(mv.y[ia] - mv.y[ib], mv.x[ia] - mv.x[ib]);

      // The car slightly below centre, so more of the disc is road ahead.
      const ox = cx;
      const oy = cy + R * 0.25;
      const scale = (R * 1.1) / (AHEAD_M / metresPerUnit);
      const rot = -Math.PI / 2 - heading;
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const projectIdx = (i) => {
        const dx = mv.x[i] - mv.x[i0];
        const dy = mv.y[i] - mv.y[i0];
        return [ox + (dx * cos - dy * sin) * scale, oy + (dx * sin + dy * cos) * scale];
      };

      // The whole circuit, clipped by the disc. Drawing only the stretch near
      // the car BY LAP DISTANCE made road that is close on the ground but far
      // round the lap — the other side of a hairpin, a parallel straight —
      // pop in and out as it came within range.
      const path = new Path2D();
      for (let i = 0; i < n; i++) {
        const [x, y] = projectIdx(i);
        if (i === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      }
      path.closePath();
      road(ctx, path, 11 * r, r);

      const inView = (x, y) => Math.hypot(x - cx, y - cy) < R + 10 * r;
      drawCars(ctx, s, (p) => projectIdx(indexAt(mv, p)), r, inView);
      ctx.restore();
    },
  };
}
