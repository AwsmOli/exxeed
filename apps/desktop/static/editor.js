// The note editor — SPEC.md §7.4. SVG and plain DOM; everything here changes at
// human speed, so none of §7.0's hot-path rules apply.

const $ = (id) => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";
const VIEW = 1000;
const PAD = 46;

/** Server truth, and the edits sitting on top of it. */
let payload = null;
const edits = new Map();
let selectedId = null;
let dragging = null;

const noteById = (id) => payload?.notes.find((n) => n.id === id) ?? null;

/** A note as it currently stands: what the server sent, plus any local edit. */
const current = (id) => ({ ...noteById(id), ...(edits.get(id) ?? {}) });

const dirty = () => edits.size > 0;

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

function draw() {
  const svg = $("map");
  const labels = $("labels");
  const placed = [];
  svg.replaceChildren();
  labels.replaceChildren();
  if (payload === null || payload.x.length === 0) return;

  svg.append(el("path", { d: `${arc(0, 0.9999)}Z`, class: "track" }));

  for (const corner of payload.corners) {
    svg.append(el("path", { d: arc(corner.entryPct, corner.exitPct), class: "corner" }));
  }

  const [sx, sy] = pointAt(0);
  svg.append(el("rect", { x: sx - 5, y: sy - 5, width: 10, height: 10, class: "sf" }));

  for (const base of payload.notes) {
    const note = current(base.id);
    const selected = note.id === selectedId;

    if (payload.hasReference) {
      // The arc of track this callout is speaking over. Stale once the text has
      // been edited: the duration it was computed from belongs to the old words.
      const classes = ["window"];
      if (note.dirty || edits.has(note.id)) classes.push("stale");
      else if (base.overlaps.length > 0) classes.push("clash");
      if (selected) classes.push("selected");

      svg.append(el("path", { d: arc(base.startPct, note.pct), class: classes.join(" ") }));
      svg.append(el("path", { d: arc(base.runtimeStartPct, note.pct), class: "runtime" }));
    }

    const [x, y] = pointAt(indexOfPct(note.pct));
    const dot = el("circle", {
      cx: x, cy: y, r: selected ? 8 : 6,
      class: `dot${selected ? " selected" : ""}`,
      "data-id": note.id,
    });
    svg.append(dot);

    const label = document.createElement("div");
    label.className = `label${selected ? " selected" : ""}${note.dirty || edits.has(note.id) ? " dirty" : ""}`;
    label.textContent = note.text;
    label.dataset.id = note.id;
    labels.append(label);
    placed.push({ label, x, y });
  }

  for (const p of placed) place(p.label, p.x, p.y);
  separate(placed.map((p) => p.label));
}

/**
 * Push overlapping labels apart, vertically.
 *
 * Corners cluster — Daytona's turn 1 and turn 4 sit close enough that their
 * labels covered each other — and a callout you cannot read is the one thing
 * §7.4's "whole lap's script readable at a glance" cannot afford. Greedy and
 * top-down: good enough for a dozen labels, and it keeps each one near its own
 * point rather than reflowing the lot.
 */
function separate(labels) {
  const boxes = labels
    .map((label) => ({ label, top: label.offsetTop, height: label.offsetHeight }))
    .sort((a, b) => a.top - b.top);

  const GAP = 4;
  for (let i = 1; i < boxes.length; i++) {
    const previous = boxes[i - 1];
    const box = boxes[i];
    const overlapsVertically = box.top < previous.top + previous.height + GAP;
    if (!overlapsVertically) continue;

    // Only a problem if they also share horizontal space.
    const a = previous.label;
    const b = box.label;
    const apart =
      a.offsetLeft + a.offsetWidth < b.offsetLeft || b.offsetLeft + b.offsetWidth < a.offsetLeft;
    if (apart) continue;

    box.top = previous.top + previous.height + GAP;
    box.label.style.top = `${box.top}px`;
  }
}

/**
 * Put a label over its point, kept inside the map.
 *
 * Measured after appending rather than computed: the text wraps, so the height is
 * not known until the browser has laid it out. A label near an edge would
 * otherwise hang half outside the panel with its words cut off.
 */
function place(label, x, y) {
  const box = $("map").getBoundingClientRect();
  const scale = Math.min(box.width, box.height) / VIEW;
  const px = (box.width - VIEW * scale) / 2 + x * scale;
  const py = (box.height - VIEW * scale) / 2 + y * scale;

  const w = label.offsetWidth;
  const h = label.offsetHeight;
  const left = Math.min(Math.max(px - w / 2, 4), box.width - w - 4);
  // Above the point by preference; below it when there is no room above.
  const top = py - h - 12 < 4 ? py + 12 : py - h - 12;

  label.style.transform = "none";
  label.style.left = `${left}px`;
  label.style.top = `${Math.min(top, box.height - h - 4)}px`;
}

// --- panel ------------------------------------------------------------------

function renderPanel() {
  const has = selectedId !== null && noteById(selectedId) !== null;
  $("empty").hidden = has;
  $("detail").hidden = !has;
  if (!has) return;

  const base = noteById(selectedId);
  const note = current(selectedId);

  $("detail-id").textContent = note.id;
  if (document.activeElement !== $("text")) $("text").value = note.text;
  if (document.activeElement !== $("textShort")) $("textShort").value = note.textShort;
  if (document.activeElement !== $("lead")) $("lead").value = String(note.leadAdjustS);

  $("stat-lead").textContent = payload.hasReference ? `${base.leadS.toFixed(2)}s` : "—";
  $("stat-window").textContent = payload.hasReference ? `${base.windowM.toFixed(0)}m back` : "—";
  $("stat-audio").textContent = `${base.durationMs}ms / ${base.shortDurationMs}ms`;
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

  const isStale = note.dirty || edits.has(selectedId);
  $("stale").hidden = !isStale;
  if (isStale) {
    $("stale").textContent =
      "The audio no longer matches this text, so the window above is drawn from " +
      "the old duration. Re-render to see the real one: exxeed-ingest render.";
  }

  $("snap").disabled = base.nearestOnsetPct === null;
}

function refresh() {
  draw();
  renderPanel();
  $("save").disabled = !dirty();
  $("revert").disabled = !dirty();
  $("dirty-count").textContent = dirty() ? `${edits.size} unsaved` : "";
}

// --- editing ----------------------------------------------------------------

function edit(id, patch) {
  const note = current(id);
  edits.set(id, {
    pct: note.pct, text: note.text, textShort: note.textShort,
    leadAdjustS: note.leadAdjustS, ...patch,
  });
  refresh();
}

$("map").addEventListener("mousedown", (event) => {
  const id = event.target?.dataset?.id;
  if (id === undefined) return;
  selectedId = id;
  dragging = id;
  event.target.classList.add("dragging");
  refresh();
});

window.addEventListener("mousemove", (event) => {
  if (dragging === null) return;
  const [vx, vy] = toView(event);
  edit(dragging, { pct: nearestPct(vx, vy) });
});

window.addEventListener("mouseup", () => {
  dragging = null;
  refresh();
});

// Double-click a label to edit it in place, which is where the text is read.
$("labels").addEventListener("dblclick", (event) => {
  const label = event.target.closest(".label");
  if (label === null) return;
  selectedId = label.dataset.id;
  label.contentEditable = "true";
  label.focus();
  document.getSelection()?.selectAllChildren(label);
  refresh();
});

$("labels").addEventListener("keydown", (event) => {
  const label = event.target.closest?.(".label");
  if (label === null || label.contentEditable !== "true") return;

  if (event.key === "Enter") {
    event.preventDefault();
    label.blur();
  } else if (event.key === "Escape") {
    // Put the old text back before blurring, or the blur would commit it.
    label.textContent = current(label.dataset.id).text;
    label.blur();
  }
});

$("labels").addEventListener("focusout", (event) => {
  const label = event.target.closest?.(".label");
  if (label === null || label.contentEditable !== "true") return;
  label.contentEditable = "false";

  const text = label.textContent.trim();
  if (text !== "" && text !== current(label.dataset.id).text) edit(label.dataset.id, { text });
  else refresh();
});

$("map").addEventListener("click", (event) => {
  if (event.target?.dataset?.id === undefined && event.target.tagName !== "circle") {
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
  const base = noteById(selectedId);
  if (base?.nearestOnsetPct == null) return;
  edit(selectedId, { pct: base.nearestOnsetPct });
});

$("apply-suggestion").addEventListener("click", () => {
  const base = noteById(selectedId);
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
async function render() {
  if (payload === null) return;

  // Save first. Rendering reads the note set from disk, so unsaved text would be
  // silently rendered as the old words.
  if (dirty()) await save();

  const button = $("render");
  button.disabled = true;
  setStatus("rendering…", null);

  const result = await window.exxeed.renderNotes();
  button.disabled = false;

  if (result.ok && result.payload !== null) {
    payload = result.payload;
    edits.clear();
    refresh();
  }
  setStatus(result.message, result.ok);
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
  refresh();
});

async function save() {
  const patches = [...edits.entries()].map(([id, patch]) => ({ id, ...patch }));
  const next = await window.exxeed.saveNotes(patches);
  if (next !== null) {
    payload = next;
    edits.clear();
  }
  refresh();
}

$("save").addEventListener("click", () => void save());

window.addEventListener("resize", refresh);

window.exxeed.loadNotes().then((data) => {
  payload = data;
  if (payload === null) {
    $("title").textContent = "no note set selected — choose one in preferences";
    return;
  }
  $("title").textContent =
    `${payload.title} · ${payload.notes.length} callouts · ${payload.status}` +
    (payload.hasReference ? "" : " · no reference lap, so no speaking windows");

  if (!payload.canRender) {
    $("render").disabled = true;
    $("render").title = "Set a Piper voice model in preferences to render audio";
  }
  refresh();
});
