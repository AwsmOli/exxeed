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

const COLOURS = { pedals: "#e3b341", line: "#58a6ff", speed: "#d2a8ff", gear: "#79c0ff" };
const LABELS = { pedals: "pedal bars", line: "line", speed: "speed", gear: "gear" };
/** A digit's grid (core GLYPH_W × GLYPH_H, then its aspect). */
const GW = 10;
const GH = 14;

const state = {
  /** Boxes in the video's own pixels: { x, y, w, h }. */
  boxes: { pedals: null, line: null, speed: null, gear: null },
  /** Where the lap was marked, by a crossing or by hand; a typed lap time works from these. */
  marks: { start: null, end: null },
  /** The speed box's digits: their grids, which frame each is from, and the groups found. */
  glyphs: null,
  /** The same for the gear box. */
  gearGlyphs: null,
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
  /** The video this window is on: { id, title }. */
  video: null,
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

/**
 * The speed box's digits, left to right: lit pixels (bright — digits are
 * drawn light on a dark overlay) split into glyphs at empty columns, each
 * copied onto a GW × GH grid of how lit each cell is, with its width over height last. Specks and anything much
 * shorter than the tallest glyph (a decimal point, a unit) are left out.
 */
function speedGlyphs(grab, vectors) {
  const { box, g } = grab;
  g.drawImage(video, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
  const d = g.getImageData(0, 0, box.w, box.h).data;
  // `lit` finds the glyphs; `grey` is what is kept of them — at this size an
  // 8 and a 9 differ by a pixel or two of half-lit edge.
  const lit = new Uint8Array(box.w * box.h);
  const grey = new Float32Array(box.w * box.h);
  for (let i = 0; i < lit.length; i++) {
    const l = d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11;
    lit[i] = l > 150 ? 1 : 0;
    grey[i] = Math.max(0, Math.min(1, (l - 70) / 150));
  }
  // Only the tallest band of lit rows is the number: the foot of a label
  // above it, or the top of whatever is below, is cut off at the empty row between.
  let band = [0, -1];
  for (let y = 0; y < box.h; ) {
    let any = false;
    for (let x = 0; x < box.w && !any; x++) any = lit[y * box.w + x] === 1;
    if (!any) {
      y++;
      continue;
    }
    const y0 = y;
    for (any = true; y < box.h && any; ) {
      y++;
      any = false;
      for (let x = 0; y < box.h && x < box.w && !any; x++) any = lit[y * box.w + x] === 1;
    }
    if (y - y0 > band[1] - band[0] + 1) band = [y0, y - 1];
  }
  for (let y = 0; y < box.h; y++) if (y < band[0] || y > band[1]) lit.fill(0, y * box.w, (y + 1) * box.w);
  const colLit = (x) => {
    for (let y = 0; y < box.h; y++) if (lit[y * box.w + x]) return true;
    return false;
  };
  const spans = [];
  for (let x = 0; x < box.w; ) {
    if (!colLit(x)) {
      x++;
      continue;
    }
    const x0 = x;
    while (x < box.w && colLit(x)) x++;
    let y0 = box.h;
    let y1 = -1;
    for (let y = 0; y < box.h; y++) for (let xx = x0; xx < x; xx++) if (lit[y * box.w + xx]) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    spans.push({ x0, x1: x - 1, y0, y1 });
  }
  const tallest = Math.max(0, ...spans.map((s) => s.y1 - s.y0 + 1));
  const k = Math.max(1, tallest / GH);
  let count = 0;
  for (const s of spans) {
    const w = s.x1 - s.x0 + 1;
    const h = s.y1 - s.y0 + 1;
    if (h < tallest * 0.6 || w * h < 6) continue;
    // Pixel for pixel from the glyph's top-left corner (shrunk only when the
    // number is taller than the grid, and then all glyphs alike): stretching
    // each glyph to fit blurs the pixel or two that tell an 8 from a 9.
    for (let gy = 0; gy < GH; gy++) {
      for (let gx = 0; gx < GW; gx++) {
        const ax = s.x0 + Math.floor(gx * k);
        const bx = Math.min(s.x1 + 1, s.x0 + Math.max(Math.floor((gx + 1) * k), Math.floor(gx * k) + 1));
        const ay = s.y0 + Math.floor(gy * k);
        const by = Math.min(s.y1 + 1, s.y0 + Math.max(Math.floor((gy + 1) * k), Math.floor(gy * k) + 1));
        let on = 0;
        let all = 0;
        for (let y = ay; y < by; y++) for (let x = ax; x < bx; x++) { on += grey[y * box.w + x]; all++; }
        vectors.push(all === 0 ? 0 : on / all);
      }
    }
    vectors.push(Math.min(1, w / h));
    count++;
  }
  return count;
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

/** Read from where the video is to its end, or to `untilS`. */
async function read(untilS = null) {
  if (state.reading) return;
  const { pedals, line } = state.boxes;
  state.reading = true;
  state.calibration = null;
  state.samples = [];
  state.changes = [];
  state.crossings = [];
  state.built = null;
  const times = [];
  const runs = [];
  const speed = state.boxes.speed;
  const grabs = { pedals: grabber(pedals), line: line ? grabber(line) : null, speed: speed ? grabber(speed) : null };
  const gear = state.boxes.gear;
  const gearGrab = gear ? grabber(gear) : null;
  const glyphVectors = [];
  const glyphFrame = [];
  const gearVectors = [];
  const gearFrame = [];
  state.glyphs = null;
  state.gearGlyphs = null;
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
        if (grabs.speed !== null) {
          const n = speedGlyphs(grabs.speed, glyphVectors);
          for (let i = 0; i < n; i++) glyphFrame.push(times.length - 1);
        }
        if (gearGrab !== null) {
          const n = speedGlyphs(gearGrab, gearVectors);
          for (let i = 0; i < n; i++) gearFrame.push(times.length - 1);
        }
        if (grabs.line !== null) {
          const snap = lineSnapshot(grabs.line);
          if (previous !== null) state.changes.push({ t, diff: meanDiff(snap, previous) });
          previous = snap;
        }
        el("progress").value = video.currentTime / video.duration;
      }
      if (untilS !== null && t >= untilS) {
        video.pause();
        return resolve();
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
  if (grabs.speed !== null) await showDigits(READS.speed, Float64Array.from(times), Float32Array.from(glyphVectors), Int32Array.from(glyphFrame));
  if (gearGrab !== null) await showDigits(READS.gear, Float64Array.from(times), Float32Array.from(gearVectors), Int32Array.from(gearFrame));
  updateButtons();
}

/** The two numbers read by shape: where each one's tiles and status go, and what it is called. */
const READS = {
  speed: { key: "glyphs", section: "digits-section", tiles: "digits", status: "digits-status", what: "speed", names: "digits", then: "Read speeds" },
  gear: { key: "gearGlyphs", section: "gears-section", tiles: "gears", status: "gears-status", what: "gear", names: "gears (N for neutral)", then: "Read gears" },
};

/** A number box's shapes, grouped, for the person to name. */
async function showDigits(kind, times, vectors, glyphFrame) {
  el(kind.section).hidden = false;
  if (glyphFrame.length === 0) {
    setStatus(kind.status, `Nothing found in the ${kind.what} box: draw it round the ${kind.what} only, and read again.`, "bad");
    return;
  }
  const c = await call({ op: "clusterGlyphs", vectors });
  state[kind.key] = { times, glyphFrame, vectors, ids: c.ids, groups: c.centroids.length, centroids: c.centroids, counts: c.counts };
  el(kind.tiles).replaceChildren(
    ...c.centroids.map((centroid, i) => {
      const tile = Object.assign(document.createElement("div"), { className: "digit" });
      const canvas = document.createElement("canvas");
      canvas.width = GW;
      canvas.height = GH;
      const g = canvas.getContext("2d");
      const img = g.createImageData(GW, GH);
      for (let k = 0; k < GW * GH; k++) {
        const v = Math.round(centroid[k] * 255);
        img.data.set([v, v, v, 255], k * 4);
      }
      g.putImageData(img, 0, 0);
      const input = Object.assign(document.createElement("input"), { type: "text", maxLength: 1, inputMode: "numeric" });
      input.dataset.group = String(i);
      tile.append(canvas, input, Object.assign(document.createElement("span"), { textContent: `×${c.counts[i]}` }));
      return tile;
    }),
  );
  setStatus(kind.status, `${c.centroids.length} shapes. Name the ${kind.names}, then ${kind.then}.`);
}

/** What each group was named: a digit, "" to skip it, null if the tile was never shown. N is neutral, 0. */
function namedGroups(kind) {
  const gl = state[kind.key];
  const labels = Array.from({ length: Math.max(gl.groups, 1 + Math.max(0, ...gl.ids)) }, () => null);
  for (const input of el(kind.tiles).querySelectorAll("input")) {
    const v = input.value.trim().toLowerCase();
    labels[Number(input.dataset.group)] = /^\d$/.test(v) ? v : kind === READS.gear && v === "n" ? "0" : "";
  }
  return labels;
}

async function readSpeeds() {
  const gl = state.glyphs;
  if (gl === null) return;
  try {
    const speeds = await call({ op: "readSpeeds", times: gl.times, glyphFrame: gl.glyphFrame, ids: gl.ids, labels: namedGroups(READS.speed), mph: el("units").value === "mph" });
    const byTime = new Map();
    gl.times.forEach((t, i) => byTime.set(t, speeds[i]));
    state.samples = state.samples.map((s) => ({ ...s, speedKph: byTime.get(s.t) ?? null }));
    const read = speeds.filter((v) => v !== null).length;
    // Short of all of them is usual: the overlay is not on screen the whole video. Build checks the lap itself.
    setStatus("digits-status", `Speed read on ${Math.round((read / speeds.length) * 100)}% of frames.`, read / speeds.length > 0.5 ? "good" : "bad");
    applyLapTime();
  } catch (err) {
    setStatus("digits-status", err.message, "bad");
  }
  updateButtons();
}
el("read-speeds").addEventListener("click", () => void readSpeeds());

async function readGears() {
  const gl = state.gearGlyphs;
  if (gl === null) return;
  try {
    const gears = await call({ op: "readGears", times: gl.times, glyphFrame: gl.glyphFrame, ids: gl.ids, labels: namedGroups(READS.gear) });
    const byTime = new Map();
    gl.times.forEach((t, i) => byTime.set(t, gears[i]));
    state.samples = state.samples.map((s) => ({ ...s, gear: byTime.get(s.t) ?? null }));
    const read = gears.filter((v) => v !== null).length;
    setStatus("gears-status", `Gear read on ${Math.round((read / gears.length) * 100)}% of frames.`, read / gears.length > 0.5 ? "good" : "bad");
  } catch (err) {
    setStatus("gears-status", err.message, "bad");
  }
  updateButtons();
}
el("read-gears").addEventListener("click", () => void readGears());

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
  state.marks[which] = t;
  applyLapTime();
  updateButtons();
}

/** How far the car went between two moments by the speed read off the overlay, metres; null without it. */
function stretchM(s, e) {
  let d = 0;
  let prev = null;
  let read = 0;
  let all = 0;
  for (const x of state.samples) {
    if (x.t < s || x.t > e) continue;
    all++;
    if (x.speedKph === null || x.speedKph === undefined) continue;
    read++;
    if (prev !== null) d += ((prev.speedKph + x.speedKph) / 7.2) * (x.t - prev.t);
    prev = x;
  }
  return all > 0 && read / all >= 0.8 ? d : null;
}
el("start-here").addEventListener("click", () => setLap("start", video.currentTime));
el("end-here").addEventListener("click", () => setLap("end", video.currentTime));
for (const which of ["start", "end"]) {
  el(which).addEventListener("input", () => {
    state.marks[which] = el(which).value === "" ? null : Number(el(which).value);
    updateButtons();
  });
}
/** "1:21.310" or "81.31" → seconds, or null. */
const parseLapTime = (text) => {
  const m = /^\s*(?:(\d+):)?(\d+(?:\.\d+)?)\s*$/.exec(text);
  return m === null ? null : Number(m[1] ?? 0) * 60 + Number(m[2]);
};
/**
 * A lap time typed from the video's own overlay is exact; the line box's
 * change can trail the line, or be something else altogether (the overlay
 * fading in). With one, the lap is that long from the start mark, or that
 * long up to the end mark — whichever stretch the car's own speed says is
 * nearer one lap of the track. Without the speed, from the start.
 */
function applyLapTime() {
  const lap = parseLapTime(el("laptime").value);
  const { start, end } = state.marks;
  if (lap === null || !(lap > 0) || (start === null && end === null)) return;
  const options = [];
  if (start !== null) options.push({ s: start, e: start + lap });
  if (end !== null) options.push({ s: end - lap, e: end });
  const lengthM = el("target").value === "" ? null : JSON.parse(el("target").value).lengthM;
  let best = options[0];
  if (options.length > 1 && lengthM) {
    const off = options.map((o) => stretchM(o.s, o.e)).map((d) => (d === null ? Infinity : Math.abs(d - lengthM)));
    if (off[1] < off[0]) best = options[1];
  }
  el("start").value = best.s.toFixed(3);
  el("end").value = best.e.toFixed(3);
}
el("laptime").addEventListener("input", () => {
  applyLapTime();
  updateButtons();
});

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
  el("save").disabled = state.built === null || state.built.doubt === true;
}
el("target").addEventListener("change", () => {
  guessLap();
  updateButtons();
});

async function buildLap() {
  const lap = lapTimes();
  const target = JSON.parse(el("target").value);
  setStatus("build-status", "Building…");
  try {
    // Only the lap's frames, and a little either side.
    const samples = state.samples.filter((f) => f.t >= lap.s - 1 && f.t <= lap.e + 1).map((f) => ({ speedKph: null, gear: null, ...f }));
    state.built = await call({ op: "build", trackKey: target.trackKey, carId: target.carId, lapStartS: lap.s, lapEndS: lap.e, samples });
    setStatus("build-status", state.built.summary, state.built.doubt ? "bad" : "good");
    drawChart(state.built);
  } catch (err) {
    state.built = null;
    setStatus("build-status", err.message, "bad");
  }
  updateButtons();
}
el("build").addEventListener("click", () => void buildLap());

el("save").addEventListener("click", () => {
  if (state.built === null) return;
  if (el("save").dataset.armed !== "1") {
    el("save").dataset.armed = "1";
    el("save").textContent = "Replace the reference?";
    return;
  }
  void saveLap();
});

async function saveLap() {
  if (state.built === null) return;
  delete el("save").dataset.armed;
  el("save").textContent = "Save as reference";
  try {
    setStatus("build-status", await call({ op: "save", token: state.built.token }), "good");
    state.built = null;
  } catch (err) {
    setStatus("build-status", err.message, "bad");
  }
  updateButtons();
}

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
  // Speed, scaled to the faster of the two laps.
  const top = Math.max(...b.speed.base, ...b.speed.video, 1);
  line(b.speed.base.map((v) => v / top), "rgba(210, 168, 255, 0.35)", 1);
  if (b.bySpeed) line(b.speed.video.map((v) => v / top), "#d2a8ff", 1.6);
  line(b.gear.map((v) => v / Math.max(...b.gear, 1) / 2), "#79c0ff", 1);
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
  state.video = chosen;
  el("title").textContent = chosen.title;
  const select = el("target");
  select.replaceChildren(new Option(targets.length === 0 ? "No reference laps yet — import one first" : "Choose…", ""));
  for (const t of targets) {
    for (const car of t.cars) {
      select.append(new Option(`${t.label} — ${car.carId} (${fmt(car.lapTimeS)})`, JSON.stringify({ trackKey: t.trackKey, carId: car.carId, lapTimeS: car.lapTimeS, lengthM: t.lengthM })));
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

// ---------------------------------------------------------------------------
// The same window, worked by an assistant (src/assistant-authoring.ts)
// ---------------------------------------------------------------------------
//
// Everything a person does here with the mouse, as calls: look at a frame,
// place the boxes, read, name the digits, choose the lap, build. Main calls
// these over executeJavaScript; they drive the page's own state and functions,
// so what the assistant did is on screen for a person to check or carry on from.

const text = (id) => el(id).textContent ?? "";

function seek(t) {
  return new Promise((resolve) => {
    const to = Math.max(0, Math.min(t, Math.max(0, (video.duration || t) - 0.05)));
    video.addEventListener("seeked", () => resolve(), { once: true });
    // A seek that never lands should not hang the caller for ever.
    setTimeout(resolve, 5000);
    video.currentTime = to;
  });
}

function needVideo() {
  if (video.readyState < 1) throw new Error(`the video is not loaded yet — ${text("status")}`);
}

function apiStatus() {
  const lap = lapTimes();
  const cal = state.calibration;
  const first = state.samples[0];
  const last = state.samples.at(-1);
  const loaded = video.readyState >= 1;
  return {
    video: state.video,
    ready: loaded,
    message: text("status"),
    durationS: loaded ? video.duration : null,
    width: loaded ? video.videoWidth : null,
    height: loaded ? video.videoHeight : null,
    boxes: state.boxes,
    reading: state.reading,
    readAtS: state.reading ? video.currentTime : null,
    readMessage: text("read-status"),
    read: first === undefined ? null : { fromS: first.t, toS: last.t, frames: state.samples.length },
    barsFound: { throttle: Boolean(cal?.throttle), brake: Boolean(cal?.brake) },
    crossings: state.crossings ?? [],
    lap: { startS: lap?.s ?? state.marks.start, endS: lap?.e ?? state.marks.end },
    speed: { shapes: state.glyphs?.groups ?? 0, message: text("digits-status") },
    gear: { shapes: state.gearGlyphs?.groups ?? 0, message: text("gears-status") },
    built: state.built === null ? null : { summary: state.built.summary, doubt: state.built.doubt === true },
    buildMessage: text("build-status"),
  };
}

/** A ruler step that puts a tick every 60 px or so of picture. */
const rulerStep = (scale) => [5, 10, 20, 25, 50, 100, 200, 250, 500].find((s) => s * scale >= 60) ?? 1000;

window.tracerApi = {
  status: apiStatus,

  /** One frame, or part of one enlarged, with a ruler in video pixels and the boxes drawn. */
  async frame(timeS, crop) {
    needVideo();
    if (state.reading) throw new Error("a read is running — wait for it to finish, or stop it");
    video.pause();
    await seek(timeS);
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const src = crop === null ? { x: 0, y: 0, w: vw, h: vh } : {
      x: Math.max(0, Math.min(vw - 4, Math.round(crop.x))),
      y: Math.max(0, Math.min(vh - 4, Math.round(crop.y))),
      w: 0,
      h: 0,
    };
    if (crop !== null) {
      src.w = Math.max(4, Math.min(vw - src.x, Math.round(crop.w)));
      src.h = Math.max(4, Math.min(vh - src.y, Math.round(crop.h)));
    }
    const scale = Math.min(1280 / src.w, 860 / src.h, 10);
    const left = 46;
    const top = 20;
    const w = Math.round(src.w * scale);
    const h = Math.round(src.h * scale);
    const c = document.createElement("canvas");
    c.width = w + left;
    c.height = h + top;
    const g = c.getContext("2d");
    g.fillStyle = "#101215";
    g.fillRect(0, 0, c.width, c.height);
    g.imageSmoothingEnabled = scale < 3;
    g.drawImage(video, src.x, src.y, src.w, src.h, left, top, w, h);

    // The ruler, and faint lines across the picture at each tick.
    const step = rulerStep(scale);
    g.font = "11px system-ui";
    g.fillStyle = "#e6e9ee";
    g.strokeStyle = "rgba(255,255,255,0.22)";
    g.lineWidth = 1;
    g.textBaseline = "middle";
    for (let x = Math.ceil(src.x / step) * step; x <= src.x + src.w; x += step) {
      const px = left + (x - src.x) * scale;
      g.beginPath();
      g.moveTo(px + 0.5, top - 4);
      g.lineTo(px + 0.5, top + h);
      g.stroke();
      g.textAlign = "center";
      g.fillText(String(x), Math.max(left + 12, Math.min(c.width - 14, px)), 8);
    }
    for (let y = Math.ceil(src.y / step) * step; y <= src.y + src.h; y += step) {
      const py = top + (y - src.y) * scale;
      g.beginPath();
      g.moveTo(left - 4, py + 0.5);
      g.lineTo(left + w, py + 0.5);
      g.stroke();
      g.textAlign = "right";
      g.fillText(String(y), left - 6, Math.max(top + 6, Math.min(c.height - 6, py)));
    }

    g.save();
    g.beginPath();
    g.rect(left, top, w, h);
    g.clip();
    g.textAlign = "left";
    g.textBaseline = "alphabetic";
    for (const [name, b] of Object.entries(state.boxes)) {
      if (b === null) continue;
      const bx = left + (b.x - src.x) * scale;
      const by = top + (b.y - src.y) * scale;
      g.strokeStyle = COLOURS[name];
      g.lineWidth = 2;
      g.strokeRect(bx, by, b.w * scale, b.h * scale);
      g.fillStyle = COLOURS[name];
      g.font = "bold 12px system-ui";
      g.fillText(LABELS[name], bx, Math.max(top + 12, by - 4));
    }
    g.restore();
    return { dataUrl: c.toDataURL("image/jpeg", 0.85), timeS: video.currentTime };
  },

  setBoxes(boxes, unit) {
    needVideo();
    if (state.reading) throw new Error("a read is running — wait for it to finish, or stop it");
    for (const [name, b] of Object.entries(boxes)) {
      if (!(name in state.boxes)) continue;
      if (b === null) {
        state.boxes[name] = null;
        continue;
      }
      const x = Math.round(b.x);
      const y = Math.round(b.y);
      const w = Math.round(b.w);
      const h = Math.round(b.h);
      if (x + w > video.videoWidth || y + h > video.videoHeight) {
        throw new Error(`the ${name} box runs off the video, which is ${video.videoWidth}×${video.videoHeight}`);
      }
      state.boxes[name] = { x, y, w, h };
    }
    if (unit !== null) el("units").value = unit;
    drawBoxes();
    updateButtons();
    return apiStatus();
  },

  /** Start a read and return: `status().reading` says when it has finished. */
  async read(fromS, untilS) {
    needVideo();
    if (state.reading) throw new Error("a read is already running");
    if (state.boxes.pedals === null) throw new Error("place the pedals box first");
    video.pause();
    await seek(fromS);
    void read(untilS).catch((err) => {
      state.reading = false;
      setStatus("read-status", err.message, "bad");
    });
  },

  stopRead() {
    state.reading = false;
    video.pause();
  },

  /** The shapes of a number box as one picture: tiles in a row, each numbered. */
  shapes(kind) {
    const gl = state[READS[kind].key];
    if (gl === null) throw new Error(`nothing read from a ${kind} box yet — place the ${kind} box and read the video`);
    const k = 10;
    const gap = 14;
    const c = document.createElement("canvas");
    c.width = gap + gl.centroids.length * (GW * k + gap);
    c.height = GH * k + 34;
    const g = c.getContext("2d");
    g.fillStyle = "#101215";
    g.fillRect(0, 0, c.width, c.height);
    g.font = "bold 14px system-ui";
    g.textAlign = "center";
    gl.centroids.forEach((centroid, i) => {
      const x0 = gap + i * (GW * k + gap);
      for (let n = 0; n < GW * GH; n++) {
        const v = Math.round(centroid[n] * 255);
        g.fillStyle = `rgb(${v},${v},${v})`;
        g.fillRect(x0 + (n % GW) * k, 24 + Math.floor(n / GW) * k, k, k);
      }
      g.fillStyle = "#58a6ff";
      g.fillText(String(i), x0 + (GW * k) / 2, 16);
    });
    return { dataUrl: c.toDataURL("image/png"), counts: gl.counts };
  },

  async nameShapes(kind, labels) {
    const which = READS[kind];
    if (state[which.key] === null) throw new Error(`nothing read from a ${kind} box yet`);
    const inputs = [...el(which.tiles).querySelectorAll("input")];
    inputs.forEach((input, i) => (input.value = labels[i] ?? ""));
    await (kind === "speed" ? readSpeeds() : readGears());
    return text(which.status);
  },

  setLap({ startS, endS, lapTime }) {
    // A lap built from the old ends is not this lap.
    state.built = null;
    setStatus("build-status", "");
    if (startS !== undefined) setLap("start", startS);
    if (endS !== undefined) setLap("end", endS);
    if (lapTime !== undefined) {
      el("laptime").value = lapTime;
      applyLapTime();
    }
    updateButtons();
    return apiStatus();
  },

  async build({ trackId, configId, carId }) {
    const select = el("target");
    const option = [...select.options].find((o) => {
      if (o.value === "") return false;
      const t = JSON.parse(o.value);
      return t.trackKey.trackId === trackId && t.trackKey.configId === configId && t.carId === carId;
    });
    if (option === undefined) throw new Error("there is no reference lap for that car on that track to build on");
    // Not a `change` event: that re-guesses the lap, over the one just chosen.
    select.value = option.value;
    const lap = lapTimes();
    if (lap === null) throw new Error("choose the lap first: its start and its end");
    if (state.samples.length === 0 || state.samples[0].t > lap.s + 0.5 || state.samples.at(-1).t < lap.e - 0.5) {
      throw new Error("the read does not cover the whole lap — read the video from before its start to after its end");
    }
    await buildLap();
    if (state.built === null) throw new Error(text("build-status"));
    return { summary: state.built.summary, doubt: state.built.doubt === true };
  },

  async save() {
    if (state.built === null) throw new Error("build the lap first");
    if (state.built.doubt === true) throw new Error("that stretch of video is not one lap of this track — it is not saved");
    await saveLap();
    // A save that worked lets go of the lap; one that did not left its reason in the status.
    if (state.built !== null) throw new Error(text("build-status"));
    return text("build-status");
  },
};

void start();
