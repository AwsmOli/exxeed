// The note editor — SPEC.md §7.4. SVG and plain DOM; everything here changes at
// human speed, so none of §7.0's hot-path rules apply.

const $ = (id) => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";
const VIEW = 1000;
const PAD = 46;

/** Server truth, and the edits sitting on top of it. */
let payload = null;
const edits = new Map();
/** Notes created here and not yet saved — id → a stand-in for the server's EditorNote. */
const added = new Map();
/** Server notes marked for deletion on the next save. */
const deleted = new Set();
let selectedId = null;
let dragging = null;

const noteById = (id) => payload?.notes.find((n) => n.id === id) ?? added.get(id) ?? null;

/** Every note that will exist after a save, in no particular order. */
const allNotes = () => [
  ...(payload?.notes ?? []).filter((n) => !deleted.has(n.id)),
  ...added.values(),
];

/** A note as it currently stands: what the server sent, plus any local edit. */
const current = (id) => ({ ...noteById(id), ...(edits.get(id) ?? {}) });

const dirty = () => edits.size > 0 || deleted.size > 0;

/**
 * The timing main computed for the unsaved edits (EDITOR_PREVIEW_CHANNEL):
 * id → EditorNote, or null when there are no edits or none computed yet.
 * Drawing and Play lap read it, so a moved callout or a new lead shows before
 * Save rather than after.
 */
let preview = null;
/** Bumped by every edit, save and revert, so a late answer is thrown away. */
let previewSeq = 0;
let previewTimer = null;

/** A note's computed timing: from the preview when there is one, else as saved. */
const timing = (id) => preview?.get(id) ?? noteById(id);

/**
 * Whether a note's audio no longer matches its words. Only a change of words
 * does that — moving a callout or changing its lead keeps the clip.
 */
function isStale(id) {
  if (added.has(id)) return true;
  if (preview?.has(id)) return preview.get(id).dirty;
  return noteById(id).dirty || edits.has(id);
}

const patchList = () => [
  ...[...edits.entries()].map(([id, patch]) => ({ id, ...patch })),
  ...[...deleted].map((id) => ({ ...current(id), id, deleted: true })),
];

/** Ask main for the edited timing, a moment after the last change. */
function schedulePreview() {
  const seq = ++previewSeq;
  clearTimeout(previewTimer);
  if (!dirty()) {
    preview = null;
    return;
  }
  previewTimer = setTimeout(async () => {
    const notes = await window.exxeed.previewNotes(patchList());
    if (seq === previewSeq && notes !== null) {
      preview = new Map(notes.map((n) => [n.id, n]));
      sim.pending = sim.started;
      draw();
      renderPanel();
    }
  }, 150);
}

/** Six base-36 characters, the same shape core's newNoteId mints (note-id.ts). */
function mintId() {
  const taken = new Set(allNotes().map((n) => n.id));
  for (;;) {
    const id = Math.floor(Math.random() * 36 ** 6).toString(36).padStart(6, "0");
    if (!taken.has(id) && !deleted.has(id)) return id;
  }
}

const el = (name, attrs = {}) => {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
};

// --- geometry ---------------------------------------------------------------

const pointAt = (index) => {
  const n = payload.x.length;
  const i = ((Math.round(index) % n) + n) % n;
  return [PAD + payload.x[i] * (VIEW - PAD * 2), PAD + payload.y[i] * (VIEW - PAD * 2)];
};

const indexOfPct = (p) => {
  const n = payload.x.length;
  return Math.min(n - 1, Math.floor((((p % 1) + 1) % 1) * n));
};

/** The centreline between two lap positions, as an SVG path. Wraps. */
function arc(fromPct, toPct) {
  const n = payload.x.length;
  const from = indexOfPct(fromPct);
  const to = indexOfPct(toPct);
  const span = (to - from + n) % n;

  const points = [];
  // One point every few cells is plenty at this scale and keeps the DOM small.
  const step = Math.max(1, Math.floor(n / 600));
  for (let k = 0; k <= span; k += step) points.push(pointAt(from + k));
  points.push(pointAt(to));

  return points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
}

/** Nearest centreline position to a point in view coordinates. */
function nearestPct(vx, vy) {
  const n = payload.x.length;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const [x, y] = pointAt(i);
    const d = (x - vx) ** 2 + (y - vy) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best / n;
}

const toView = (event) => {
  const svg = $("map");
  const box = svg.getBoundingClientRect();
  // preserveAspectRatio="xMidYMid meet": the viewBox is letterboxed inside the
  // element, so the scale is the smaller ratio and the rest is offset.
  const scale = Math.min(box.width, box.height) / VIEW;
  return [
    (event.clientX - box.left - (box.width - VIEW * scale) / 2) / scale,
    (event.clientY - box.top - (box.height - VIEW * scale) / 2) / scale,
  ];
};

// --- drawing ----------------------------------------------------------------

/** How far before a turn a callout still belongs to it: braking calls sit there. */
const LEAD_IN_M = 300;

/** Callouts in lap order, so the map's numbers and the list's agree. */
const ordered = () => allNotes().map((n) => current(n.id)).sort((a, b) => a.pct - b.pct);

/** Metres from lap position a forward to b, wrapping at the line. */
const aheadM = (a, b) => ((((b - a) % 1) + 1) % 1) * payload.lengthM;

/**
 * The turn a callout belongs to: the one it is inside, or the one it comes
 * up to within LEAD_IN_M — where a braking call sits. Null for a callout
 * about something else (a straight, a pit entry).
 */
function turnOf(pct) {
  let best = null;
  let bestAhead = Infinity;
  for (const corner of payload.corners) {
    const span = aheadM(corner.entryPct, corner.exitPct);
    if (aheadM(corner.entryPct, pct) <= span) return corner.index;
    const ahead = aheadM(pct, corner.entryPct);
    if (ahead <= LEAD_IN_M && ahead < bestAhead) {
      best = corner.index;
      bestAhead = ahead;
    }
  }
  return best;
}

/** Where to write "T3": just outside the track at the apex, away from the map's middle. */
function turnLabelAt(corner) {
  const [x, y] = pointAt(indexOfPct(corner.apexPct));
  const dx = x - VIEW / 2;
  const dy = y - VIEW / 2;
  const d = Math.hypot(dx, dy) || 1;
  return [x + (dx / d) * 26, y + (dy / d) * 26];
}

function draw() {
  const svg = $("map");
  svg.replaceChildren();
  if (payload === null || payload.x.length === 0) return;

  svg.append(el("path", { d: `${arc(0, 0.9999)}Z`, class: "track" }));

  for (const corner of payload.corners) {
    svg.append(el("path", { d: arc(corner.entryPct, corner.exitPct), class: "corner", "data-turn": corner.index }));
    const [tx, ty] = turnLabelAt(corner);
    const label = el("text", { x: tx, y: ty, class: "turn-label", "data-turn": corner.index });
    label.textContent = `T${corner.index}`;
    svg.append(label);
    const name = corner.names[0];
    if (name !== undefined) {
      // Under the number when the label sits below the track, above it otherwise.
      const below = ty >= pointAt(indexOfPct(corner.apexPct))[1];
      const sub = el("text", { x: tx, y: ty + (below ? 16 : -16), class: "corner-name", "data-turn": corner.index });
      sub.textContent = name;
      svg.append(sub);
    }
  }

  drawBraking(svg);

  const [sx, sy] = pointAt(0);
  svg.append(el("rect", { x: sx - 5, y: sy - 5, width: 10, height: 10, class: "sf" }));

  const notes = ordered();
  if (payload.hasReference) {
    for (const note of notes) {
      const base = timing(note.id);
      // The arc of track this callout is speaking over. Stale once the text has
      // been edited: the duration it was computed from belongs to the old words.
      const classes = ["window"];
      if (isStale(note.id)) classes.push("stale");
      else if (base.overlaps.length > 0) classes.push("clash");
      if (note.id === selectedId) classes.push("selected");
      svg.append(el("path", { d: arc(base.startPct, note.pct), class: classes.join(" "), "data-id": note.id }));
    }
  }

  // Markers last, so they sit on top: a numbered dot per callout, in lap order.
  notes.forEach((note, i) => {
    const [x, y] = pointAt(indexOfPct(note.pct));
    const selected = note.id === selectedId;
    const g = el("g", { class: `marker${selected ? " selected" : ""}`, "data-id": note.id });
    g.append(el("circle", { cx: x, cy: y, r: 11, class: "dot", "data-id": note.id }));
    const n = el("text", { x, y, class: "dot-n", "data-id": note.id });
    n.textContent = String(i + 1);
    g.append(n);
    svg.append(g);
  });

  if (sim.started) drawCar(pctAtTime(sim.t));
  drawInputs();
  applyHover();
}

/**
 * The reference lap's braking: a red stripe along the track where the brake
 * was on, and a bar across it where braking for each turn begins — the point
 * a "brake" callout should sit on, and where "snap to braking point" puts one.
 */
function drawBraking(svg) {
  const braking = payload.braking;
  if (braking === null) return;
  svg.classList.toggle("braking-inferred", braking.inferred);
  for (const zone of braking.zones) svg.append(el("path", { d: arc(zone.startPct, zone.endPct), class: "brake-zone" }));

  const n = payload.x.length;
  for (const point of braking.points) {
    const i = indexOfPct(point.pct);
    const [x, y] = pointAt(i);
    // Across the track: perpendicular to the direction of travel here.
    const [ax, ay] = pointAt(i - 2);
    const [bx, by] = pointAt((i + 2) % n);
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const [nx, ny] = [-(by - ay) / len, (bx - ax) / len];
    const line = { x1: x - nx * 9, y1: y - ny * 9, x2: x + nx * 9, y2: y + ny * 9 };
    const g = el("g", { "data-turn": point.turn });
    const tip = el("title");
    tip.textContent =
      `T${point.turn}: braking starts at ${Math.round(point.speedKph)} km/h, ` +
      `slowest ${Math.round(point.minSpeedKph)} km/h` +
      (braking.inferred ? " (brake worked out from slowing down — this lap has no brake channel)" : "");
    g.append(tip, el("line", { ...line, class: "brake-point" }), el("line", { ...line, class: "brake-point-hit" }));
    svg.append(g);
  }
}

// --- the lap list -------------------------------------------------------------

/**
 * The lap in order: each turn, with the callouts that belong to it, and the
 * callouts that belong to none in their place between. Built from the same
 * order as the map's numbers, so "4" is the same callout in both.
 */
function renderList() {
  const list = $("lap-list");
  if (payload === null) return;
  // Never under the text being typed into.
  if (list.querySelector("[contenteditable='true']") !== null) return;

  const notes = ordered();
  const numberOf = new Map(notes.map((n, i) => [n.id, i + 1]));
  const byTurn = new Map();
  const loose = [];
  for (const note of notes) {
    const turn = payload.corners.length > 0 ? turnOf(note.pct) : null;
    if (turn === null) loose.push(note);
    else byTurn.set(turn, [...(byTurn.get(turn) ?? []), note]);
  }

  const items = [
    ...payload.corners.map((c) => ({ kind: "turn", pct: c.entryPct, corner: c })),
    ...loose.map((n) => ({ kind: "note", pct: n.pct, note: n })),
  ].sort((a, b) => a.pct - b.pct);

  const row = (note) => {
    const li = document.createElement("li");
    li.className = `row${note.id === selectedId ? " selected" : ""}${note.dirty || edits.has(note.id) ? " dirty" : ""}`;
    li.dataset.id = note.id;
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = String(numberOf.get(note.id));
    const body = document.createElement("div");
    const text = document.createElement("div");
    text.className = "row-text";
    text.textContent = note.text;
    text.title = "Double-click to edit";
    const short = document.createElement("div");
    short.className = "row-short";
    short.textContent = note.textShort;
    body.append(text, short);
    li.append(n, body);
    return li;
  };

  list.replaceChildren(
    ...items.flatMap((item) => {
      if (item.kind === "note") return [row(item.note)];
      const head = document.createElement("li");
      head.className = "turn";
      head.dataset.turn = String(item.corner.index);
      const notesHere = byTurn.get(item.corner.index) ?? [];
      head.textContent = `T${item.corner.index} `;
      const cname = document.createElement("span");
      cname.className = `cname${item.corner.names[0] === undefined ? " unnamed" : ""}`;
      cname.textContent = item.corner.names[0] ?? "name";
      cname.title = "Double-click to name this corner";
      head.append(cname);
      if (notesHere.length === 0) {
        const none = document.createElement("span");
        none.className = "none";
        none.textContent = " — no callout";
        head.append(none);
      }
      return [head, ...notesHere.map(row)];
    }),
  );
  if (notes.length === 0 && payload.corners.length === 0) {
    const empty = document.createElement("li");
    empty.className = "turn";
    empty.textContent = "No callouts yet.";
    list.replaceChildren(empty);
  }
}

// --- hover: the list and the map point at each other ---------------------------

let hover = null; // { kind: "note", id } | { kind: "turn", turn }

/** Light up what is hovered, on both sides, without redrawing anything. */
function applyHover() {
  const noteIds = new Set();
  const turns = new Set();
  if (hover?.kind === "note") {
    noteIds.add(hover.id);
    const note = noteById(hover.id);
    const turn = note === null || payload === null ? null : turnOf(current(hover.id).pct);
    if (turn !== null) turns.add(turn);
  } else if (hover?.kind === "turn") {
    turns.add(hover.turn);
    for (const note of ordered()) if (turnOf(note.pct) === hover.turn) noteIds.add(note.id);
  }
  for (const node of document.querySelectorAll("[data-id]")) {
    node.classList.toggle("hl", noteIds.has(node.dataset.id));
    node.classList.toggle("speaking", node.dataset.id === sim.speakingId);
    node.classList.toggle("skipped", sim.skipped.has(node.dataset.id));
  }
  for (const node of document.querySelectorAll("[data-turn]")) node.classList.toggle("hl", turns.has(Number(node.dataset.turn)));
  showTip();
}

/** One small tooltip with the hovered callout's words, beside its marker. */
function showTip() {
  const tip = $("tip");
  // The hovered callout, or else the one being spoken during Play lap.
  const id = hover?.kind === "note" ? hover.id : sim.speakingId;
  if (id === null || payload === null || payload.x.length === 0 || noteById(id) === null) {
    tip.hidden = true;
    return;
  }
  const note = current(id);
  const [x, y] = pointAt(indexOfPct(note.pct));
  const box = $("map").getBoundingClientRect();
  const scale = Math.min(box.width, box.height) / VIEW;
  const px = (box.width - VIEW * scale) / 2 + x * scale;
  const py = (box.height - VIEW * scale) / 2 + y * scale;
  tip.textContent = note.text;
  tip.hidden = false;
  const left = Math.min(Math.max(px - tip.offsetWidth / 2, 4), box.width - tip.offsetWidth - 4);
  const top = py - tip.offsetHeight - 18 < 4 ? py + 18 : py - tip.offsetHeight - 18;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function setHover(next) {
  const same = hover?.kind === next?.kind && hover?.id === next?.id && hover?.turn === next?.turn;
  if (same) return;
  hover = next;
  applyHover();
}

for (const target of [$("map"), $("lap-list")]) {
  target.addEventListener("mouseover", (event) => {
    const withId = event.target.closest?.("[data-id]");
    const withTurn = event.target.closest?.("[data-turn]");
    if (withId) setHover({ kind: "note", id: withId.dataset.id });
    else if (withTurn) setHover({ kind: "turn", turn: Number(withTurn.dataset.turn) });
  });
  target.addEventListener("mouseleave", () => setHover(null));
}

// Scroll the list to a callout hovered on the map, so its row is in view.
$("map").addEventListener("mouseover", (event) => {
  const id = event.target.closest?.("[data-id]")?.dataset.id;
  if (id) [...$("lap-list").querySelectorAll(".row")].find((r) => r.dataset.id === id)?.scrollIntoView({ block: "nearest" });
});

// --- Play lap -------------------------------------------------------------------

/**
 * Drive the reference lap around the map in real time and play each callout
 * where the engine would start it (the start of its blue arc), so the author hears the
 * script against the lap instead of imagining it. The car moves at the speed
 * the reference lap was driven, slowing into the corners as it did.
 *
 * Deliberately simpler than the engine's scheduler (§6.3): a callout that comes
 * due while another is still talking is skipped and marked, where the engine
 * might fall back to the short form. The orange windows already warn about
 * exactly those.
 */
const sim = {
  started: false,
  playing: false,
  t: 0,
  prevPct: null,
  last: 0,
  raf: 0,
  ctx: null,
  /** Decoded clips by audio key; null until loaded, cleared when audio changes. */
  buffers: null,
  /** Each clip as a blob URL, for playing at a speech rate other than 1. */
  urls: new Map(),
  busyUntil: 0,
  source: null,
  speakingId: null,
  speakingTimer: null,
  skipped: new Set(),
  /**
   * This lap's callouts and where each starts: [{ id, startPct }]. Fixed for
   * the lap and rebuilt at the line, so an edit is heard from the next lap on
   * instead of firing a callout twice or not at all mid-lap.
   */
  plan: null,
  /** An edit is waiting for the next lap. */
  pending: false,
};

const canPlay = () => payload !== null && payload.lapElapsedS !== null && payload.lapElapsedS.length > 2 && payload.x.length > 0;

function lapTimeS() {
  const e = payload.lapElapsedS;
  return e[e.length - 1] + (e[e.length - 1] - e[e.length - 2]);
}

/** Lap position at a time into the reference lap: the grid cell it is in, interpolated. */
function pctAtTime(t) {
  const e = payload.lapElapsedS;
  let lo = 0;
  let hi = e.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (e[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  const next = lo + 1 < e.length ? e[lo + 1] : lapTimeS();
  const frac = next > e[lo] ? (t - e[lo]) / (next - e[lo]) : 0;
  return (((lo + Math.min(1, Math.max(0, frac))) / e.length) % 1 + 1) % 1;
}

function drawCar(p) {
  const svg = $("map");
  let car = svg.querySelector(".car");
  if (car === null) {
    car = el("circle", { r: 9, class: "car" });
    svg.append(car);
  }
  const [x, y] = pointAt(p * payload.x.length);
  car.setAttribute("cx", x.toFixed(1));
  car.setAttribute("cy", y.toFixed(1));
}

const fmtClock = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

function updateClock() {
  $("clock").textContent =
    `${fmtClock(sim.t)} / ${fmtClock(lapTimeS())}` + (sim.pending ? " · your changes play next lap" : "");
  if (document.activeElement !== $("scrub")) $("scrub").value = String(Math.round((sim.t / lapTimeS()) * 1000));
}

async function loadAudio() {
  if (sim.buffers !== null) return;
  sim.ctx ??= new AudioContext();
  sim.buffers = new Map();
  sim.urls = new Map();
  const audio = await window.exxeed.loadNoteAudio();
  if (audio === null) return;
  for (const [key, bytes] of Object.entries(audio.clips)) {
    try {
      const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      // Before decoding, which takes the buffer: the same bytes as a media
      // element, to play at another speed with the pitch kept (renderer.js).
      sim.urls.set(key, URL.createObjectURL(new Blob([copy.slice(0)], { type: "audio/wav" })));
      sim.buffers.set(key, await sim.ctx.decodeAudioData(copy));
    } catch {
      // A clip that will not decode just plays nothing.
    }
  }
}

function speaking(id, seconds) {
  sim.speakingId = id;
  clearTimeout(sim.speakingTimer);
  sim.speakingTimer = setTimeout(() => {
    sim.speakingId = null;
    applyHover();
  }, seconds * 1000);
  applyHover();
}

/** A callout came due: play it, unless the last one is still talking. */
function fire(note) {
  const now = sim.ctx.currentTime;
  if (now < sim.busyUntil) {
    sim.skipped.add(note.id);
    applyHover();
    return;
  }
  sim.skipped.delete(note.id);
  // Unsaved or re-worded text has no audio yet: show the words instead.
  const buffer = isStale(note.id) ? undefined : sim.buffers.get(note.id);
  if (buffer === undefined) {
    speaking(note.id, 2);
    return;
  }
  // At the driver's speech rate, as a session would say it.
  const rate = payload.speechRate ?? 1;
  const url = sim.urls.get(note.id);
  if (rate !== 1 && url !== undefined) {
    const element = new Audio(url);
    element.preservesPitch = true;
    element.playbackRate = rate;
    void element.play().catch(() => {});
    sim.source = { stop: () => element.pause() };
  } else {
    const source = sim.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(sim.ctx.destination);
    source.start();
    sim.source = source;
  }
  sim.busyUntil = now + buffer.duration / rate;
  speaking(note.id, buffer.duration / rate);
}

/**
 * Where each callout starts this lap: the engine's start (`runtimeStartPct`),
 * computed for the edits as they stand. A callout moved since the last
 * preview answer keeps its offset, so a drag is never dropped.
 */
function planLap() {
  sim.pending = false;
  sim.plan = ordered().map((note) => {
    const t = timing(note.id);
    if (!payload.hasReference || t.runtimeStartPct === undefined) return { id: note.id, startPct: note.pct };
    return { id: note.id, startPct: (((note.pct - (t.pct - t.runtimeStartPct)) % 1) + 1) % 1 };
  });
}

function tick(now) {
  if (!sim.playing) return;
  const dt = Math.min(0.25, (now - sim.last) / 1000);
  sim.last = now;
  const before = sim.t;
  sim.t = (sim.t + dt) % lapTimeS();
  // Across the line: this lap is heard as the script now stands.
  if (sim.t < before || sim.plan === null) planLap();
  const p = pctAtTime(sim.t);
  if (sim.prevPct !== null) {
    const moved = aheadM(sim.prevPct, p);
    for (const { id, startPct } of sim.plan) {
      // Deleted since the lap began: nothing to say.
      if (noteById(id) === null || deleted.has(id)) continue;
      const ahead = aheadM(sim.prevPct, startPct);
      if (moved > 0 && ahead > 0 && ahead <= moved) fire(current(id));
    }
  }
  sim.prevPct = p;
  drawCar(p);
  drawInputs();
  updateClock();
  sim.raf = requestAnimationFrame(tick);
}

async function play() {
  if (!canPlay()) return;
  await loadAudio();
  await sim.ctx.resume();
  sim.started = true;
  sim.playing = true;
  sim.last = performance.now();
  $("play").textContent = "❚❚ Pause";
  $("stop").disabled = false;
  sim.raf = requestAnimationFrame(tick);
}

function pause() {
  sim.playing = false;
  cancelAnimationFrame(sim.raf);
  sim.source?.stop();
  sim.busyUntil = 0;
  $("play").textContent = "▶ Play lap";
}

function stopLap() {
  pause();
  sim.started = false;
  sim.t = 0;
  sim.prevPct = null;
  sim.skipped.clear();
  sim.speakingId = null;
  sim.plan = null;
  sim.pending = false;
  $("map").querySelector(".car")?.remove();
  $("stop").disabled = true;
  drawInputs();
  updateClock();
  applyHover();
}

$("play").addEventListener("click", () => void (sim.playing ? pause() : play()));
$("stop").addEventListener("click", stopLap);
$("scrub").addEventListener("input", () => {
  if (!canPlay()) return;
  sim.t = (Number($("scrub").value) / 1000) * lapTimeS();
  // A jump is not driving: nothing between here and there fires.
  sim.prevPct = null;
  sim.started = true;
  planLap();
  $("stop").disabled = false;
  drawCar(pctAtTime(sim.t));
  drawInputs();
  updateClock();
});

// --- inputs chart: the reference lap's pedals, under the map --------------------

/**
 * Throttle, brake and speed across the whole lap, with turn numbers, and the
 * Play lap car as a cursor — so you see what the driver was doing where a
 * callout speaks. The traces are drawn once per size into a cache; each frame
 * only copies it and draws the cursor.
 */
const chart = { cache: null, key: "" };
const CHART_TOP = 18;

function chartTraces(w, h) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d");
  const { throttle, brake, speedKph } = payload.inputs;
  const n = throttle.length;
  const dpr = devicePixelRatio;
  const top = CHART_TOP * dpr;
  const plotH = h - top - 4 * dpr;
  const xOf = (i) => (i / n) * w;
  const yOf = (v) => top + (1 - Math.min(1, Math.max(0, v))) * plotH;

  // Corners as shaded bands with their numbers, like the list's headings.
  g.font = `${10 * dpr}px ui-sans-serif, system-ui, sans-serif`;
  g.textAlign = "center";
  for (const c of payload.corners) {
    const a = c.entryPct * w;
    const b = c.exitPct * w;
    g.fillStyle = "rgba(255,255,255,0.04)";
    if (b >= a) g.fillRect(a, top, b - a, plotH);
    else { g.fillRect(a, top, w - a, plotH); g.fillRect(0, top, b, plotH); }
    g.fillStyle = "#6f7885";
    // The name too, when the corner is wide enough on the chart to fit it.
    const named = c.names[0] === undefined ? `T${c.index}` : `T${c.index} ${c.names[0]}`;
    const span = (((c.exitPct - c.entryPct) % 1) + 1) % 1 * w;
    g.fillText(g.measureText(named).width <= span + 30 * dpr ? named : `T${c.index}`, c.apexPct * w, 12 * dpr);
  }

  // Callouts as ticks along the bottom, where they are placed.
  g.fillStyle = "rgba(88,166,255,0.8)";
  for (const note of ordered()) g.fillRect(note.pct * w - dpr, h - 5 * dpr, 2 * dpr, 5 * dpr);

  const line = (values, scale, style, width, fill) => {
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const x = xOf(i);
      const y = yOf(values[i] / scale);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    if (fill) {
      g.lineTo(w, yOf(0));
      g.lineTo(0, yOf(0));
      g.closePath();
      g.fillStyle = fill;
      g.fill();
    } else {
      g.strokeStyle = style;
      g.lineWidth = width * dpr;
      g.stroke();
    }
  };
  const maxSpeed = Math.max(1, ...speedKph);
  line(speedKph, maxSpeed, "rgba(200,208,220,0.45)", 1.25);
  line(brake, 1, null, 0, "rgba(248,81,73,0.35)");
  line(brake, 1, "#f85149", 1.25);
  line(throttle, 1, "#3fb950", 1.25);
  return canvas;
}

function drawInputs() {
  const wrap = $("inputs-wrap");
  const show = payload !== null && payload.inputs !== null && payload.x.length > 0 && $("show-inputs").checked;
  if (wrap.hidden === show) wrap.hidden = !show;
  if (!show) return;

  const canvas = $("inputs");
  const dpr = devicePixelRatio;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const key = `${w}x${h}:${payload.noteSetId}:${ordered().map((n) => n.pct.toFixed(4)).join(",")}`;
  if (chart.key !== key) {
    chart.cache = chartTraces(w, h);
    chart.key = key;
  }

  const g = canvas.getContext("2d");
  g.clearRect(0, 0, w, h);
  g.drawImage(chart.cache, 0, 0);

  if (!sim.started) {
    $("inputs-readout").textContent = "";
    return;
  }
  const p = pctAtTime(sim.t);
  const x = p * w;
  g.fillStyle = "#f0b72f";
  g.fillRect(x - dpr, CHART_TOP * dpr, 2 * dpr, h - CHART_TOP * dpr);
  const { throttle, brake, speedKph } = payload.inputs;
  const i = Math.min(throttle.length - 1, Math.floor(p * throttle.length));
  $("inputs-readout").textContent =
    `${Math.round(speedKph[i])} km/h · throttle ${Math.round(throttle[i] * 100)}% · brake ${Math.round(brake[i] * 100)}%`;
}

// Click the chart to jump Play lap there, the same as the scrub bar.
$("inputs").addEventListener("click", (event) => {
  if (!canPlay()) return;
  const box = $("inputs").getBoundingClientRect();
  const p = Math.min(0.9999, Math.max(0, (event.clientX - box.left) / box.width));
  sim.t = payload.lapElapsedS[Math.floor(p * payload.lapElapsedS.length)];
  sim.prevPct = null;
  sim.started = true;
  planLap();
  $("stop").disabled = false;
  drawCar(pctAtTime(sim.t));
  updateClock();
  drawInputs();
});

// --- panel ------------------------------------------------------------------

function renderPanel() {
  const has = selectedId !== null && noteById(selectedId) !== null;
  $("empty").hidden = has;
  $("detail").hidden = !has;
  if (!has) return;

  const base = timing(selectedId);
  const note = current(selectedId);

  $("detail-id").textContent = note.id;
  if (document.activeElement !== $("text")) $("text").value = note.text;
  if (document.activeElement !== $("textShort")) $("textShort").value = note.textShort;
  if (document.activeElement !== $("lead")) $("lead").value = String(note.leadAdjustS);

  $("stat-lead").textContent = payload.hasReference ? `${base.leadS.toFixed(2)}s` : "—";
  $("stat-window").textContent = payload.hasReference ? `${base.windowM.toFixed(0)}m back` : "—";
  $("stat-audio").textContent = added.has(selectedId)
    ? "not rendered yet"
    : `${base.durationMs}ms / ${base.shortDurationMs}ms`;
  $("stat-pct").textContent = note.pct.toFixed(5);

  const suggestion = base.suggestedLeadAdjustS;
  const worthIt = payload.hasReference && Math.abs(suggestion) >= 0.05;
  $("suggestion").hidden = !worthIt;
  $("apply-suggestion").disabled = !worthIt;
  if (worthIt) {
    $("suggestion").textContent =
      `The engine reads one speed and assumes the car holds it. Here that is ` +
      `${suggestion > 0 ? "not enough" : "too much"} lead by ${Math.abs(suggestion).toFixed(2)}s — ` +
      `apply to correct it.`;
  }

  $("clash").hidden = base.overlaps.length === 0;
  if (base.overlaps.length > 0) {
    $("clash").textContent =
      `Speaking over ${base.overlaps.join(", ")}. At runtime the scheduler resolves ` +
      `that by shortening or dropping one of them (§6.3).`;
  }

  const stale = isStale(selectedId);
  $("stale").hidden = !stale;
  if (stale) {
    $("stale").textContent =
      "The audio no longer matches this text, so the window above is drawn from " +
      "the old duration. Re-render to see the real one: exxeed-ingest render.";
  }

  $("snap").disabled = base.nearestOnsetPct === null;
}

function refresh() {
  draw();
  renderList();
  renderPanel();
  $("save").disabled = !dirty();
  $("revert").disabled = !dirty();
  $("dirty-count").textContent = dirty() ? `${edits.size + deleted.size} unsaved` : "";
  if (sim.started) updateClock();
}

/** Something about the script changed: recompute its timing, redraw now. */
function changed() {
  if (sim.started) sim.pending = true;
  schedulePreview();
  refresh();
}

// --- adding and deleting ----------------------------------------------------

/**
 * A new callout at a lap position, selected with its text ready to type over.
 *
 * Saved like any edit. Its speaking window cannot be drawn until it has been
 * saved and rendered — the window comes from the audio's duration, and there is
 * no audio yet — so it sits as a bare point until then.
 */
function addAt(p) {
  const id = mintId();
  const pctAt = (((p % 1) + 1) % 1);
  added.set(id, {
    id, pct: pctAt, text: "New callout", textShort: "New callout",
    priority: 1, leadAdjustS: 0, dirty: true,
    durationMs: 0, shortDurationMs: 0, overlaps: [],
    startPct: pctAt, runtimeStartPct: pctAt, leadS: 0, windowM: 0,
    suggestedLeadAdjustS: 0, nearestOnsetPct: null,
  });
  selectedId = id;
  edit(id, {});
  $("text").focus();
  $("text").select();
}

/**
 * Where "Add callout" puts one: the first corner, in lap order, that nothing is
 * already said about — a note from 300 m before its entry up to its apex counts.
 * Failing that, a little past the selected note, or the start of the lap.
 */
function nextFreeSpot() {
  const L = payload.lengthM;
  const ahead = (from, to) => ((((to - from) % 1) + 1) % 1) * L;
  const notes = allNotes().map((n) => current(n.id).pct);
  const corners = [...payload.corners].sort((a, b) => a.entryPct - b.entryPct);
  for (const c of corners) {
    const reach = 300 + ahead(c.entryPct, c.apexPct);
    if (!notes.some((p) => ahead(p, c.apexPct) <= reach)) return c.entryPct;
  }
  return selectedId !== null ? current(selectedId).pct + 200 / L : 0;
}

$("add").addEventListener("click", () => {
  if (payload !== null) addAt(nextFreeSpot());
});

$("map").addEventListener("dblclick", (event) => {
  if (payload === null || payload.x.length === 0) return;
  if (event.target.closest?.("[data-id]") != null) return;
  const [vx, vy] = toView(event);
  addAt(nearestPct(vx, vy));
});

$("delete").addEventListener("click", () => {
  if (selectedId === null) return;
  if (added.has(selectedId)) added.delete(selectedId);
  else deleted.add(selectedId);
  edits.delete(selectedId);
  selectedId = null;
  changed();
});

// --- editing ----------------------------------------------------------------

function edit(id, patch) {
  const note = current(id);
  edits.set(id, {
    pct: note.pct, text: note.text, textShort: note.textShort,
    leadAdjustS: note.leadAdjustS, ...patch,
  });
  changed();
}

$("map").addEventListener("mousedown", (event) => {
  const id = event.target.closest?.("[data-id]")?.dataset.id;
  if (id === undefined) return;
  selectedId = id;
  dragging = id;
  refresh();
});

window.addEventListener("mousemove", (event) => {
  if (dragging === null) return;
  const [vx, vy] = toView(event);
  edit(dragging, { pct: nearestPct(vx, vy) });
});

// Only after a drag. Redrawing on every mouseup replaced the labels between
// the two clicks of a double-click, so the browser never saw one — which is
// why double-clicking a label to edit it did nothing.
window.addEventListener("mouseup", () => {
  if (dragging === null) return;
  dragging = null;
  refresh();
});

// Double-click a label to edit it in place, which is where the text is read.
// --- the list: select, and edit the words in place ----------------------------

// Selecting re-marks the rows and redraws the map, but does not rebuild the
// list: a rebuilt list between the two clicks of a double-click means no
// double-click (the bug the map's text labels had).
function selectRow(row) {
  selectedId = row.dataset.id;
  for (const other of $("lap-list").querySelectorAll(".row.selected")) other.classList.remove("selected");
  row.classList.add("selected");
  draw();
  renderPanel();
}

$("lap-list").addEventListener("click", (event) => {
  const row = event.target.closest(".row");
  if (row === null || event.target.isContentEditable) return;
  selectRow(row);
});

// Double-click a callout's words to edit them where they are read. Not
// refresh() on the way in: that would rebuild the list and drop the edit.
$("lap-list").addEventListener("dblclick", (event) => {
  const text = event.target.closest(".row-text");
  if (text === null) return;
  selectRow(text.closest(".row"));
  text.contentEditable = "true";
  text.focus();
  document.getSelection()?.selectAllChildren(text);
});

$("lap-list").addEventListener("keydown", (event) => {
  const text = event.target.closest?.(".row-text");
  if (text === null || text.contentEditable !== "true") return;
  if (event.key === "Enter") {
    event.preventDefault();
    text.blur();
  } else if (event.key === "Escape") {
    // Put the old text back before blurring, or the blur would commit it.
    text.textContent = current(text.closest(".row").dataset.id).text;
    text.blur();
  }
});

$("lap-list").addEventListener("focusout", (event) => {
  const text = event.target.closest?.(".row-text");
  if (text === null || text.contentEditable !== "true") return;
  text.contentEditable = "false";
  const id = text.closest(".row").dataset.id;
  const value = text.textContent.trim();
  if (value !== "" && value !== current(id).text) edit(id, { text: value });
  else refresh();
});

// Double-click a turn's name to name it. Saved to the map straight away: it is
// a fact about the track, not part of this set's unsaved edits.
$("lap-list").addEventListener("dblclick", (event) => {
  const name = event.target.closest?.(".cname");
  if (!name) return;
  name.contentEditable = "true";
  if (name.classList.contains("unnamed")) name.textContent = "";
  name.classList.remove("unnamed");
  name.focus();
  document.getSelection()?.selectAllChildren(name);
});

$("lap-list").addEventListener("keydown", (event) => {
  const name = event.target.closest?.(".cname");
  if (!name || name.contentEditable !== "true") return;
  if (event.key === "Enter") {
    event.preventDefault();
    name.blur();
  } else if (event.key === "Escape") {
    name.dataset.cancel = "1";
    name.blur();
  }
});

$("lap-list").addEventListener("focusout", async (event) => {
  const name = event.target.closest?.(".cname");
  if (!name || name.contentEditable !== "true") return;
  name.contentEditable = "false";
  const turn = Number(name.closest(".turn").dataset.turn);
  const corner = payload.corners.find((c) => c.index === turn);
  const value = name.textContent.trim();
  if (name.dataset.cancel === "1" || corner === undefined || value === (corner.names[0] ?? "")) {
    delete name.dataset.cancel;
    refresh();
    return;
  }
  const corners = await window.exxeed.nameCorner(turn, value);
  if (corners === null) {
    setStatus("couldn't save the corner name — no map for this set", false);
  } else {
    payload = { ...payload, corners };
    chart.key = "";
    setStatus(value === "" ? `T${turn}'s name removed` : `T${turn} is “${value}”`, true);
  }
  refresh();
});

$("map").addEventListener("click", (event) => {
  if (event.target.closest?.("[data-id]") == null) {
    selectedId = null;
    refresh();
  }
});

$("text").addEventListener("input", (e) => edit(selectedId, { text: e.target.value }));
$("textShort").addEventListener("input", (e) => edit(selectedId, { textShort: e.target.value }));
$("lead").addEventListener("input", (e) => {
  const v = Number(e.target.value);
  if (Number.isFinite(v)) edit(selectedId, { leadAdjustS: v });
});

$("offset").addEventListener("change", (e) => {
  const metres = Number(e.target.value);
  if (!Number.isFinite(metres) || metres === 0 || selectedId === null) return;
  const note = current(selectedId);
  edit(selectedId, { pct: (((note.pct + metres / payload.lengthM) % 1) + 1) % 1 });
  e.target.value = "0";
});

$("snap").addEventListener("click", () => {
  const base = timing(selectedId);
  if (base?.nearestOnsetPct == null) return;
  edit(selectedId, { pct: base.nearestOnsetPct });
});

$("apply-suggestion").addEventListener("click", () => {
  const base = timing(selectedId);
  const note = current(selectedId);
  edit(selectedId, {
    leadAdjustS: Number((note.leadAdjustS + base.suggestedLeadAdjustS).toFixed(2)),
  });
});

/**
 * Stage 6, without leaving the window.
 *
 * A text edit makes the note's audio stale, and its duration sets lead distance
 * — so an edited note is mistimed until this runs, not merely mispronounced. The
 * window redraws from the new durations, which is the point: you see what the
 * longer sentence costs in track.
 */
/** Render audio's progress: the bar, which callout, and roughly how long is left. */
const rendering = { active: false, startedAt: 0, firstAt: 0, firstDone: 0 };

function rowFor(id) {
  return [...$("lap-list").querySelectorAll(".row")].find((r) => r.dataset.id === id) ?? null;
}

const fmtSeconds = (s) => (s < 60 ? `${Math.max(1, Math.round(s))} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`);

function showRenderStart() {
  rendering.active = true;
  rendering.startedAt = performance.now();
  rendering.firstAt = 0;
  $("render-progress").hidden = false;
  $("render-bar-wrap").classList.add("waiting");
  $("render-bar").style.width = "";
  $("render-text").textContent = "Starting the voice…";
  $("render-eta").textContent = "";
  $("render").textContent = "Rendering…";
}

window.exxeed.onRenderProgress(({ done, total, noteId, variant }) => {
  if (!rendering.active) return;
  const now = performance.now();
  // Timed from the first clip: before it, the voice model was loading.
  if (rendering.firstAt === 0) {
    rendering.firstAt = now;
    rendering.firstDone = done;
  }
  $("render-bar-wrap").classList.remove("waiting");
  $("render-bar").style.width = `${((done / total) * 100).toFixed(1)}%`;

  const numbers = new Map(ordered().map((n, i) => [n.id, i + 1]));
  const note = noteById(noteId);
  const words = variant === "full" ? note?.text : note?.textShort;
  $("render-text").textContent =
    `Rendering clip ${done} of ${total}` +
    (note === null ? "" : ` · ${numbers.get(noteId) ?? "?"}. “${words}”${variant === "short" ? " (short)" : ""}`);

  const clips = done - rendering.firstDone;
  if (clips >= 2 && done < total) {
    const perClip = (now - rendering.firstAt) / 1000 / clips;
    $("render-eta").textContent = `about ${fmtSeconds(perClip * (total - done))} left`;
  } else {
    $("render-eta").textContent = "";
  }

  // The list follows along: the callout being worked on, then a tick once
  // both of its clips are done.
  for (const row of $("lap-list").querySelectorAll(".row.rendering")) row.classList.remove("rendering");
  const row = rowFor(noteId);
  if (row !== null) {
    row.classList.add(variant === "short" ? "rendered" : "rendering");
    row.classList.remove("dirty");
  }
});

function showRenderEnd() {
  rendering.active = false;
  $("render-progress").hidden = true;
  $("render").textContent = "Render audio";
}

async function render() {
  if (payload === null || rendering.active) return;

  // Save first. Rendering reads the note set from disk, so unsaved text would be
  // silently rendered as the old words.
  if (dirty()) await save();

  const button = $("render");
  button.disabled = true;
  showRenderStart();

  const result = await window.exxeed.renderNotes();
  const took = (performance.now() - rendering.startedAt) / 1000;
  showRenderEnd();
  button.disabled = false;

  if (result.ok && result.payload !== null) {
    payload = result.payload;
    edits.clear();
    schedulePreview();
    // New clips: Play lap decodes them again next time it starts.
    sim.buffers = null;
    refresh();
  }
  setStatus(result.ok ? `${result.message} in ${fmtSeconds(took)}` : result.message, result.ok);
}

$("render").addEventListener("click", () => void render());
window.exxeed.onRenderRequested(() => void render());

let statusTimer = null;
function setStatus(text, ok) {
  const el = $("status");
  el.textContent = text;
  el.className = ok === null ? "meta" : `meta ${ok ? "ok" : "bad"}`;
  if (statusTimer !== null) clearTimeout(statusTimer);
  if (ok !== null) statusTimer = setTimeout(() => { el.textContent = ""; }, 6000);
}

$("revert").addEventListener("click", () => {
  edits.clear();
  added.clear();
  deleted.clear();
  if (selectedId !== null && noteById(selectedId) === null) selectedId = null;
  changed();
});

async function save() {
  const next = await window.exxeed.saveNotes(patchList());
  if (next !== null) {
    payload = next;
    edits.clear();
    added.clear();
    deleted.clear();
    // Saved is what the preview was showing: nothing to wait for.
    schedulePreview();
  }
  refresh();
}

$("save").addEventListener("click", () => void save());

window.addEventListener("resize", refresh);

// Braking on the map, on or off; remembered between windows.
const BRAKING_KEY = "exxeed.editor.showBraking";
try {
  $("show-braking").checked = localStorage.getItem(BRAKING_KEY) !== "off";
} catch {
  // No storage: just start with it on.
}
const applyBraking = () => $("map").classList.toggle("braking-off", !$("show-braking").checked);
applyBraking();
// The inputs chart, on or off; remembered the same way.
const INPUTS_KEY = "exxeed.editor.showInputs";
try {
  $("show-inputs").checked = localStorage.getItem(INPUTS_KEY) !== "off";
} catch {
  // No storage: start with it on.
}
$("show-inputs").addEventListener("change", () => {
  // The map gets the room back, so redraw both.
  refresh();
  try {
    localStorage.setItem(INPUTS_KEY, $("show-inputs").checked ? "on" : "off");
  } catch {
    // Not remembered; still applied.
  }
});
$("show-braking").addEventListener("change", () => {
  applyBraking();
  try {
    localStorage.setItem(BRAKING_KEY, $("show-braking").checked ? "on" : "off");
  } catch {
    // Not remembered; still applied.
  }
});

// ---------------------------------------------------------------------------
// Speaking speed
// ---------------------------------------------------------------------------
//
// The driver's setting, not the note set's: the field here writes the same
// setting Preferences does, and follows it when it is changed there. A faster
// callout is a shorter one, and a shorter one starts later — so every blue
// section on the map is re-timed by main, the way a session will time it.

/** Main's timing at a new rate: the notes as saved, and as edited. */
async function retime(rate) {
  if (payload === null) return;
  const saved = await window.exxeed.previewNotes([]);
  if (saved === null) return;
  // The notes as saved keep their words and places; only their timing is new.
  // Edits not yet saved stay edits, and get the same timing through `preview`.
  payload = { ...payload, speechRate: rate, notes: saved };
  if (dirty()) {
    const edited = await window.exxeed.previewNotes(patchList());
    preview = edited === null ? null : new Map(edited.map((n) => [n.id, n]));
  } else {
    preview = null;
  }
  // A lap already playing was planned at the old rate; the next one is right.
  sim.pending = sim.started;
  draw();
  renderPanel();
}

$("speech-rate").addEventListener("change", (e) => {
  const v = Number(e.target.value);
  // Main brings an out-of-range value back in, and says what it kept below.
  if (Number.isFinite(v) && v > 0) void window.exxeed.setSettings({ speechRate: v });
  else e.target.value = String(payload?.speechRate ?? 1);
});

// Changed here, or in Preferences while this window is open: either way main
// tells every window, and this is the one place the editor acts on it.
window.exxeed.onSettingsChanged((changed) => {
  const rate = changed?.settings?.speechRate;
  if (typeof rate !== "number") return;
  // Also when it was typed here: main may have brought it into range.
  if (Number($("speech-rate").value) !== rate) $("speech-rate").value = String(rate);
  if (payload !== null && rate !== payload.speechRate) void retime(rate);
});

window.exxeed.loadNotes().then((data) => {
  payload = data;
  if (payload === null) {
    $("title").textContent = "no note set selected — choose one in preferences";
    return;
  }
  $("title").textContent =
    `${payload.title} · ${payload.notes.length} callouts · ${payload.status}` +
    (payload.hasReference ? "" : " · no reference lap, so no speaking windows");
  $("speech-rate").value = String(payload.speechRate ?? 1);


  // Play lap drives the reference lap over the map: it needs both.
  $("play").disabled = !canPlay();
  $("scrub").disabled = !canPlay();
  if (!canPlay()) {
    $("play").title = payload.x.length === 0 ? "No map of this track on this machine" : "Needs a reference lap: drive or import one";
  } else {
    updateClock();
  }

  // Maps are per machine (data/tracks is gitignored), so a note set can arrive
  // without the track it was written for. Say so rather than show an empty panel.
  if (payload.x.length === 0) {
    $("no-map").hidden = false;
    $("no-map").textContent =
      `There's no track map for ${payload.title} on this machine, so there's nothing to draw ` +
      `the ${payload.notes.length} callouts on. Drive a clean lap there with Exxeed running and ` +
      `the map is cut automatically — or copy the track's folders from data/tracks and ` +
      `data/reflaps on the machine that has them.`;
  }

  if (!payload.canRender) {
    $("render").disabled = true;
    $("render").title = "Set a Piper voice model in preferences to render audio";
  }
  refresh();
});
