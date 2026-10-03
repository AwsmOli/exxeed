// The overlay renderer — SPEC.md §7.
//
// One document serves every overlay window; the panel is chosen by query
// string (`?overlay=1&panel=map`). This file is the part every panel shares:
// the IPC subscriptions, one plain state object, dragging, audio, and a single
// requestAnimationFrame loop. The panels themselves live in ./panels/, one
// function each, and build their own DOM.
//
// §7.0's discipline holds throughout: nothing here is reactive. Channels write
// into `state`, and the rAF loop reads it. The car moves at the display's rate,
// not the telemetry's, and no framework re-renders on a 60 Hz frame.

import { PANELS } from "./panels/index.js";
import { COLORS, refreshColors } from "./panels/util.js";

/**
 * Window sizes, for laying the panels out on their own outside overlay mode.
 * A copy of PANEL_SPECS in @exxeed/overlays — this page is plain JS and
 * cannot import it — so only ever a preview's business, never a window's.
 */
const SIZES = {
  inputs: [540, 110],
  pedals: [560, 170],
  trace: [640, 150],
  speed: [640, 140],
  brake: [300, 72],
  revlights: [520, 44],
  delta: [340, 72],
  sectors: [300, 230],
  corners: [340, 220],
  reference: [360, 190],
  standings: [640, 420],
  relative: [440, 360],
  radar: [260, 260],
  "spotter-left": [150, 130],
  "spotter-right": [150, 130],
  flags: [260, 120],
  map: [360, 360],
  minimap: [230, 230],
  fuel: [260, 340],
  tyres: [260, 390],
  damage: [220, 100],
  weather: [400, 130],
  callouts: [320, 220],
  telemetry: [300, 340],
};

const params = new URLSearchParams(location.search);
const isOverlay = params.get("overlay") === "1";
if (isOverlay) document.body.classList.add("overlay");

/**
 * Everything the panels draw from. Replaced field by field as channels
 * arrive; `v` counts updates so a panel that rebuilds DOM can tell whether
 * anything changed since it last did.
 */
const state = {
  frame: null,
  map: null,
  reference: null,
  race: null,
  status: null,
  /** Recent samples by lap position, for the comparison panels (§7.1). */
  history: [],
  /** Recent samples by time, for the input-telemetry trace. */
  timeline: [],
  /** Newest first. */
  events: [],
  clips: 0,
  frames: 0,
  /** What this window's overlay shows and how it is built (panel-options.ts). */
  options: { hidden: new Set(), style: null },
  v: { map: 0, reference: 0, race: 0, events: 0 },
};

const HISTORY = 2400; // ~75 s at 32 Hz, comfortably more than one window
const TIMELINE_MS = 8000;
const LOG_LENGTH = 14;

// One panel per overlay window; every panel, stacked, when the page is opened
// on its own for development.
const root = document.getElementById("root");
const wanted = params.get("panel");
const ids = wanted !== null && PANELS[wanted] ? [wanted] : Object.keys(PANELS);
if (wanted !== null) document.body.classList.add(`panel-${wanted}`);

/**
 * Build one panel, with a theme's template for it if the theme has one
 * (template.js). Only panels made from a model and a template take one.
 */
function build(id, template = null) {
  const panel = PANELS[id](template);
  panel.el.dataset.panel = id;
  if (!isOverlay) {
    // Laid out at the window size main would open it at, so this page shows
    // each panel as it will look.
    const spec = SIZES[id];
    if (spec !== undefined) {
      panel.el.style.width = `${spec[0] - 8}px`;
      panel.el.style.height = `${spec[1] - 8}px`;
    }
  }
  return panel;
}

const mounted = ids.map((id) => {
  const panel = build(id);
  root.append(panel.el);
  return panel;
});
/** The theme template each panel was last built with: null for its own. */
const builtWith = ids.map(() => null);

/** Rebuild the panels whose template the theme changes. */
function applyTemplates(templates) {
  ids.forEach((id, i) => {
    // Its own template, or its family's (one spotter.html for both sides).
    const family = PANELS[id].family;
    const own = templates?.[id] ?? (family !== undefined ? templates?.[family] : undefined);
    const wanted = typeof own === "string" ? own : null;
    if (wanted === builtWith[i] || PANELS[id].template === undefined) return;
    const next = build(id, wanted);
    mounted[i].el.replaceWith(next.el);
    mounted[i] = next;
    builtWith[i] = wanted;
  });
}

// ---------------------------------------------------------------------------
// Size: every overlay is laid out at one design size — the theme's for it,
// else the app's — and scaled, whole, to its window. Main keeps the window
// in that shape, so resizing makes the overlay bigger or smaller and never
// rearranges what is inside it.
// ---------------------------------------------------------------------------

/** [width, height] this overlay is designed at: from main, then from the theme. */
let design = [Number(params.get("w")) || 0, Number(params.get("h")) || 0];
let fitToWindow = () => {};

if (isOverlay) {
  fitToWindow = () => {
    const inset = 8; // #root's inset on both sides (overlay.css --inset)
    const w = Math.max(1, window.innerWidth - inset);
    const h = Math.max(1, window.innerHeight - inset);
    const [dw, dh] = design[0] > 0 && design[1] > 0 ? [design[0] - inset, design[1] - inset] : [w, h];
    const scale = Math.min(w / dw, h / dh);
    root.style.transformOrigin = "0 0";
    root.style.transform = `scale(${scale})`;
    root.style.right = "auto";
    root.style.bottom = "auto";
    root.style.width = `${dw}px`;
    root.style.height = `${dh}px`;
    document.body.style.setProperty("--fit-scale", String(scale));
  };
  fitToWindow();
  window.addEventListener("resize", fitToWindow);
}

// ---------------------------------------------------------------------------
// Dragging
//
// `movementX`/`movementY` — how far the POINTER moved — rather than any
// position. Both `clientX` and `screenX` are derived from the window's own
// origin, so while the window is being dragged they feed its movement back
// into the next delta. Measured: a 530px drag using screenX moved the window
// 577px, about 9% of overshoot, which feels like the panel sliding out from
// under the cursor. Pointer deltas have no such coupling and track exactly.
//
// Done here rather than with -webkit-app-region because that swallows every
// mouse event in its region — no click/drag distinction, no cursor of our own,
// and inconsistent behaviour on transparent frameless windows.
// ---------------------------------------------------------------------------

// Grabbable from the moment the window opens, matching main: overlays are not
// click-through unless asked to be.
let editing = true;
document.body.classList.add("editing");

window.exxeed?.onEditMode((on) => {
  editing = on === true;
  document.body.classList.toggle("editing", editing);
});

let dragging = false;

document.addEventListener("mousedown", (event) => {
  if (!isOverlay || !editing || event.button !== 0) return;
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

// ---------------------------------------------------------------------------
// Audio. Node has no sound output, so one overlay window is the output device
// — main decides which, and what to play when (§7). This only turns a key into
// sound.
// ---------------------------------------------------------------------------

const audio = new AudioContext();
const decoded = new Map();

// Decode once, at preload. §3 chose WAV over MP3 precisely so no decode
// happens at trigger time; doing it here rather than on play is the other
// half of that.
window.exxeed?.onAudioPreload(async (clips) => {
  for (const clip of clips) {
    try {
      const copy = new Uint8Array(clip.wav).buffer;
      decoded.set(clip.key, await audio.decodeAudioData(copy));
    } catch (err) {
      console.error(`could not decode ${clip.key}`, err);
    }
  }
  state.clips = decoded.size;
});

const log = (text, className) => {
  state.events = [{ text, className }, ...state.events].slice(0, LOG_LENGTH);
  state.v.events++;
};

window.exxeed?.onAudioPlay((command) => {
  const buffer = decoded.get(command.key);
  if (buffer === undefined) {
    log(`${command.key} — no clip rendered`, "drop");
    return;
  }
  if (audio.state === "suspended") void audio.resume();
  const node = audio.createBufferSource();
  node.buffer = buffer;
  node.connect(audio.destination);
  node.start();
});

// §7.3: what the engine decided, including what it withheld.
window.exxeed?.onEngineEvent((e) => {
  if (e.kind === "play") {
    log(`${e.noteId} ${e.detail} · lead ${(e.leadM ?? 0).toFixed(0)}m`, "play");
  } else {
    log(`${e.noteId} dropped · ${e.detail} · ${(e.dAheadM ?? 0).toFixed(0)}m out`, "drop");
  }
});

// ---------------------------------------------------------------------------
// Channels → state.
// ---------------------------------------------------------------------------

window.exxeed?.onStateFrame((f) => {
  state.frames++;
  state.frame = f;
  if (typeof f.lapDistPct === "number" && f.connected) {
    state.history.push({ pct: f.lapDistPct, throttle: f.throttle ?? 0, brake: f.brake ?? 0, speed: f.speedMps ?? 0 });
    if (state.history.length > HISTORY) state.history.shift();

    const now = performance.now();
    state.timeline.push({ t: now, throttle: f.throttle ?? 0, brake: f.brake ?? 0 });
    while (state.timeline.length > 0 && now - state.timeline[0].t > TIMELINE_MS) state.timeline.shift();
  }
  // Panels that split the lap (sectors, corners) need every frame, not every
  // paint — a boundary crossed between two paints would otherwise be missed.
  for (const panel of mounted) panel.frame?.(state);
});

// What this overlay shows: hidden parts and the chosen structure, per profile
// (panel-options.ts). A hidden part is anything carrying its id in data-part;
// panels that build rows from columns read `state.options` themselves.
const partRules = document.createElement("style");
document.head.append(partRules);
function applyPanelSettings(settings) {
  if (settings === null || typeof settings !== "object") return;
  const hidden = Array.isArray(settings.hidden) ? settings.hidden.filter((h) => /^[a-z]+$/.test(h)) : [];
  state.options = { hidden: new Set(hidden), style: typeof settings.style === "string" ? settings.style : null };
  partRules.textContent = hidden.map((id) => `[data-part~="${id}"]{display:none!important}`).join("\n");
  document.body.dataset.style = state.options.style ?? "";
  // For a theme's stylesheet: body[data-hidden~="revlights"] when the rev lights are off.
  document.body.dataset.hidden = hidden.join(" ");
  // Rows are rebuilt from columns, so they need telling.
  state.v.race++;
}
if (isOverlay && wanted !== null) {
  window.exxeed?.getPanelSettings?.(wanted).then(applyPanelSettings);
  window.exxeed?.onPanelSettings?.((message) => {
    if (message?.panel === wanted) applyPanelSettings(message.settings);
  });
}

// The theme: tokens written over the stylesheet's defaults, then the canvas
// palette refilled from them. Live — nothing is rebuilt or restarted.
let themed = [];
const themeCss = document.createElement("style");
themeCss.id = "theme-css";
document.head.append(themeCss);
function applyTheme(theme) {
  if (theme === null || typeof theme !== "object") return;
  const root = document.documentElement;
  for (const name of themed) root.style.removeProperty(name);
  themed = Object.keys(theme.variables ?? {});
  for (const name of themed) root.style.setProperty(name, theme.variables[name]);
  root.dataset.theme = theme.id;
  root.dataset.base = theme.base ?? theme.id;
  // How rows are built (overlay.css [data-layout]): the theme's choice, or its base's.
  root.dataset.layout = theme.layout ?? "wash";
  // The size this overlay is designed at in this theme (main reshapes the window to match).
  const sized = wanted !== null ? theme.sizes?.[wanted] : undefined;
  if (Array.isArray(sized) && sized.length === 2) {
    design = [Number(sized[0]), Number(sized[1])];
    fitToWindow();
  } else if (wanted !== null && SIZES[wanted] !== undefined) {
    // No size of its own in this theme: the app's (PANEL_SPECS, mirrored in SIZES).
    design = [...SIZES[wanted]];
    fitToWindow();
  }
  // The theme's own stylesheet, over the built-in one, and its templates.
  themeCss.textContent = typeof theme.css === "string" ? theme.css : "";
  applyTemplates(theme.templates ?? {});
  refreshColors();
  document.documentElement.dataset.shift = COLORS.shiftStyle;
  // Panels that draw their DOM from state redraw with the new colours. Not the
  // map: its version also keys the heat map, which a theme should not wipe.
  state.v.race++;
  state.v.reference++;
  state.v.events++;
}
window.exxeed?.getTheme?.().then(applyTheme);
window.exxeed?.onTheme?.(applyTheme);

window.exxeed?.onMap((view) => {
  state.map = view;
  state.v.map++;
});

window.exxeed?.onReference((view) => {
  state.reference = view;
  state.v.reference++;
});

window.exxeed?.onRace?.((view) => {
  state.race = view ?? null;
  state.v.race++;
});

window.exxeed?.onSessionStatus((status) => {
  state.status = status;
});

// ---------------------------------------------------------------------------
// The one paint loop.
// ---------------------------------------------------------------------------

const reported = new Set();

requestAnimationFrame(function paint() {
  requestAnimationFrame(paint);
  for (const panel of mounted) {
    try {
      panel.draw?.(state);
    } catch (err) {
      // One broken panel must not take the others down with it — and without
      // this a draw error is silent: the canvas just stays blank. Once per
      // panel, or main's console forwarding gets it sixty times a second.
      const id = panel.el.dataset.panel;
      if (!reported.has(id)) {
        reported.add(id);
        console.error(`panel ${id}: ${err?.stack ?? err}`);
      }
    }
  }
});
