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
