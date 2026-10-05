// The overlay profile editor, in the control window's Overlays section.
//
// A profile is which overlays are on, where each sits and how big it is, what
// each shows, and the theme they wear. On the left, every overlay with a
// switch; in the middle, the screen at the profile's resolution with each
// overlay on it — the real overlay page in an iframe, fed a sample lap — to
// drag and size; on the right, the chosen overlay's options, or the profile's
// own when none is chosen.
//
// The overlay windows themselves stay one per overlay. Placing one here moves
// its window too, when the profile is the one in use.

const el = (id) => document.getElementById(id);

const make = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
};

/** How close, in screen pixels on the editor, an edge has to come to snap. */
const SNAP_PX = 8;

/**
 * `groups`: [name, panelIds][] for the list; `labels`: panel id → name;
 * `order`: every panel id in list order; `send`: an overlay profile command;
 * `changed`: called when the editor opens a profile or closes.
 */
export function createProfileEditor({ groups, labels, order, send, changed = () => {} }) {
  const api = window.exxeed;
  let profileId = null;
  let view = null;
  /** OverlayEditorLayout from main: the screen, each overlay's place and design size, the screenshot. */
  let layout = null;
  let selected = null;
  /** panel id → { box, frame, loaded, settingsKey } for each overlay on the stage. */
  const items = new Map();
  let theme = null;
  let themeKey = "";
  /** The sample lap's slower channels, for an overlay that loads after they were sent. */
  const sticky = { map: null, reference: null, race: null };
  /** Set while a drag or resize is in progress: layouts that arrive meanwhile wait. */
  let gesture = null;
  let refreshPending = false;
  let refreshing = false;

  const profile = () => view?.profiles.find((p) => p.id === profileId) ?? null;
  const settingsOf = (panel) => profile()?.settings?.[panel] ?? { hidden: [], style: null };
  const enabled = (panel) => profile()?.panels.includes(panel) ?? false;
  const panelIds = () => (view?.debugEnabled ? order : order.filter((p) => p !== "telemetry"));

  // -- Feeding the previews -------------------------------------------------

  const post = (item, channel, payload) => item.frame.contentWindow?.postMessage({ channel, payload }, "*");
  const postAll = (channel, payload) => {
    for (const item of items.values()) if (item.loaded) post(item, channel, payload);
  };

  // Main sends the sample lap to this window only while the editor is open.
  api?.onStateFrame?.((frame) => postAll("frame", frame));
  api?.onEngineEvent?.((event) => postAll("engine-event", event));
  api?.onMap?.((map) => {
    sticky.map = map;
    postAll("map", map);
  });
  api?.onReference?.((reference) => {
    sticky.reference = reference;
    postAll("reference", reference);
  });
  api?.onRace?.((race) => {
    sticky.race = race;
    postAll("race", race);
  });
  api?.onOverlayLayoutChanged?.((message) => {
    if (message?.profileId === profileId) void refresh();
  });

  /** Everything a preview needs once it has loaded, and again whenever it changes. */
  function catchUp(id, item) {
    post(item, "edit-mode", true);
    if (theme !== null) post(item, "theme", theme);
    for (const [channel, payload] of Object.entries(sticky)) if (payload !== null) post(item, channel, payload);
    post(item, "panel-settings", { panel: id, settings: settingsOf(id) });
    item.settingsKey = JSON.stringify(settingsOf(id));
  }

  // -- Opening and closing ----------------------------------------------------

  function open(id) {
    profileId = id;
    selected = null;
    document.body.classList.add("ov-editing");
    el("ov-home").hidden = true;
    el("ov-editor").hidden = false;
    void api?.overlayEditor?.({ op: "open", open: true });
    renderChrome();
    changed();
    void refresh();
  }

  function close() {
    profileId = null;
    layout = null;
    theme = null;
    themeKey = "";
    gesture = null;
    for (const item of items.values()) item.box.remove();
    items.clear();
    document.body.classList.remove("ov-editing");
    el("ov-home").hidden = false;
    el("ov-editor").hidden = true;
    void api?.overlayEditor?.({ op: "open", open: false });
    changed();
  }

  /** The profile list changed: redraw what depends on it, then re-read the layout. */
  function render(next) {
    view = next;
    if (profileId === null) return;
    if (profile() === null) {
      close();
      return;
    }
    renderChrome();
    void refresh();
  }

  /** Re-read the screen, places and theme from main, unless a drag would be disturbed. */
  async function refresh() {
    if (profileId === null) return;
    if (gesture !== null || refreshing) {
      refreshPending = true;
      return;
    }
    refreshing = true;
    try {
      const id = profileId;
      const p = profile();
      const [nextLayout, nextTheme] = await Promise.all([
        api.overlayEditor({ op: "layout", profileId: id }),
        api.overlayEditor({ op: "theme", id: p?.theme ?? view?.themeId ?? "" }),
      ]);
      if (id !== profileId) return;
      layout = nextLayout;
      const key = JSON.stringify(nextTheme);
      if (key !== themeKey) {
        themeKey = key;
        theme = nextTheme;
        postAll("theme", theme);
      }
      drawStage();
      renderInspector();
    } catch (err) {
      console.error(`profile editor: ${err?.message ?? err}`);
    } finally {
      refreshing = false;
      if (refreshPending && gesture === null) {
        refreshPending = false;
        void refresh();
      }
    }
  }

  // -- The bar, the list, the inspector ---------------------------------------

  function renderChrome() {
    const p = profile();
    if (p === null) return;
    const isActive = p.id === view.activeProfileId;
    const name = el("ove-name");
    if (document.activeElement !== name) name.value = p.name;
    el("ove-active").hidden = !isActive;
    el("ove-use").hidden = isActive;
    const arranging = isActive && view.editing;
    el("ove-arrange").textContent = arranging ? "Done on screen" : "Show on screen";
    el("ove-arrange").className = arranging ? "ghost primary" : "ghost";
    el("ove-shot-clear").hidden = p.hasBackground !== true;
    renderList();
    renderInspector();
  }

  function renderList() {
    const list = el("ove-list");
    const ids = panelIds();
    const nodes = [];
    for (const [group, members] of groups) {
      const shown = members.filter((id) => ids.includes(id));
      if (shown.length === 0) continue;
      nodes.push(make("div", { className: "ove-group", textContent: group }));
      for (const id of shown) {
        const on = enabled(id);
        const s = settingsOf(id);
        const row = make("div", { className: `ove-item${on ? " on" : ""}${selected === id ? " selected" : ""}` });
        const toggle = make("input", { type: "checkbox", className: "switch", checked: on, title: on ? "Switch off" : "Switch on" });
        toggle.addEventListener("click", (e) => e.stopPropagation());
        toggle.addEventListener("change", () => setEnabled(id, toggle.checked, toggle));
        row.append(toggle, make("span", { className: "label", textContent: labels[id] ?? id }));
        if (s.hidden.length > 0 || s.style !== null) row.append(make("span", { className: "changed", title: "Some options changed" }));
        row.addEventListener("click", () => select(id));
        nodes.push(row);
      }
    }
    list.replaceChildren(...nodes);
  }

  function setEnabled(id, on, toggle) {
    const p = profile();
    // In list order — and keeping any this build does not list (telemetry is debug-only).
    const chosen = order.filter((x) => (x === id ? on : p.panels.includes(x)));
    // An empty profile would open no windows at all, with no way back inside the app.
    if (chosen.length === 0) {
      toggle.checked = true;
      return;
    }
    if (on) selected = id;
    send({ kind: "setPanels", id: p.id, panels: chosen });
  }

  function select(id) {
    selected = id;
    for (const [panel, item] of items) item.box.classList.toggle("selected", panel === id);
    renderList();
    renderInspector();
  }

  function renderInspector() {
    const box = el("ove-panel-opts");
    const p = profile();
    if (p === null || selected === null) {
      box.hidden = true;
      el("ove-profile-opts").hidden = false;
      return;
    }
    box.hidden = false;
    el("ove-profile-opts").hidden = true;
    const id = selected;
    const s = settingsOf(id);
    const on = enabled(id);

    const toggle = make("input", { type: "checkbox", className: "switch", checked: on });
    toggle.addEventListener("change", () => setEnabled(id, toggle.checked, toggle));
    const back = make("button", { className: "ghost", type: "button", textContent: "Profile", title: "Back to the profile's settings" });
    back.addEventListener("click", () => select(null));
    const nodes = [make("div", { className: "ove-title" }, toggle, make("span", { textContent: labels[id] ?? id, style: "flex:1" }), back)];

    // Where it is and how big, in the profile's screen pixels.
    nodes.push(make("div", { className: "ove-h", textContent: "Position" }));
    const rect = layout?.rects?.[id];
    if (!on) {
      nodes.push(make("p", { className: "ove-muted", textContent: "Switch it on to put it on the screen." }));
    } else if (rect !== undefined) {
      const field = (label, key) => {
        const input = make("input", { type: "number", value: String(rect[key]) });
        input.addEventListener("change", () => {
          const v = Number(input.value);
          if (!Number.isFinite(v)) return;
          place(id, { ...rect, [key]: Math.round(v) }, key === "width");
        });
        return [make("span", { textContent: label }), input];
      };
      nodes.push(
        make("div", { className: "ove-xy" }, ...field("X", "x"), ...field("Y", "y"), ...field("Width", "width"),
          make("span", { textContent: "Height" }), make("span", { textContent: `${rect.height}`, style: "color:#c9d1d9" })),
      );
      const reset = make("button", { className: "ghost", type: "button", textContent: "Reset position and size", style: "margin-top:8px" });
      reset.addEventListener("click", () => send({ kind: "resetPanel", id: p.id, panel: id }));
      nodes.push(reset);
    }

    const styles = view.panelStyles?.[id] ?? [];
    if (styles.length > 0) {
      nodes.push(make("div", { className: "ove-h", textContent: "Layout" }));
      const pick = make("select");
      for (const style of styles) pick.append(make("option", { value: style.id, textContent: style.label }));
      pick.value = s.style ?? styles[0].id;
      pick.addEventListener("change", () => send({ kind: "setPanelStyle", id: p.id, panel: id, style: pick.value }));
      nodes.push(pick);
    }

    const parts = view.panelParts?.[id] ?? [];
    if (parts.length > 0) {
      nodes.push(make("div", { className: "ove-h", textContent: "Shows" }));
      const list = make("div", { className: "ove-parts" });
      for (const part of parts) {
        const check = make("input", { type: "checkbox", className: "switch", checked: !s.hidden.includes(part.id) });
        check.addEventListener("change", () =>
          send({ kind: "setPanelPart", id: p.id, panel: id, part: part.id, shown: check.checked }),
        );
        list.append(make("label", {}, check, make("span", { textContent: part.label })));
      }
      nodes.push(list);
    }
    if (styles.length === 0 && parts.length === 0) {
      nodes.push(make("div", { className: "ove-h", textContent: "Shows" }), make("p", { className: "ove-muted", textContent: "Nothing to choose for this one." }));
    }
    box.replaceChildren(...nodes);
  }

  // -- The stage ---------------------------------------------------------------

  /** Editor pixels per screen pixel. */
  let k = 1;

  function drawStage() {
    const stage = el("ove-stage");
    const wrap = el("ove-stage-wrap");
    if (layout === null || profileId === null) return;
    const { width: sw, height: sh } = layout.screen;
    const W = Math.max(50, wrap.clientWidth - 48);
    const H = Math.max(50, wrap.clientHeight - 48);
    k = Math.min(W / sw, H / sh);
    stage.style.width = `${Math.round(sw * k)}px`;
    stage.style.height = `${Math.round(sh * k)}px`;
    stage.style.backgroundImage = layout.background !== null ? `url("${layout.background}")` : "";

    let label = stage.querySelector(".res-label");
    if (label === null) {
      label = make("div", { className: "res-label" });
      stage.append(label);
    }
    label.textContent = `${sw} × ${sh}`;

    const on = new Set(profile()?.panels ?? []);
    for (const [id, item] of items) {
      if (!on.has(id)) {
        item.box.remove();
        items.delete(id);
      }
    }
    for (const id of on) {
      const rect = layout.rects[id];
      if (rect === undefined) continue;
      let item = items.get(id);
      if (item === undefined) {
        item = createItem(id);
        items.set(id, item);
        stage.append(item.box);
      }
      position(item, rect);
      item.box.classList.toggle("selected", selected === id);
      // What it shows changed in the inspector: tell its preview.
      const key = JSON.stringify(settingsOf(id));
      if (item.loaded && key !== item.settingsKey) {
        item.settingsKey = key;
        post(item, "panel-settings", { panel: id, settings: settingsOf(id) });
      }
    }
    const empty = stage.querySelector(".empty");
    if (on.size === 0) {
      if (empty === null) stage.append(make("div", { className: "empty", textContent: "Switch overlays on in the list to put them here." }));
    } else {
      empty?.remove();
    }
    syncResolution();
  }

  function position(item, rect) {
    item.box.style.left = `${rect.x * k}px`;
    item.box.style.top = `${rect.y * k}px`;
    item.box.style.width = `${rect.width * k}px`;
    item.box.style.height = `${rect.height * k}px`;
  }

  function createItem(id) {
    const design = layout.designs[id] ?? [300, 200];
    const frame = make("iframe", {
      src: `./index.html?overlay=1&panel=${encodeURIComponent(id)}&w=${design[0]}&h=${design[1]}&preview=1`,
      title: labels[id] ?? id,
      tabIndex: -1,
    });
    const handle = make("div", { className: "handle", title: "Drag to size" });
    const box = make("div", { className: "ove-panel" }, frame, make("div", { className: "tag", textContent: labels[id] ?? id }), handle);
    const item = { box, frame, loaded: false, settingsKey: "" };
    frame.addEventListener("load", () => {
      item.loaded = true;
      catchUp(id, item);
    });
    box.addEventListener("pointerdown", (e) => startGesture(e, id, e.target === handle ? "size" : "move"));
    return item;
  }

  /** Edges a moving or resizing overlay snaps to: the screen's and every other overlay's. */
  function edges(id) {
    const xs = [0, layout.screen.width];
    const ys = [0, layout.screen.height];
    for (const [other, rect] of Object.entries(layout.rects)) {
      if (other === id || !enabled(other)) continue;
      xs.push(rect.x, rect.x + rect.width);
      ys.push(rect.y, rect.y + rect.height);
    }
    return { xs, ys };
  }

  /** The nearest edge to any of `values` within reach: [offset to add, edge] or null. */
  function snap(values, targets) {
    const reach = SNAP_PX / k;
    let best = null;
    for (const v of values) {
      for (const t of targets) {
        const d = t - v;
        if (Math.abs(d) <= reach && (best === null || Math.abs(d) < Math.abs(best[0]))) best = [d, t];
      }
    }
    return best;
  }

  function showGuides(gx, gy) {
    const stage = el("ove-stage");
    for (const g of stage.querySelectorAll(".ove-guide")) g.remove();
    if (gx !== null) stage.append(make("div", { className: "ove-guide", style: `left:${gx * k}px;top:0;bottom:0;width:1px` }));
    if (gy !== null) stage.append(make("div", { className: "ove-guide", style: `top:${gy * k}px;left:0;right:0;height:1px` }));
  }

  function startGesture(event, id, kind) {
    if (event.button !== 0 || layout === null) return;
    event.preventDefault();
    select(id);
    const start = layout.rects[id];
    if (start === undefined) return;
    const design = layout.designs[id] ?? [start.width, start.height];
    const item = items.get(id);
    item.box.setPointerCapture(event.pointerId);
    gesture = { id, kind, start, x0: event.clientX, y0: event.clientY, rect: start, moved: false };
    const { xs, ys } = edges(id);
    const sw = layout.screen.width;
    const sh = layout.screen.height;

    const onMove = (e) => {
      const dx = (e.clientX - gesture.x0) / k;
      const dy = (e.clientY - gesture.y0) / k;
      if (!gesture.moved && Math.abs(dx) * k < 2 && Math.abs(dy) * k < 2) return;
      gesture.moved = true;
      let rect;
      let gx = null;
      let gy = null;
      if (kind === "move") {
        let x = Math.min(Math.max(0, start.x + dx), sw - start.width);
        let y = Math.min(Math.max(0, start.y + dy), sh - start.height);
        const sx = e.altKey ? null : snap([x, x + start.width], xs);
        const sy = e.altKey ? null : snap([y, y + start.height], ys);
        if (sx !== null) [x, gx] = [x + sx[0], sx[1]];
        if (sy !== null) [y, gy] = [y + sy[0], sy[1]];
        rect = { ...start, x: Math.round(x), y: Math.round(y) };
      } else {
        // Sized by its width; its height follows the design's shape.
        const min = Math.max(40, design[0] * 0.3);
        let width = Math.min(Math.max(min, start.width + dx), sw - start.x);
        const sx = e.altKey ? null : snap([start.x + width], xs);
        if (sx !== null) [width, gx] = [width + sx[0], sx[1]];
        width = Math.round(width);
        rect = { ...start, width, height: Math.round((width * design[1]) / design[0]) };
      }
      gesture.rect = rect;
      position(item, rect);
      showGuides(gx, gy);
    };
    const onUp = () => {
      item.box.removeEventListener("pointermove", onMove);
      item.box.removeEventListener("pointerup", onUp);
      item.box.removeEventListener("pointercancel", onUp);
      showGuides(null, null);
      const done = gesture;
      gesture = null;
      if (done.moved) place(id, done.rect, false);
      else if (refreshPending) void refresh();
    };
    item.box.addEventListener("pointermove", onMove);
    item.box.addEventListener("pointerup", onUp);
    item.box.addEventListener("pointercancel", onUp);
  }

  /** Put an overlay somewhere: drawn there now, saved (and its window moved) by main. */
  function place(id, rect, keepShape) {
    if (layout === null) return;
    const design = layout.designs[id];
    const next = keepShape && design !== undefined ? { ...rect, height: Math.round((rect.width * design[1]) / design[0]) } : rect;
    layout = { ...layout, rects: { ...layout.rects, [id]: next } };
    const item = items.get(id);
    if (item !== undefined) position(item, next);
    renderInspector();
    send({ kind: "placePanel", id: profileId, panel: id, rect: next });
  }

  // Arrow keys nudge the chosen overlay: a pixel, or ten with Shift.
  let nudgeTimer = null;
  document.addEventListener("keydown", (e) => {
    if (profileId === null || selected === null || layout === null || !enabled(selected)) return;
    if (["INPUT", "SELECT", "TEXTAREA"].includes(e.target?.tagName)) return;
    const step = e.shiftKey ? 10 : 1;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (d === undefined) return;
    e.preventDefault();
    const rect = layout.rects[selected];
    if (rect === undefined) return;
    const next = { ...rect, x: rect.x + d[0], y: rect.y + d[1] };
    layout = { ...layout, rects: { ...layout.rects, [selected]: next } };
    const item = items.get(selected);
    if (item !== undefined) position(item, next);
    renderInspector();
    // Saved once the keys stop, not per press.
    const id = selected;
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(() => send({ kind: "placePanel", id: profileId, panel: id, rect: layout.rects[id] }), 300);
  });
  el("ove-stage-wrap").addEventListener("pointerdown", (e) => {
    if (e.target === el("ove-stage-wrap") || e.target === el("ove-stage")) select(null);
  });
  new window.ResizeObserver(() => drawStage()).observe(el("ove-stage-wrap"));

  // -- The bar ------------------------------------------------------------------

  el("ove-back").addEventListener("click", () => close());
  el("ove-name").addEventListener("change", () => {
    const name = el("ove-name").value.trim();
    if (name !== "" && profileId !== null) send({ kind: "rename", id: profileId, name });
  });
  el("ove-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") e.currentTarget.blur();
  });
  el("ove-use").addEventListener("click", () => send({ kind: "setActive", id: profileId }));
  el("ove-arrange").addEventListener("click", () => {
    const arranging = profileId === view?.activeProfileId && view?.editing;
    send(arranging ? { kind: "stopEditing" } : { kind: "edit", id: profileId });
  });
  const setScreen = (width, height) => {
    if (profileId === null || !(width >= 320 && height >= 320)) return;
    send({ kind: "setScreen", id: profileId, width, height });
  };
  for (const id of ["ove-w", "ove-h"]) {
    el(id).addEventListener("change", () => setScreen(Math.round(Number(el("ove-w").value)), Math.round(Number(el("ove-h").value))));
  }
  el("ove-res-reset").addEventListener("click", () => {
    if (layout !== null) setScreen(layout.display.width, layout.display.height);
  });
  el("ove-shot").addEventListener("click", () => el("ove-shot-file").click());
  el("ove-shot-file").addEventListener("change", () => {
    const file = el("ove-shot-file").files?.[0];
    el("ove-shot-file").value = "";
    if (file === undefined || profileId === null) return;
    if (file.size > 25 * 1024 * 1024) {
      window.alert("That image is over 25 MB — a screenshot is usually a few.");
      return;
    }
    const reader = new window.FileReader();
    reader.onload = () => send({ kind: "setBackground", id: profileId, image: String(reader.result) });
    reader.readAsDataURL(file);
  });
  el("ove-shot-clear").addEventListener("click", () => send({ kind: "setBackground", id: profileId, image: null }));

  // The resolution fields follow the layout, unless someone is typing in them.
  const syncResolution = () => {
    if (layout === null) return;
    for (const [id, v] of [["ove-w", layout.screen.width], ["ove-h", layout.screen.height]]) {
      if (document.activeElement !== el(id)) el(id).value = String(v);
    }
  };

  return {
    open,
    close,
    render,
    get profileId() {
      return profileId;
    },
  };
}
