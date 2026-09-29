// The control window's renderer. It decides nothing (§7) — it sends commands and
// draws whatever main says the state is.

const el = (id) => document.getElementById(id);

const PHASES = {
  stopped: "Stopped",
  waiting: "Waiting for the sim",
  running: "Running",
};

let phase = "stopped";

// -- Sections -----------------------------------------------------------

for (const btn of document.querySelectorAll(".section-btn")) {
  btn.addEventListener("click", () => {
    const section = btn.dataset.section;
    for (const b of document.querySelectorAll(".section-btn")) {
      b.classList.toggle("active", b === btn);
    }
    for (const view of document.querySelectorAll(".view")) {
      view.classList.toggle("active", view.id === `view-${section}`);
    }
  });
}

// -- Session status -------------------------------------------------------

/**
 * The pack list.
 *
 * Rebuilt wholesale on every status. It changes at human speed and there are a
 * handful of entries, so anything cleverer would be book-keeping for no gain.
 */
const renderPacks = (s) => {
  const list = el("packs");
  if (!list) return;

  el("pick-auto").checked = s.pinnedNoteSetId == null;

  const packs = s.packs ?? [];
  if (packs.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-note";
    empty.textContent = "no packs, and no mapped tracks to write one for";
    list.replaceChildren(empty);
    return;
  }

  list.replaceChildren(
    ...packs.map((pack) => {
      const written = pack.id !== "";
      const li = document.createElement("li");
      li.className = [pack.active ? "active" : "", written ? "" : "empty"]
        .filter(Boolean)
        .join(" ");

      if (written) {
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "pick";
        radio.checked = s.pinnedNoteSetId === pack.id;
        radio.addEventListener("change", () => {
          window.exxeed?.sendSessionCommand({ kind: "selectNoteSet", id: pack.id });
        });
        li.append(radio);
      }

      const main = document.createElement("div");
      main.className = "pack-main";

      const name = document.createElement("div");
      name.className = "pack-id";
      name.textContent = written ? pack.id : pack.trackName;

      const sub = document.createElement("div");
      sub.className = "pack-sub";
      sub.textContent = written
        ? `${pack.trackName} · ${pack.carClass} · ${pack.noteCount} notes · ${pack.status}`
        : "mapped, no notes yet";

      main.append(name, sub);
      li.append(main);

      // No pack, nothing for the editor to open. Creating one from a bare track
      // is not something it can do yet, so the button would lead nowhere.
      if (written) {
        const edit = document.createElement("button");
        edit.className = "ghost";
        edit.textContent = "Edit";
        edit.addEventListener("click", () => {
          window.exxeed?.sendSessionCommand({ kind: "editNoteSet", id: pack.id });
        });
        li.append(edit);
      }

      return li;
    }),
  );
};

const render = (s) => {
  phase = s.phase;

  el("phase").textContent = PHASES[s.phase] ?? s.phase;
  el("dot").className = `dot ${s.phase}`;
  el("detail").textContent = s.detail ?? "";

  // Where the recording is going, or why there is not one. Only while running:
  // before that it is a question nobody has asked yet.
  el("where").textContent =
    s.phase !== "running" ? "" : s.recordingTo ?? "not recording — this track is mapped";

  const power = el("power");
  // Stopped is the only state with nothing to stop. Waiting counts as on: the
  // app is trying, and the button has to be able to call it off.
  power.textContent = s.phase === "stopped" ? "Start" : "Stop";
  power.classList.toggle("on", s.phase !== "stopped");

  el("pinned").textContent =
    s.pinnedNoteSetId == null ? "" : `pinned: ${s.pinnedNoteSetId}`;

  renderPacks(s);
};

el("power").addEventListener("click", () => {
  window.exxeed?.sendSessionCommand({ kind: phase === "stopped" ? "start" : "stop" });
});

el("import-yt").addEventListener("click", () => {
  window.exxeed?.sendSessionCommand({ kind: "openImporter" });
});

el("pick-auto").addEventListener("change", () => {
  window.exxeed?.sendSessionCommand({ kind: "selectNoteSet", id: null });
});

window.exxeed?.onSessionStatus(render);

// -- Overlay profiles -------------------------------------------------------

// Mirrors PANELS and PANEL_SPECS in @exxeed/overlays, grouped the way the
// panels are about — this page is plain JS and cannot import the package.
// "Race" and "Car" need the live sim: a replay has no other cars, fuel or
// tyres to show.
const PANEL_GROUPS = [
  ["Driving", ["inputs", "pedals", "trace", "speed", "brake"]],
  ["Timing", ["delta", "sectors", "corners", "reference"]],
  ["Race", ["standings", "relative", "radar"]],
  ["Track", ["map", "minimap"]],
  ["Car", ["fuel", "tyres", "damage", "weather"]],
  ["Exxeed", ["callouts", "telemetry"]],
];
const PANEL_ORDER = PANEL_GROUPS.flatMap(([, ids]) => ids);
const PANEL_LABELS = {
  inputs: "Essential Inputs",
  pedals: "Input Telemetry",
  trace: "Input Comparison",
  speed: "Speed Comparison",
  brake: "Brake Indicator",
  delta: "Delta Bar",
  sectors: "Delta Sectors",
  corners: "Corner Analysis",
  reference: "Comparison Target",
  standings: "Standings",
  relative: "Relatives",
  radar: "Radar",
  map: "Track Map",
  minimap: "Mini Map",
  fuel: "Fuel Calculator",
  tyres: "Tyres",
  damage: "Damage",
  weather: "Weather",
  callouts: "Callouts",
  telemetry: "Telemetry",
};

const sendOverlayCommand = (command) => window.exxeed?.sendOverlayProfileCommand(command);

/** Double-click to rename, inline — the same pattern as the note editor's pills. */
function makeNameEditable(span, profile) {
  span.addEventListener("dblclick", () => {
    span.contentEditable = "true";
    span.spellcheck = false;
    const range = document.createRange();
    range.selectNodeContents(span);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });

  const commit = () => {
    span.contentEditable = "false";
    const name = span.textContent.trim();
    if (name === "" || name === profile.name) {
      span.textContent = profile.name;
      return;
    }
    sendOverlayCommand({ kind: "rename", id: profile.id, name });
  };
  const cancel = () => {
    span.contentEditable = "false";
    span.textContent = profile.name;
  };

  span.addEventListener("blur", commit);
  span.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      span.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancel();
      span.blur();
    }
  });
}

function renderOverlayProfiles(view) {
  const list = el("ov-profiles");
  if (!list) return;

  const panelIds = view.debugEnabled ? PANEL_ORDER : PANEL_ORDER.filter((p) => p !== "telemetry");

  list.replaceChildren(
    ...view.profiles.map((profile) => {
      const isActive = profile.id === view.activeProfileId;
      const isEditingThis = isActive && view.editing;

      const li = document.createElement("li");
      li.className = `ov-profile${isActive ? " active" : ""}`;

      const row = document.createElement("div");
      row.className = "ov-row";

      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "ov-active-dot";
      dot.title = isActive ? "Active — this profile's overlays are open" : "Make this profile active";
      dot.addEventListener("click", () => {
        if (!isActive) sendOverlayCommand({ kind: "setActive", id: profile.id });
      });

      const name = document.createElement("span");
      name.className = "ov-name";
      name.textContent = profile.name;
      makeNameEditable(name, profile);

      const actions = document.createElement("div");
      actions.className = "ov-actions";

      // Edit and Save are the same button: click to start arranging this
      // profile's overlays, click again — now reading "Save" — to lock them
      // back down. One button doing both means there is nothing extra to
      // dismiss once you are done dragging.
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = isEditingThis ? "ghost primary" : "ghost";
      editBtn.textContent = isEditingThis ? "Save" : "Edit";
      editBtn.addEventListener("click", () => {
        sendOverlayCommand(
          isEditingThis ? { kind: "stopEditing" } : { kind: "edit", id: profile.id },
        );
      });

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "ghost";
      deleteBtn.textContent = "Delete";
      deleteBtn.disabled = view.profiles.length <= 1;
      deleteBtn.addEventListener("click", () => {
        if (window.confirm(`Delete the overlay profile "${profile.name}"?`)) {
          sendOverlayCommand({ kind: "delete", id: profile.id });
        }
      });

      actions.append(editBtn, deleteBtn);
      row.append(dot, name, actions);

      const panels = document.createElement("div");
      panels.className = "ov-panels";
      const groups = new Map();
      for (const [group, ids] of PANEL_GROUPS) {
        if (!ids.some((id) => panelIds.includes(id))) continue;
        const row = document.createElement("div");
        row.className = "ov-group";
        const heading = document.createElement("span");
        heading.className = "ov-group-name";
        heading.textContent = group;
        row.append(heading);
        panels.append(row);
        for (const id of ids) groups.set(id, row);
      }
      for (const id of panelIds) {
        const label = document.createElement("label");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = profile.panels.includes(id);
        box.addEventListener("change", () => {
          // PANEL_ORDER, not panelIds: this build might not show a checkbox for
          // every panel (telemetry is debug-only), and a profile carrying one
          // from a debug build must not lose it just because someone toggled an
          // unrelated panel from a non-debug window.
          const chosen = PANEL_ORDER.filter((p) =>
            p === id ? box.checked : profile.panels.includes(p),
          );
          // Refuse to leave nothing: an empty profile opens no windows at all,
          // with no way back inside the app.
          if (chosen.length === 0) {
            box.checked = true;
            return;
          }
          sendOverlayCommand({ kind: "setPanels", id: profile.id, panels: chosen });
        });
        label.append(box, document.createTextNode(PANEL_LABELS[id] ?? id));
        (groups.get(id) ?? panels).append(label);
      }

      li.append(row, panels);
      return li;
    }),
  );
}

el("ov-new").addEventListener("click", () => {
  sendOverlayCommand({ kind: "create", name: "New profile" });
});

window.exxeed?.onOverlayProfiles(renderOverlayProfiles);
