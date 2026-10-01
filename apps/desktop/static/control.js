// The control window's renderer. It decides nothing (§7) — it sends commands and
// draws whatever main says the state is.

const el = (id) => document.getElementById(id);

const PHASES = {
  stopped: "Stopped",
  waiting: "Waiting for the sim",
  running: "Running",
};

let phase = "stopped";
let testMode = false;

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
 * The pack list: yours, installed, and tracks with nothing yet (M8).
 *
 * Rebuilt wholesale on every status. It changes at human speed and there are a
 * handful of entries, so anything cleverer would be book-keeping for no gain —
 * except the open version pickers, which are remembered by pack so a status
 * broadcast does not snap them shut.
 */
const openPickers = new Set();

const make = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
};

const button = (text, title, onClick) => {
  const b = make("button", { className: "ghost", textContent: text, title, type: "button" });
  b.addEventListener("click", onClick);
  return b;
};

const library = async (request) => {
  const response = await window.exxeed.library(request);
  if (!response.ok) throw new Error(response.error);
  return response.value;
};

const setLibraryStatus = (text, bad = false) => {
  el("library-status").textContent = text;
  el("library-status").className = `library-status${bad ? " bad" : ""}`;
};

/** Run a library request and report its answer under the install field. */
const act = async (request, button) => {
  if (button) button.disabled = true;
  try {
    const answer = await library(request);
    if (typeof answer === "string") setLibraryStatus(answer);
    return answer;
  } catch (err) {
    setLibraryStatus(err.message, true);
    return null;
  } finally {
    if (button) button.disabled = false;
  }
};

/** A button that needs a second click, for things that cannot be undone. */
const confirmButton = (text, confirmText, title, onConfirm) => {
  const b = button(text, title, () => {
    if (b.dataset.armed !== "1") {
      b.dataset.armed = "1";
      b.textContent = confirmText;
      setTimeout(() => {
        b.dataset.armed = "";
        b.textContent = text;
      }, 4000);
      return;
    }
    void onConfirm(b);
  });
  return b;
};

function packRow(s, pack) {
  const c = pack.content;
  const li = make("li", { className: pack.active ? "active" : "" });

  const radio = make("input", { type: "radio", name: "pick", checked: s.pinnedNoteSetId === pack.id });
  radio.addEventListener("change", () => {
    window.exxeed?.sendSessionCommand({ kind: "selectNoteSet", id: pack.id });
  });

  const facts = [pack.trackName, pack.carClass, `${pack.noteCount} callouts`];
  if (c === null) facts.push(pack.status === "published" ? "published" : "not published");
  else if (c.version === null) facts.push("not published yet");
  else {
    facts.push(`v${c.version}`);
    if (c.stars !== null) facts.push(`★ ${c.stars}`);
    if (c.downloads !== null) facts.push(`${c.downloads} ↓`);
  }

  const main = make(
    "div",
    { className: "pack-main" },
    make("div", { className: "pack-id", textContent: pack.id }),
    make("div", { className: "pack-sub", textContent: facts.join(" · ") }),
  );

  const row = make("div", { className: "pack-row" }, radio, main);
  const actions = make("div", { className: "pack-actions" });
  row.append(actions);
  li.append(row);

  if (c?.origin === "installed") {
    const behind = c.latestVersion !== null && c.version !== null && c.latestVersion > c.version;
    if (behind) {
      actions.append(
        make("span", { className: "chip", textContent: `v${c.latestVersion} available` }),
        button("Update", "Install the newest version now", (e) => void act({ op: "install", ref: c.itemId }, e.currentTarget)),
      );
    }
    const policy = make("select", { className: "policy", title: "Take new versions automatically between sessions, or stay on this one" });
    policy.append(
      make("option", { value: "auto", textContent: "Auto-update" }),
      make("option", { value: "pinned", textContent: "Stay on this version" }),
    );
    policy.value = c.policy;
    policy.addEventListener("change", () => void act({ op: "setPolicy", noteSetId: pack.id, policy: policy.value }));
    actions.append(
      policy,
      button(openPickers.has(pack.id) ? "Hide versions" : "Versions…", "See every version and switch to one", () => {
        if (openPickers.has(pack.id)) openPickers.delete(pack.id);
        else openPickers.add(pack.id);
        renderPacks(lastStatus);
      }),
      confirmButton("Uninstall", "Really uninstall?", "Remove this pack and its audio from this machine", (b) =>
        act({ op: "uninstall", noteSetId: pack.id }, b),
      ),
    );
    if (openPickers.has(pack.id)) li.append(versionPicker(pack));
  } else {
    actions.append(
      button("Edit", "Open in the note editor — publish from there", () => {
        window.exxeed?.sendSessionCommand({ kind: "editNoteSet", id: pack.id });
      }),
    );
  }
  return li;
}

/** Every version of an installed pack, newest first, with what each changed. */
function versionPicker(pack) {
  const box = make("div", { className: "versions", textContent: "Loading versions…" });
  void library({ op: "versions", itemId: pack.content.itemId }).then(
    (versions) => {
      box.replaceChildren(
        ...versions.map((v) => {
          const here = v.version === pack.content.version;
          const lines = [v.changelog, ...v.changes].filter(Boolean);
          const detail = make("div", { className: "v-log", textContent: lines.length > 0 ? lines.join(" · ") : v.version === 1 ? "First release" : "—" });
          const head = make(
            "div",
            { className: "v-head" },
            make("strong", { textContent: `v${v.version}` }),
            make("span", { className: "pack-sub", textContent: `${new Date(v.publishedAt).toLocaleDateString()}${v.withdrawn ? " · withdrawn by the author" : ""}` }),
          );
          if (here) head.append(make("span", { className: "chip", textContent: "installed" }));
          else if (!v.withdrawn) {
            head.append(button("Install this version", "Switch to this version and stay on it", (e) =>
              void act({ op: "install", ref: pack.content.itemId, versionId: v.id }, e.currentTarget),
            ));
          }
          return make("div", { className: `v-row${v.withdrawn ? " withdrawn" : ""}` }, head, detail);
        }),
      );
    },
    (err) => {
      box.textContent = `Could not load versions: ${err.message}`;
    },
  );
  return box;
}

function remoteRow(remote) {
  const facts = [remote.trackLabel, remote.carClass ?? "", remote.latestVersion === null ? "draft only" : `v${remote.latestVersion}`];
  return make(
    "li",
    { className: "empty" },
    make(
      "div",
      { className: "pack-row" },
      make(
        "div",
        { className: "pack-main" },
        make("div", { className: "pack-id", textContent: remote.title }),
        make("div", { className: "pack-sub", textContent: `${facts.filter(Boolean).join(" · ")} · on your account, not on this machine` }),
      ),
      make(
        "div",
        { className: "pack-actions" },
        button("Download", "Put your draft (or latest version) on this machine", (e) =>
          void act({ op: "downloadMine", itemId: remote.itemId }, e.currentTarget),
        ),
      ),
    ),
  );
}

function trackRow(pack) {
  const track = { trackId: pack.trackId, configId: pack.configId };
  return make(
    "li",
    { className: "empty" },
    make(
      "div",
      { className: "pack-row" },
      make(
        "div",
        { className: "pack-main" },
        make("div", { className: "pack-id", textContent: pack.trackName }),
        make("div", { className: "pack-sub", textContent: "mapped, no callouts yet" }),
      ),
      make(
        "div",
        { className: "pack-actions" },
        button("Import…", "Import callouts from a YouTube track guide for this track", () => {
          window.exxeed?.sendSessionCommand({ kind: "openImporter", track });
        }),
        button("Write manually", "Start an empty note set for this track and open it in the editor", () => {
          window.exxeed?.sendSessionCommand({ kind: "newNoteSet", ...track });
        }),
        button("Find in Content", "See packs other drivers have published for this track", () => {
          openContent({ sim: "iracing", ...track }, null, pack.trackName);
        }),
      ),
    ),
  );
}

const group = (title, rows, emptyText) =>
  make(
    "section",
    { className: "pack-group" },
    make("h3", { textContent: title }),
    rows.length > 0 ? make("ul", { className: "packs" }, ...rows) : make("p", { className: "empty-note", textContent: emptyText }),
  );

let lastStatus = null;

/** Switch to Content with its filters set (content.js listens). */
const openContent = (trackKey, carClass, label = null) =>
  document.dispatchEvent(new CustomEvent("open-content", { detail: { trackKey, carClass, label } }));

/** The banner for a session on a combo with no callouts (M8 step 5). */
function renderContentHint(s) {
  const hint = s.contentHint ?? null;
  el("content-hint").hidden = hint === null;
  if (hint === null) return;
  el("content-hint-text").textContent =
    hint.count > 0
      ? `No callouts for ${hint.label}. ${hint.count} pack${hint.count === 1 ? "" : "s"} in Content.`
      : `No callouts for ${hint.label}, and nobody has published any yet.`;
  el("content-hint-go").hidden = hint.count === 0;
  el("content-hint-write").hidden = hint.count > 0;
  el("content-hint-go").onclick = () => openContent(hint.trackKey, hint.carClass, hint.label);
  el("content-hint-write").onclick = () => {
    window.exxeed?.sendSessionCommand({ kind: "newNoteSet", trackId: hint.trackKey.trackId, configId: hint.trackKey.configId });
  };
}

const renderPacks = (s) => {
  lastStatus = s;
  const host = el("packs");
  if (!host) return;

  el("pick-auto").checked = s.pinnedNoteSetId == null;
  el("library-busy").textContent = s.libraryBusy ?? "";
  el("library-busy").hidden = s.libraryBusy == null;

  const packs = s.packs ?? [];
  const mine = packs.filter((p) => p.id !== "" && p.content?.origin !== "installed");
  const installed = packs.filter((p) => p.id !== "" && p.content?.origin === "installed");
  const tracks = packs.filter((p) => p.id === "");

  host.replaceChildren(
    group(
      "Mine",
      [...mine.map((p) => packRow(s, p)), ...(s.remoteMine ?? []).map(remoteRow)],
      "Nothing yet — import a guide, or write callouts for a track below.",
    ),
    group("Installed", installed.map((p) => packRow(s, p)), "Packs you install from others appear here."),
    ...(tracks.length > 0 ? [group("Tracks without callouts", tracks.map(trackRow), "")] : []),
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

  testMode = s.testMode === true;
  el("test-mode").classList.toggle("on", testMode);
  el("test-mode").textContent = testMode ? "Test mode: on" : "Test mode";

  el("pinned").textContent =
    s.pinnedNoteSetId == null ? "" : `pinned: ${s.pinnedNoteSetId}`;

  renderPacks(s);
  renderContentHint(s);
};

el("test-mode").addEventListener("click", () => {
  window.exxeed?.sendSessionCommand({ kind: "testMode", value: !testMode });
});

el("power").addEventListener("click", () => {
  window.exxeed?.sendSessionCommand({ kind: phase === "stopped" ? "start" : "stop" });
});

const installFromField = async () => {
  const ref = el("install-ref").value.trim();
  if (ref === "") return;
  setLibraryStatus("Installing…");
  const answer = await act({ op: "install", ref }, el("install-go"));
  if (answer !== null) el("install-ref").value = "";
};
el("install-go").addEventListener("click", () => void installFromField());
el("install-ref").addEventListener("keydown", (e) => e.key === "Enter" && void installFromField());
el("check-updates").addEventListener("click", (e) => void act({ op: "checkUpdates" }, e.currentTarget));

// -- Import a lap (Garage 61 CSV) ---------------------------------------------

let lapDraft = null;
const keyValue = (k) => `${k.sim}:${k.trackId}:${k.configId}`;
const lapStatus = (text, bad = false) => {
  el("lap-import-status").textContent = text;
  el("lap-import-status").className = `form-status${bad ? " bad" : ""}`;
};
const fmtLapTime = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, "0")}`;

function explainLapTarget() {
  if (lapDraft === null) return;
  const chosen = lapDraft.layouts.find((l) => keyValue(l.trackKey) === el("lap-import-layout").value);
  el("lap-import-note").textContent =
    chosen === undefined
      ? "Pick the track and layout this lap was driven on."
      : chosen.hasMap
        ? "This track is already mapped. The map stays as it is, so callouts keep their corners; the lap becomes the reference lap if it is faster than yours."
        : "No map here yet: this lap becomes the map (drawn from its recorded positions) and the reference lap.";
}

const lapImport = async (request) => {
  const response = await window.exxeed.lapImport(request);
  if (!response.ok) throw new Error(response.error);
  return response.value;
};
const sourceStatus = (text, bad = false) => {
  el("lap-source-status").textContent = text;
  el("lap-source-status").className = `form-status${bad ? " bad" : ""}`;
};

/** The confirm step, the same for a file and for a Garage 61 lap. */
function showLapDraft(draft) {
  lapDraft = draft;
  const who = draft.driver ? ` by ${draft.driver}` : "";
  const where = draft.trackName ? ` at ${draft.trackName}${draft.layoutName ? ` (${draft.layoutName})` : ""}` : "";
  el("lap-import-lead").textContent = `${fmtLapTime(draft.lapTimeS)}${who}${where} · ${draft.samples} samples.`;

  const layout = el("lap-import-layout");
  layout.replaceChildren(
    make("option", { value: "", textContent: draft.suggestedLayout ? "—" : "Choose…" }),
    ...draft.layouts.map((l) => make("option", { value: keyValue(l.trackKey), textContent: `${l.label}${l.hasMap ? " · mapped" : ""}` })),
  );
  layout.value = draft.suggestedLayout ? keyValue(draft.suggestedLayout) : "";

  const car = el("lap-import-car");
  car.replaceChildren(
    make("option", { value: "", textContent: "Choose…" }),
    ...draft.cars.map((c) => make("option", { value: c.carId, textContent: c.name })),
  );
  car.value = draft.suggestedCarId ?? "";

  lapStatus(draft.suggestedLayout ? "" : "The lap did not match a known layout; pick it from the list.");
  explainLapTarget();
  if (el("lap-source").open) el("lap-source").close();
  el("lap-import").showModal();
}

// -- Garage 61 -------------------------------------------------------------

let g61Tracks = [];

async function showG61(status) {
  el("g61-connect").hidden = status.connected;
  el("g61-search").hidden = !status.connected;
  if (!status.connected) return;
  el("g61-user").textContent = `Connected as ${status.user ?? "your Garage 61 account"}`;
  if (g61Tracks.length > 0) return;
  sourceStatus("Loading Garage 61's tracks and cars…");
  try {
    const catalog = await lapImport({ op: "g61Catalog" });
    g61Tracks = catalog.tracks;
    renderG61Tracks(catalog.suggestedTrackId);
    el("g61-car").replaceChildren(
      make("option", { value: "", textContent: "Any car" }),
      ...catalog.cars.map((c) => make("option", { value: String(c.id), textContent: c.name })),
    );
    sourceStatus("");
  } catch (err) {
    sourceStatus(err.message, true);
  }
}

function renderG61Tracks(selected = null) {
  const q = el("g61-track-filter").value.trim().toLowerCase();
  const keep = selected ?? (el("g61-track").value === "" ? null : Number(el("g61-track").value));
  const shown = g61Tracks.filter((t) => q === "" || t.label.toLowerCase().includes(q));
  el("g61-track").replaceChildren(...shown.map((t) => make("option", { value: String(t.id), textContent: t.label })));
  if (keep !== null && shown.some((t) => t.id === keep)) el("g61-track").value = String(keep);
}

el("import-lap").addEventListener("click", async () => {
  el("g61-laps").replaceChildren();
  sourceStatus("");
  el("lap-source").showModal();
  try {
    await showG61(await lapImport({ op: "g61Status" }));
  } catch (err) {
    sourceStatus(err.message, true);
  }
});

el("g61-connect-go").addEventListener("click", async () => {
  sourceStatus("Checking the token with Garage 61…");
  try {
    const status = await lapImport({ op: "g61Connect", token: el("g61-token").value });
    el("g61-token").value = "";
    await showG61(status);
  } catch (err) {
    sourceStatus(err.message, true);
  }
});

el("g61-disconnect").addEventListener("click", async () => {
  g61Tracks = [];
  el("g61-laps").replaceChildren();
  await showG61(await lapImport({ op: "g61Disconnect" }));
});

el("g61-track-filter").addEventListener("input", () => renderG61Tracks());
el("g61-mine").addEventListener("change", () => {
  el("g61-team-note").hidden = el("g61-mine").checked;
});

el("g61-search-go").addEventListener("click", async () => {
  const trackId = Number(el("g61-track").value);
  if (!trackId) {
    sourceStatus("Pick a track first.", true);
    return;
  }
  const carId = el("g61-car").value === "" ? null : Number(el("g61-car").value);
  sourceStatus("Looking for laps…");
  try {
    const mineOnly = el("g61-mine").checked;
    const laps = await lapImport({ op: "g61Laps", trackId, carId, mineOnly });
    sourceStatus(
      laps.length === 0
        ? mineOnly
          ? "None of your own laps there have telemetry. Untick 'Only my laps' to include teammates'."
          : "No laps with telemetry there that your account can see."
        : `${laps.length} lap${laps.length === 1 ? "" : "s"}, fastest first.`,
    );
    el("g61-laps").replaceChildren(
      ...laps.map((l) => {
        const use = make("button", { className: "ghost primary", type: "button", textContent: "Use" });
        use.addEventListener("click", async () => {
          use.disabled = true;
          sourceStatus("Downloading the lap…");
          try {
            showLapDraft(await lapImport({ op: "g61Pick", lapId: l.id }));
          } catch (err) {
            sourceStatus(err.message, true);
            use.disabled = false;
          }
        });
        const when = new Date(l.startTime).toLocaleDateString();
        return make(
          "li",
          {},
          make("span", { className: `t${l.clean ? "" : " dirty"}`, textContent: fmtLapTime(l.lapTimeS), title: l.clean ? "Clean lap" : "Not a clean lap" }),
          make("span", { className: "who", textContent: `${l.driver} · ${l.car} · ${when}` }),
          use,
        );
      }),
    );
  } catch (err) {
    sourceStatus(err.message, true);
  }
});

el("lap-file").addEventListener("click", async () => {
  try {
    const draft = await lapImport({ op: "pick" });
    if (draft !== null) showLapDraft(draft);
  } catch (err) {
    sourceStatus(err.message, true);
  }
});

el("lap-source-close").addEventListener("click", () => el("lap-source").close());

el("lap-import-layout").addEventListener("change", explainLapTarget);
el("lap-import-cancel").addEventListener("click", () => el("lap-import").close());
el("lap-import-go").addEventListener("click", async () => {
  const chosen = lapDraft?.layouts.find((l) => keyValue(l.trackKey) === el("lap-import-layout").value);
  const carId = el("lap-import-car").value;
  if (!chosen || carId === "") {
    lapStatus("Choose the track and the car first.", true);
    return;
  }
  el("lap-import-go").disabled = true;
  lapStatus("Building the map…");
  try {
    const response = await window.exxeed.lapImport({ op: "import", token: lapDraft.token, trackKey: chosen.trackKey, carId });
    if (!response.ok) throw new Error(response.error);
    el("lap-import").close();
    setLibraryStatus(response.value);
  } catch (err) {
    lapStatus(err.message, true);
  } finally {
    el("lap-import-go").disabled = false;
  }
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

  el("ov-hide-unfocused").checked = view.hideWhenSimUnfocused;

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

el("ov-hide-unfocused").addEventListener("change", (e) => {
  sendOverlayCommand({ kind: "hideWhenSimUnfocused", value: e.target.checked });
});

el("ov-new").addEventListener("click", () => {
  sendOverlayCommand({ kind: "create", name: "New profile" });
});

window.exxeed?.onOverlayProfiles(renderOverlayProfiles);
