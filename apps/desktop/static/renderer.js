// Overlay mode is signalled by the query string main loads the page with,
// so one document serves both the desktop window and the overlay.
const isOverlay = new URLSearchParams(location.search).get("overlay") === "1";
if (isOverlay) document.body.classList.add("overlay");

window.exxeed?.onEditMode((editing) => {
  document.body.classList.toggle("editing", editing === true);
});

const cell = (id) => document.getElementById(id);
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
  cell("clips").textContent = String(decoded.size);
});

const log = (text, className) => {
  const list = cell("log");
  const item = document.createElement("li");
  item.textContent = text;
  item.className = className;
  list.prepend(item);
  while (list.children.length > 14) list.lastChild.remove();
};

window.exxeed?.onAudioPlay((command) => {
  const buffer = decoded.get(command.key);
  if (buffer === undefined) {
    log(`${command.key} (no clip)`, "drop");
    return;
  }
  if (context.state === "suspended") void context.resume();

  const node = context.createBufferSource();
  node.buffer = buffer;
  node.connect(context.destination);
  node.start();
  log(command.key, "play");
});

window.exxeed?.onStateFrame((f) => {
  frames++;
  // Stashed, not drawn. The rAF loop above owns the canvas (§7.0).
  latest = f;
  cell("source").textContent = f.sourceName ?? "—";
  cell("lapDistPct").textContent = fixed(f.lapDistPct, 5);
  cell("speedMps").textContent = fixed(f.speedMps, 2);
  cell("speedKph").textContent = fixed(f.speedMps * 3.6, 1);
  cell("throttle").textContent = fixed(f.throttle, 2);
  cell("brake").textContent = fixed(f.brake, 2);
  cell("gear").textContent = String(f.gear ?? "—");

  // M0b reads this off a real lap to pin the sign convention (§5). Shown
  // with an explicit sign so "which way is left" is answerable on sight.
  const steer = cell("steerRad");
  steer.textContent =
    typeof f.steerRad === "number"
      ? `${f.steerRad >= 0 ? "+" : ""}${f.steerRad.toFixed(4)} rad`
      : "—";

  const populated = typeof f.lat === "number" && (f.lat !== 0 || f.lon !== 0);
  cell("latlon").textContent = populated
    ? `${f.lat.toFixed(5)}, ${f.lon.toFixed(5)}`
    : "not populated";
  cell("lap").textContent = String(f.lap ?? "—");
  cell("frames").textContent = String(frames);
  cell("queued").textContent = f.queuedNoteIds?.length
    ? f.queuedNoteIds.join(", ")
    : "—";

  const suppressed = cell("suppressed");
  suppressed.textContent = f.suppressedBy ?? "—";
  suppressed.className = f.suppressedBy ? "quiet" : "";
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
  cell("map-name").textContent = `${view.trackName}${view.configName ? ` — ${view.configName}` : ""}`;
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
