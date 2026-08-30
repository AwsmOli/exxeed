// Overlay mode is signalled by the query string main loads the page with,
// so one document serves both the desktop window and the overlay.
const params = new URLSearchParams(location.search);
const isOverlay = params.get("overlay") === "1";
if (isOverlay) document.body.classList.add("overlay");

// An overlay window shows one panel. Removing the others rather than hiding them
// means every draw routine's "is my element there?" guard does the rest — no
// panel-aware branching anywhere below.
const panel = params.get("panel");
if (panel !== null) {
  document.body.classList.add(`panel-${panel}`);
  for (const section of document.querySelectorAll("[data-panel]")) {
    if (section.getAttribute("data-panel") !== panel) section.remove();
  }
}

// Grabbable from the moment the window opens, matching main: overlays are not
// click-through unless asked to be. Starting this false meant a fresh overlay
// ignored every drag until the shortcut had been pressed once, which is the
// behaviour this replaced.
let editing = true;
document.body.classList.add("editing");

window.exxeed?.onEditMode((on) => {
  editing = on === true;
  document.body.classList.toggle("editing", editing);
});

// ---------------------------------------------------------------------------
// Dragging
//
// `movementX`/`movementY` — how far the POINTER moved — rather than any position.
// Both `clientX` and `screenX` are derived from the window's own origin, so
// while the window is being dragged they feed its movement back into the next
// delta. Measured: a 530px drag using screenX moved the window 577px, about 9%
// of overshoot, which feels like the panel sliding out from under the cursor.
// Pointer deltas have no such coupling and track exactly.
//
// Done here rather than with -webkit-app-region because that swallows every
// mouse event in its region — no click/drag distinction, no cursor of our own,
// and inconsistent behaviour on transparent frameless windows.
// ---------------------------------------------------------------------------

let dragging = false;

document.addEventListener("mousedown", (event) => {
  if (!editing || event.button !== 0) return;
  dragging = true;
  document.body.classList.add("dragging");
  event.preventDefault();
});

document.addEventListener("mousemove", (event) => {
  if (!dragging) return;

  // The button state, not a blur or a mouseleave: moving a window can blur it,
  // and the pointer leaving a small overlay mid-drag is normal. Either as an
  // end-of-drag signal would strand the panel after one step.
  if (event.buttons === 0) {
    endDrag();
    return;
  }

  const dx = event.movementX;
  const dy = event.movementY;
  if (dx === 0 && dy === 0) return;

  window.exxeed?.moveWindow(dx, dy);
});

function endDrag() {
  dragging = false;
  document.body.classList.remove("dragging");
}
document.addEventListener("mouseup", endDrag);

const cell = (id) => document.getElementById(id);

/**
 * Set an element's text, if it is here at all.
 *
 * Every overlay window shows one panel and removes the rest, so most of these
 * ids are absent in any given window. Guarding at the setter keeps the update
 * handlers panel-agnostic — they describe the whole state and whatever is on
 * screen picks up its own part.
 */
const setText = (id, text) => {
  const el = cell(id);
  if (el !== null) el.textContent = text;
};

const setClass = (id, className) => {
  const el = cell(id);
  if (el !== null) el.className = className;
};
const fixed = (v, n) => (typeof v === "number" ? v.toFixed(n) : "—");

let frames = 0;
const context = new AudioContext();
const decoded = new Map();

// Decode once, at preload. §3 chose WAV over MP3 precisely so no decode
// happens at trigger time; doing it here rather than on play is the other
// half of that.
window.exxeed?.onAudioPreload(async (clips) => {
  for (const clip of clips) {
    try {
      const copy = new Uint8Array(clip.wav).buffer;
      decoded.set(clip.key, await context.decodeAudioData(copy));
    } catch (err) {
      console.error(`could not decode ${clip.key}`, err);
    }
  }
  setText("clips", String(decoded.size));
});

const log = (text, className) => {
  const list = cell("log");
  if (list === null) return;
  const item = document.createElement("li");
  item.textContent = text;
  item.className = className;
  list.prepend(item);
  while (list.children.length > 14) list.lastChild.remove();
};

window.exxeed?.onAudioPlay((command) => {
  const buffer = decoded.get(command.key);
  if (buffer === undefined) {
    log(`${command.key} — no clip rendered`, "drop");
    return;
  }
  if (context.state === "suspended") void context.resume();

  const node = context.createBufferSource();
  node.buffer = buffer;
  node.connect(context.destination);
  node.start();
});

// §7.3: what the engine decided, including what it withheld. A drop with its
// reason is the more useful half — "why was nothing said" is the question you
// actually have in the car.
window.exxeed?.onEngineEvent((e) => {
  const where = `${(e.dAheadM ?? 0).toFixed(0)}m`;
  if (e.kind === "play") {
    log(`${e.noteId} ${e.detail} · lead ${(e.leadM ?? 0).toFixed(0)}m`, "play");
  } else {
    log(`${e.noteId} dropped · ${e.detail} · ${where} out`, "drop");
  }
});

window.exxeed?.onStateFrame((f) => {
  frames++;
  // Stashed, not drawn. The rAF loop owns the canvas (§7.0).
  latest = f;
  if (typeof f.lapDistPct === "number") {
    history.push({ pct: f.lapDistPct, throttle: f.throttle ?? 0, brake: f.brake ?? 0 });
    if (history.length > HISTORY) history.shift();
  }
  setText("source", f.sourceName ?? "—");
  setText("lapDistPct", fixed(f.lapDistPct, 5));
  setText("speedMps", fixed(f.speedMps, 2));
  setText("speedKph", fixed(f.speedMps * 3.6, 1));
  setText("throttle", fixed(f.throttle, 2));
  setText("brake", fixed(f.brake, 2));
  setText("gear", String(f.gear ?? "—"));

  // M0b reads this off a real lap to pin the sign convention (§5). Shown
  // with an explicit sign so "which way is left" is answerable on sight.
  setText(
    "steerRad",
    typeof f.steerRad === "number"
      ? `${f.steerRad >= 0 ? "+" : ""}${f.steerRad.toFixed(4)} rad`
      : "—",
  );

  const populated = typeof f.lat === "number" && (f.lat !== 0 || f.lon !== 0);
  setText("latlon", populated
    ? `${f.lat.toFixed(5)}, ${f.lon.toFixed(5)}`
    : "not populated");
  setText("lap", String(f.lap ?? "—"));
  setText("frames", String(frames));
  setText("queued", f.queuedNoteIds?.length
    ? f.queuedNoteIds.join(", ")
    : "—");

  setText("suppressed", f.suppressedBy ?? "—");
  setClass("suppressed", f.suppressedBy ? "quiet" : "");
});


// ---------------------------------------------------------------------------
// Track map
//
// §7.0: a canvas must not re-render on telemetry. Nothing here goes through a
// framework — the map arrives once, the latest frame is stashed in a plain
// variable, and a requestAnimationFrame loop draws. The car moves at the
// display's rate, not the telemetry's, which is what you want: 60 Hz of state
// does not need 60 Hz of repainting to look smooth.
// ---------------------------------------------------------------------------

let mapView = null;
let latest = null;
let trackPath = null;

const canvas = cell("map");
const ctx = canvas?.getContext("2d") ?? null;

/** Rebuild the static outline. Only on resize or a new map — never per frame. */
const buildPath = (w, h, pad) => {
  const path = new Path2D();
  const sx = (i) => pad + mapView.x[i] * (w - pad * 2);
  const sy = (i) => pad + mapView.y[i] * (h - pad * 2);
  path.moveTo(sx(0), sy(0));
  for (let i = 1; i < mapView.x.length; i++) path.lineTo(sx(i), sy(i));
  path.closePath();
  return path;
};

const fitCanvas = () => {
  if (canvas === null) return;
  const ratio = window.devicePixelRatio || 1;
  const box = canvas.getBoundingClientRect();
  canvas.width = Math.round(box.width * ratio);
  canvas.height = Math.round(box.height * ratio);
  trackPath = mapView === null ? null : buildPath(canvas.width, canvas.height, 14 * ratio);
};

window.exxeed?.onMap((view) => {
  mapView = view;
  setText("map-name", `${view.trackName}${view.configName ? ` — ${view.configName}` : ""}`);
  canvas?.classList.add("ready");
  fitCanvas();
});

window.addEventListener("resize", fitCanvas);

const draw = () => {
  requestAnimationFrame(draw);
  if (ctx === null || canvas === null) return;

  const ratio = window.devicePixelRatio || 1;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (mapView === null || trackPath === null) return;

  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.lineWidth = 3 * ratio;
  ctx.lineJoin = "round";
  ctx.stroke(trackPath);

  const at = (i) => [
    14 * ratio + mapView.x[i] * (w - 28 * ratio),
    14 * ratio + mapView.y[i] * (h - 28 * ratio),
  ];

  // Where each note speaks. Seeing them sit on the corners is the quickest
  // check that a note set and a map agree about the same track.
  ctx.fillStyle = "rgba(88,166,255,0.85)";
  for (const note of mapView.notes) {
    const [x, y] = at(note.index);
    ctx.beginPath();
    ctx.arc(x, y, 2.6 * ratio, 0, Math.PI * 2);
    ctx.fill();
  }

  const [sfx, sfy] = at(mapView.startIndex);
  ctx.fillStyle = "rgba(240,136,62,0.9)";
  ctx.fillRect(sfx - 2.5 * ratio, sfy - 2.5 * ratio, 5 * ratio, 5 * ratio);

  if (latest === null || typeof latest.lapDistPct !== "number") return;

  // The car. Index straight off lapDistPct — the centreline shares the pct grid
  // with everything else (§4.1.1), so there is no lookup to do.
  const n = mapView.x.length;
  const i = Math.min(n - 1, Math.floor(((latest.lapDistPct % 1) + 1) % 1 * n));
  const [cx, cy] = at(i);

  ctx.fillStyle = latest.suppressedBy ? "#f0883e" : "#7ee787";
  ctx.beginPath();
  ctx.arc(cx, cy, 4.5 * ratio, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.55)";
  ctx.lineWidth = 1.5 * ratio;
  ctx.stroke();
};

requestAnimationFrame(draw);

// ---------------------------------------------------------------------------
// Input trace vs reference (§7.1) and the delta bar (§7.2)
//
// Same discipline as the map: the reference arrives once, the latest frame sits
// in a plain variable, and one requestAnimationFrame loop draws. Nothing here is
// reactive, which is what §7.0 is asking for — it just does not need a framework
// to say so.
//
// The live trace is kept as a ring of recent samples. The reference needs no
// history: it is already on the pct grid (§4.3), so drawing it beside the live
// trace is an index lookup with no time alignment.
// ---------------------------------------------------------------------------

let reference = null;
const history = [];
const HISTORY = 2400; // ~75 s at 32 Hz, comfortably more than one window

/** §7.1: a rolling window of ±8% of the lap around the current position. */
const WINDOW_PCT = 0.08;

const traceCanvas = cell("trace");
const traceCtx = traceCanvas?.getContext("2d") ?? null;

window.exxeed?.onReference((view) => {
  reference = view;
  traceCanvas?.classList.add("ready");
  setText("ref-name", `reference — car ${view.carId}, ${view.lapTimeS.toFixed(3)}s`);
  fitTrace();
});

const fitTrace = () => {
  if (traceCanvas === null) return;
  const ratio = window.devicePixelRatio || 1;
  const box = traceCanvas.getBoundingClientRect();
  traceCanvas.width = Math.round(box.width * ratio);
  traceCanvas.height = Math.round(box.height * ratio);
};
window.addEventListener("resize", fitTrace);

/** Signed distance in pct, −0.5..0.5, so the window works across start/finish. */
const pctDelta = (a, b) => (((a - b + 1.5) % 1) - 0.5);

const drawTrace = () => {
  if (traceCtx === null || traceCanvas === null || reference === null) return;

  const ratio = window.devicePixelRatio || 1;
  const w = traceCanvas.width;
  const h = traceCanvas.height;
  traceCtx.clearRect(0, 0, w, h);

  if (latest === null || typeof latest.lapDistPct !== "number") return;
  const here = latest.lapDistPct;

  // x maps a lap position onto the window; the car sits at 75% across, so most
  // of the panel is the road behind and a glance of what is coming.
  const x = (p) => {
    const d = pctDelta(p, here);
    return (0.75 + d / (WINDOW_PCT * 2)) * w;
  };
  const yFor = (v, top, height) => top + (1 - v) * height;

  const padTop = 6 * ratio;
  const laneH = (h - padTop * 3) / 2;
  const throttleTop = padTop;
  const brakeTop = padTop * 2 + laneH;

  // Corner guides, faint, behind everything.
  traceCtx.strokeStyle = "rgba(255,255,255,0.10)";
  traceCtx.lineWidth = 1 * ratio;
  for (const c of reference.corners) {
    for (const p of [c.entryPct, c.apexPct, c.exitPct]) {
      if (Math.abs(pctDelta(p, here)) > WINDOW_PCT) continue;
      traceCtx.beginPath();
      traceCtx.moveTo(x(p), padTop);
      traceCtx.lineTo(x(p), h - padTop);
      traceCtx.stroke();
    }
  }

  // Where the reference started braking. §7.1 calls seeing your own trace start
  // after this marker the most legible feedback in the app, so it is drawn last
  // of the background and brightest of it.
  traceCtx.strokeStyle = "rgba(240,136,62,0.75)";
  traceCtx.lineWidth = 1.5 * ratio;
  for (const p of reference.brakeOnsetPcts) {
    if (Math.abs(pctDelta(p, here)) > WINDOW_PCT) continue;
    traceCtx.beginPath();
    traceCtx.moveTo(x(p), brakeTop);
    traceCtx.lineTo(x(p), brakeTop + laneH);
    traceCtx.stroke();
  }

  const n = reference.gridSize;
  const drawReference = (channel, top, colour) => {
    traceCtx.strokeStyle = colour;
    traceCtx.lineWidth = 1.5 * ratio;
    traceCtx.beginPath();
    let started = false;
    for (let step = -60; step <= 60; step++) {
      const p = ((here + (step / 60) * WINDOW_PCT) % 1 + 1) % 1;
      const v = channel[Math.min(n - 1, Math.floor(p * n))];
      if (typeof v !== "number") continue;
      const px = x(p);
      const py = yFor(v, top, laneH);
      if (started) traceCtx.lineTo(px, py);
      else { traceCtx.moveTo(px, py); started = true; }
    }
    traceCtx.stroke();
  };

  // Ghosted behind: the reference.
  drawReference(reference.throttle, throttleTop, "rgba(126,231,135,0.32)");
  drawReference(reference.brake, brakeTop, "rgba(248,113,113,0.32)");

  const drawLive = (pick, top, colour) => {
    traceCtx.strokeStyle = colour;
    traceCtx.lineWidth = 2 * ratio;
    traceCtx.beginPath();
    let started = false;
    for (const s of history) {
      if (Math.abs(pctDelta(s.pct, here)) > WINDOW_PCT) continue;
      const px = x(s.pct);
      const py = yFor(pick(s), top, laneH);
      if (started) traceCtx.lineTo(px, py);
      else { traceCtx.moveTo(px, py); started = true; }
    }
    traceCtx.stroke();
  };

  drawLive((s) => s.throttle, throttleTop, "#7ee787");
  drawLive((s) => s.brake, brakeTop, "#f87171");

  // The car's position in the window.
  traceCtx.strokeStyle = "rgba(255,255,255,0.35)";
  traceCtx.lineWidth = 1 * ratio;
  traceCtx.beginPath();
  traceCtx.moveTo(x(here), padTop);
  traceCtx.lineTo(x(here), h - padTop);
  traceCtx.stroke();
};

const drawNext = () => {
  const out = cell("next-note");
  if (out === null) return;
  if (mapView === null || latest === null || typeof latest.lapDistPct !== "number") {
    out.textContent = "—";
    return;
  }

  const n = mapView.x.length;
  const armed = new Set(latest.armedNoteIds ?? []);
  let best = null;

  for (const note of mapView.notes) {
    // Always positive, the long way round if need be (§4.6) — which is exactly
    // what "next" means here.
    const ahead = ((note.index - Math.floor(latest.lapDistPct * n)) % n + n) % n;
    if (best === null || ahead < best.ahead) best = { ...note, ahead };
  }

  if (best === null) { out.textContent = "—"; return; }
  const metres = (best.ahead / n) * mapView.lengthM;
  out.textContent = `${best.id} · ${metres.toFixed(0)}m · ${armed.has(best.id) ? "armed" : "spent"}`;
};

const drawDelta = () => {
  const bar = cell("delta-fill");
  const text = cell("delta-text");
  if (bar === null || text === null) return;

  const d = latest?.deltaS;
  if (typeof d !== "number") {
    bar.style.width = "0%";
    text.textContent = latest?.lapElapsedS == null ? "waiting for a lap" : "—";
    text.className = "";
    return;
  }

  // ±2 s fills the bar. Beyond that the number matters more than the length.
  const clamped = Math.max(-2, Math.min(2, d));
  bar.style.width = `${(Math.abs(clamped) / 2) * 50}%`;
  bar.style.left = d < 0 ? `${50 - (Math.abs(clamped) / 2) * 50}%` : "50%";
  bar.className = d < 0 ? "up" : "down";
  text.textContent = `${d >= 0 ? "+" : ""}${d.toFixed(2)}s`;
  text.className = d < 0 ? "up" : "down";
};

requestAnimationFrame(function paint() {
  requestAnimationFrame(paint);
  drawTrace();
  drawDelta();
  drawNext();
});
