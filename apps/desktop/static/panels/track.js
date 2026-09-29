// Track panels — the circuit, and where everyone is on it.
//
// No card behind either: a grey road with a soft glow, straight over the sim,
// and every car as a badge carrying its position in its class colour.
//
// The centreline shares the pct grid with everything else (§4.1.1), so a lap
// position is an index into it with no lookup to do — for the player and, off
// the race channel, for every other car too.

import { $, alpha, COLORS, fit, html, setText, wrap01 } from "./util.js";

const PAD = 16;

const indexAt = (map, p) => Math.min(map.x.length - 1, Math.floor(wrap01(p) * map.x.length));

const font = () => getComputedStyle(document.body).fontFamily;

/** The road: a dark glow, then a light grey surface. Holds over any sky. */
function road(ctx, path, width, r) {
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.75)";
  ctx.shadowBlur = 10 * r;
  ctx.strokeStyle = "rgba(40,42,46,0.9)";
  ctx.lineWidth = width + 3 * r;
  ctx.stroke(path);
  ctx.restore();
  ctx.strokeStyle = "rgba(200,202,206,0.95)";
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
  ctx.beginPath();
  ctx.arc(x, y, R, 0, Math.PI * 2);
  ctx.fillStyle = colour;
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.55)";
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
  let me = null;
  for (const car of s.race?.cars ?? []) {
    if (car.onPitRoad) continue;
    if (car.isPlayer) {
      me = car;
      continue;
    }
    const [x, y] = project(car.lapDistPct);
    if (inView(x, y)) badge(ctx, x, y, String(pos.get(car.carIdx) ?? ""), car.classColor, r);
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

      ctx.clearRect(0, 0, w, h);
      road(ctx, path, 4.5 * r, r);

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
      for (const note of mv.notes) {
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
      const disc = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R);
      disc.addColorStop(0, "rgba(70,74,80,0.55)");
      disc.addColorStop(1, "rgba(14,15,17,0.85)");
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

      // Enough of the lap either side to leave the disc on both edges.
      const span = Math.round(((AHEAD_M * 2.5) / mv.lengthM) * n);
      const path = new Path2D();
      for (let k = -span; k <= span; k++) {
        const [x, y] = projectIdx((i0 + k + n * 4) % n);
        if (k === -span) path.moveTo(x, y);
        else path.lineTo(x, y);
      }
      road(ctx, path, 11 * r, r);

      const inView = (x, y) => Math.hypot(x - cx, y - cy) < R + 10 * r;
      drawCars(ctx, s, (p) => projectIdx(indexAt(mv, p)), r, inView);
      ctx.restore();
    },
  };
}
