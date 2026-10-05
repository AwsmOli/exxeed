// Traces from a guide video — experimental (src/video-traces.ts).
//
// The video plays in a <video>; every frame it presents is drawn onto small
// canvases, one per box, and measured there: how lit each line across a bar
// is, and how much the line box changed since the frame before. No image
// library — Chromium decodes the video, and a bar's fill is counting pixels.

const el = (id) => document.getElementById(id);

const call = async (request) => {
  const response = await window.exxeed.videoTraces(request);
  if (!response.ok) throw new Error(response.error);
  return response.value;
};

const setStatus = (id, text, tone = "") => {
  el(id).textContent = text;
  el(id).className = `status small${tone ? ` ${tone}` : ""}`;
};

const COLOURS = { pedals: "#e3b341", line: "#58a6ff" };
const LABELS = { pedals: "pedal bars", line: "line" };

const state = {
  /** Boxes in the video's own pixels: { x, y, w, h }. */
  boxes: { pedals: null, line: null },
  /** Where the bars were found in the pedal box, and each frame's fills (from main). */
  calibration: null,
  samples: [],
  drawing: null,
  drag: null,
  changes: [],
  reading: false,
  /** Seconds at which the line box changed suddenly. */
  crossings: [],
  built: null,
  fps: 30,
};

// For a look in the developer tools: what was read and found.
window.tracer = state;

const video = el("video");
const overlay = el("boxes");

// ---------------------------------------------------------------------------
// The video
// ---------------------------------------------------------------------------

const fmt = (s) => {
  if (!Number.isFinite(s)) return "—";
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(3).padStart(6, "0")}`;
};

video.addEventListener("loadedmetadata", () => {
  el("stage").hidden = false;
  el("transport").hidden = false;
  drawBoxes();
  updateButtons();
});
video.addEventListener("timeupdate", () => (el("time").textContent = fmt(video.currentTime)));
video.addEventListener("seeked", () => (el("time").textContent = fmt(video.currentTime)));
video.addEventListener("play", () => (el("play").textContent = "Pause"));
video.addEventListener("pause", () => (el("play").textContent = "Play"));

el("play").addEventListener("click", () => (video.paused ? void video.play() : video.pause()));
for (const b of document.querySelectorAll("[data-step]")) {
  b.addEventListener("click", () => (video.currentTime = Math.max(0, video.currentTime + Number(b.dataset.step))));
}
for (const b of document.querySelectorAll("[data-frame]")) {
  b.addEventListener("click", () => {
    video.pause();
    video.currentTime = Math.max(0, video.currentTime + Number(b.dataset.frame) / state.fps);
  });
}

// ---------------------------------------------------------------------------
// Boxes: drag on the video, kept in the video's own pixels
// ---------------------------------------------------------------------------

/** Client → video pixels. The video is drawn at its own aspect, so it is a plain scale. */
function toVideo(e) {
  const r = overlay.getBoundingClientRect();
  return {
    x: ((e.clientX - r.left) / r.width) * video.videoWidth,
    y: ((e.clientY - r.top) / r.height) * video.videoHeight,
  };
}

function drawBoxes() {
  const r = overlay.getBoundingClientRect();
  overlay.width = Math.round(r.width * devicePixelRatio);
  overlay.height = Math.round(r.height * devicePixelRatio);
  const g = overlay.getContext("2d");
  g.clearRect(0, 0, overlay.width, overlay.height);
  const sx = overlay.width / (video.videoWidth || 1);
  const sy = overlay.height / (video.videoHeight || 1);
  const all = { ...state.boxes, ...(state.drag ? { [state.drawing]: state.drag } : {}) };
  for (const [name, b] of Object.entries(all)) {
    if (b === null) continue;
    g.strokeStyle = COLOURS[name];
    g.lineWidth = 2 * devicePixelRatio;
    g.strokeRect(b.x * sx, b.y * sy, b.w * sx, b.h * sy);
    g.fillStyle = COLOURS[name];
    g.font = `${11 * devicePixelRatio}px system-ui`;
    g.fillText(LABELS[name], b.x * sx, b.y * sy - 4 * devicePixelRatio);
  }
  // What the read found: each bar, and the rows it counts as empty and full.
  const cal = state.calibration;
  const box = state.boxes.pedals;
  if (cal !== null && box !== null) {
    const y = (row) => (box.y + row) * sy;
    for (const [bar, colour] of [[cal.throttle, "#3fb950"], [cal.brake, "#f85149"]]) {
      if (bar === null) continue;
      g.strokeStyle = colour;
      g.setLineDash([3 * devicePixelRatio, 2 * devicePixelRatio]);
      g.strokeRect((box.x + bar.x0) * sx, y(cal.top), (bar.x1 - bar.x0 + 1) * sx, y(cal.bottom + 1) - y(cal.top));
      g.setLineDash([]);
    }
  }
}
window.addEventListener("resize", drawBoxes);

for (const b of document.querySelectorAll("[data-box]")) {
  b.addEventListener("click", () => {
    state.drawing = state.drawing === b.dataset.box ? null : b.dataset.box;
    for (const o of document.querySelectorAll("[data-box]")) o.classList.toggle("on", o.dataset.box === state.drawing);
    if (state.drawing !== null) video.pause();
  });
}

overlay.addEventListener("mousedown", (e) => {
  if (state.drawing === null) return;
  const p = toVideo(e);
  state.drag = { x: p.x, y: p.y, w: 0, h: 0, from: p };
});
window.addEventListener("mousemove", (e) => {
  if (state.drag === null) return;
  const p = toVideo(e);
  const f = state.drag.from;
  state.drag = { x: Math.min(f.x, p.x), y: Math.min(f.y, p.y), w: Math.abs(p.x - f.x), h: Math.abs(p.y - f.y), from: f };
  drawBoxes();
});
window.addEventListener("mouseup", () => {
  if (state.drag === null) return;
  const { x, y, w, h } = state.drag;
  state.drag = null;
  if (w >= 3 && h >= 3) {
    state.boxes[state.drawing] = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
    state.drawing = null;
    for (const o of document.querySelectorAll("[data-box]")) o.classList.remove("on");
  }
  drawBoxes();
  updateButtons();
});

// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------

/** A canvas the size of a box, to copy it out of the frame and read its pixels. */
function grabber(box) {
  const c = document.createElement("canvas");
  c.width = box.w;
  c.height = box.h;
  return { box, g: c.getContext("2d", { willReadFrequently: true }) };
}

/** The fill colours: throttle bright green, brake bright red. The scene seen through a see-through overlay is too dim to pass. */
const isGreen = (r, g, b) => g > 150 && g - r > 70 && g - b > 50;
const isRed = (r, g, b) => r > 150 && r - g > 80 && r - b > 70;

/**
 * Per column of the pedal box, the lit run from the bottom up, for green and
 * for red: the row it starts on and the row it reaches (0 at the top), −1
 * for none. A row or two of video noise inside a run does not end it.
 * Appended to `out` as [green bottom, green top, red bottom, red top].
 */
function pedalRuns(grab, out) {
  const { box, g } = grab;
  g.drawImage(video, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
  const d = g.getImageData(0, 0, box.w, box.h).data;
  const run = (x, test) => {
    let bot = -1;
    let top = -1;
    let gap = 0;
    for (let y = box.h - 1; y >= 0; y--) {
      const k = (y * box.w + x) * 4;
      if (test(d[k], d[k + 1], d[k + 2])) {
        if (bot < 0) bot = y;
        top = y;
        gap = 0;
      } else if (bot >= 0 && ++gap > 2) {
        break;
      }
    }
    return [bot, top];
  };
  for (let x = 0; x < box.w; x++) out.push(...run(x, isGreen), ...run(x, isRed));
}

/** The line box, small and grey, to compare with the frame before. */
function lineSnapshot(grab) {
  const { box, g } = grab;
  g.drawImage(video, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
  const d = g.getImageData(0, 0, box.w, box.h).data;
  const grey = new Float32Array(box.w * box.h);
  for (let i = 0; i < grey.length; i++) grey[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3;
  return grey;
}

const meanDiff = (a, b) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length / 255;
};

async function read() {
  if (state.reading) return;
  const { pedals, line } = state.boxes;
  state.reading = true;
  state.calibration = null;
  state.samples = [];
  state.changes = [];
  const times = [];
  const runs = [];
  const grabs = { pedals: grabber(pedals), line: line ? grabber(line) : null };
  let previous = null;
  let lastT = -1;
  el("progress").hidden = false;
  el("stop").hidden = false;
  el("read").disabled = true;
  setStatus("read-status", "Reading…");

  const done = new Promise((resolve) => {
    // After the last frame no callback comes: the end (or a pause, or Stop) is
    // heard from the video itself.
    video.addEventListener("ended", () => resolve(), { once: true });
    video.addEventListener("pause", () => resolve(), { once: true });
    const onFrame = (_now, meta) => {
      if (!state.reading) return resolve();
      const t = meta.mediaTime;
      if (t > lastT) {
        if (lastT >= 0 && t - lastT > 0) state.fps = Math.max(state.fps, Math.min(120, Math.round(1 / (t - lastT))));
        lastT = t;
        times.push(t);
        pedalRuns(grabs.pedals, runs);
        if (grabs.line !== null) {
          const snap = lineSnapshot(grabs.line);
          if (previous !== null) state.changes.push({ t, diff: meanDiff(snap, previous) });
          previous = snap;
        }
        el("progress").value = video.currentTime / video.duration;
      }
      if (video.ended || video.paused) return resolve();
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  });
  // Twice the speed: Chromium still hands over (nearly) every frame of a 30 fps video.
  video.playbackRate = 2;
  await video.play();
  await done;
  video.pause();
  video.playbackRate = 1;
  state.reading = false;
  el("stop").hidden = true;
  el("progress").hidden = true;
  // Where the bars are and what full is, from the whole read; then each frame's fills.
  const result = await call({
    op: "calibrate",
    width: pedals.w,
    height: pedals.h,
    times: Float64Array.from(times),
    runs: Int16Array.from(runs),
  });
  state.calibration = result.calibration;
  state.samples = result.samples;
  drawBoxes();
  const found = [result.calibration.throttle && "throttle", result.calibration.brake && "brake"].filter(Boolean);
  setStatus(
    "read-status",
    `Read ${times.length} frames, ${fmt(times[0] ?? 0)} to ${fmt(lastT)}. ` +
      (found.length === 2
        ? "Found both bars — dashed on the video."
        : `Found ${found.length === 0 ? "neither bar" : `only the ${found[0]} bar`}: draw the box round both, and read a stretch with some braking.`),
    found.length === 2 ? "good" : "bad",
  );
  await showCrossings();
  updateButtons();
}

el("read").addEventListener("click", () => void read().catch((err) => setStatus("read-status", err.message, "bad")));
el("stop").addEventListener("click", () => {
  state.reading = false;
  video.pause();
});

// ---------------------------------------------------------------------------
// The lap: crossings found, or times set by hand
// ---------------------------------------------------------------------------

async function showCrossings() {
  const list = el("crossings");
  list.replaceChildren();
  if (state.changes.length === 0) {
    list.append(Object.assign(document.createElement("li"), { className: "muted small", textContent: "No line box: set the start and end by hand — pause on the frame and press Now." }));
    return;
  }
  const times = await call({ op: "crossings", changes: state.changes });
  if (times.length === 0) {
    list.append(Object.assign(document.createElement("li"), { className: "muted small", textContent: "No clear change found in the line box. Set the lap by hand." }));
    return;
  }
  times.forEach((t, i) => {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `${fmt(t)}${i > 0 ? `  (lap ${fmt(t - times[i - 1])})` : ""}`;
    const go = Object.assign(document.createElement("button"), { type: "button", textContent: "Go" });
    go.addEventListener("click", () => {
      video.pause();
      video.currentTime = t;
    });
    const asStart = Object.assign(document.createElement("button"), { type: "button", textContent: "Start" });
    asStart.addEventListener("click", () => setLap("start", t));
    const asEnd = Object.assign(document.createElement("button"), { type: "button", textContent: "End" });
    asEnd.addEventListener("click", () => setLap("end", t));
    li.append(label, go, asStart, asEnd);
    list.append(li);
  });
  state.crossings = times;
  guessLap();
}

/** The reference lap's time for the chosen track and car, or null. */
const targetLapS = () => (el("target").value === "" ? null : JSON.parse(el("target").value).lapTimeS);

/**
 * The stretch between two crossings that most looks like a lap: the one
 * closest to the chosen reference lap's time, or — before one is chosen — to
 * the middle of the plausible ones. A guide's intro, cuts and replays make
 * crossings that are not the line; their gaps are far from a lap's length.
 */
function guessLap() {
  const times = state.crossings ?? [];
  const gaps = [];
  for (let i = 1; i < times.length; i++) gaps.push({ s: times[i - 1], e: times[i], d: times[i] - times[i - 1] });
  const plausible = gaps.filter((g) => g.d >= 30 && g.d <= 600);
  const items = [...el("crossings").children];
  items.forEach((li, i) => {
    const g = i > 0 ? gaps[i - 1] : null;
    li.style.opacity = g !== null && !plausible.includes(g) ? "0.45" : "";
  });
  if (plausible.length === 0) return;
  const target = targetLapS() ?? [...plausible].sort((a, b) => a.d - b.d)[Math.floor(plausible.length / 2)].d;
  const best = plausible.reduce((a, b) => (Math.abs(b.d - target) < Math.abs(a.d - target) ? b : a));
  setLap("start", best.s);
  setLap("end", best.e);
}

function setLap(which, t) {
  el(which).value = t.toFixed(3);
  if (which === "start") applyLapTime();
  updateButtons();
}
el("start-here").addEventListener("click", () => setLap("start", video.currentTime));
el("end-here").addEventListener("click", () => setLap("end", video.currentTime));
el("start").addEventListener("input", () => {
  applyLapTime();
  updateButtons();
});
/** "1:21.310" or "81.31" → seconds, or null. */
const parseLapTime = (text) => {
  const m = /^\s*(?:(\d+):)?(\d+(?:\.\d+)?)\s*$/.exec(text);
  return m === null ? null : Number(m[1] ?? 0) * 60 + Number(m[2]);
};
/**
 * A lap time typed from the video's own overlay is exact; the line box's
 * change can trail the line by a fraction of a second. With one, the end is
 * the start plus it.
 */
function applyLapTime() {
  const lap = parseLapTime(el("laptime").value);
  const start = Number(el("start").value);
  if (lap === null || !(lap > 0) || el("start").value === "") return;
  el("end").value = (start + lap).toFixed(3);
}
el("laptime").addEventListener("input", () => {
  applyLapTime();
  updateButtons();
});
el("end").addEventListener("input", updateButtons);

// ---------------------------------------------------------------------------
// Build and save
// ---------------------------------------------------------------------------

function lapTimes() {
  const s = Number(el("start").value);
  const e = Number(el("end").value);
  return el("start").value !== "" && el("end").value !== "" && e > s ? { s, e } : null;
}

function updateButtons() {
  el("read").disabled = state.reading || video.readyState < 1 || state.boxes.pedals === null;
  const lap = lapTimes();
  const covered = lap !== null && state.samples.length > 0 && state.samples[0].t <= lap.s + 0.5 && state.samples.at(-1).t >= lap.e - 0.5;
  el("build").disabled = !covered || el("target").value === "";
  el("build").title = lap !== null && !covered ? "Read the video over the whole lap first" : "";
  el("save").disabled = state.built === null;
}
el("target").addEventListener("change", () => {
  guessLap();
  updateButtons();
});

el("build").addEventListener("click", async () => {
  const lap = lapTimes();
  const target = JSON.parse(el("target").value);
  setStatus("build-status", "Building…");
  try {
    // Only the lap's frames, and a little either side.
    const samples = state.samples.filter((f) => f.t >= lap.s - 1 && f.t <= lap.e + 1);
    state.built = await call({ op: "build", trackKey: target.trackKey, carId: target.carId, lapStartS: lap.s, lapEndS: lap.e, samples });
    setStatus("build-status", state.built.summary, "good");
    drawChart(state.built);
  } catch (err) {
    state.built = null;
    setStatus("build-status", err.message, "bad");
  }
  updateButtons();
});

el("save").addEventListener("click", async () => {
  if (state.built === null) return;
  if (el("save").dataset.armed !== "1") {
    el("save").dataset.armed = "1";
    el("save").textContent = "Replace the reference?";
    return;
  }
  delete el("save").dataset.armed;
  el("save").textContent = "Save as reference";
  try {
    setStatus("build-status", await call({ op: "save", token: state.built.token }), "good");
    state.built = null;
  } catch (err) {
    setStatus("build-status", err.message, "bad");
  }
  updateButtons();
});

/** Throttle and brake by lap position: the current reference faint, the video's bright. */
function drawChart(b) {
  const c = el("chart");
  const r = c.getBoundingClientRect();
  c.width = Math.round(r.width * devicePixelRatio);
  c.height = Math.round(r.height * devicePixelRatio);
  const g = c.getContext("2d");
  const w = c.width;
  const h = c.height;
  const pad = 6 * devicePixelRatio;
  g.clearRect(0, 0, w, h);
  const line = (values, colour, width) => {
    g.beginPath();
    values.forEach((v, i) => {
      const x = pad + (i / (values.length - 1)) * (w - pad * 2);
      const y = h - pad - v * (h - pad * 2);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    });
    g.strokeStyle = colour;
    g.lineWidth = width * devicePixelRatio;
    g.stroke();
  };
  line(b.base.throttle, "rgba(63, 185, 80, 0.35)", 1);
  line(b.base.brake, "rgba(248, 81, 73, 0.35)", 1);
  line(b.video.throttle, "#3fb950", 1.6);
  line(b.video.brake, "#f85149", 1.6);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function start() {
  const { video: chosen, targets } = await call({ op: "context" });
  if (chosen === null) {
    setStatus("status", "Open this from the importer, on a guide video.", "bad");
    return;
  }
  el("title").textContent = chosen.title;
  const select = el("target");
  select.replaceChildren(new Option(targets.length === 0 ? "No reference laps yet — import one first" : "Choose…", ""));
  for (const t of targets) {
    for (const car of t.cars) {
      select.append(new Option(`${t.label} — ${car.carId} (${fmt(car.lapTimeS)})`, JSON.stringify({ trackKey: t.trackKey, carId: car.carId, lapTimeS: car.lapTimeS })));
    }
  }
  setStatus("status", "Downloading the video… (once; it is kept for next time)");
  try {
    video.src = await call({ op: "download" });
    setStatus("status", "Pause where the overlay shows, then draw the boxes.");
  } catch (err) {
    setStatus("status", `The video could not be downloaded: ${err.message}`, "bad");
  }
}

void start();
