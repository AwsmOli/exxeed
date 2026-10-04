// The control window's renderer. It decides nothing (§7) — it sends commands and
// draws whatever main says the state is.

import { createProfileEditor } from "./profile-editor.js";

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

  // Audio that is missing or out of date in this voice: the pack would be
  // silent, or say the old words, until it is rendered.
  const audio = pack.audio;
  if (audio?.rendering) {
    actions.append(make("span", { className: "chip", textContent: "Rendering…" }));
  } else if (audio !== null && audio.stale > 0) {
    const whole = audio.stale >= pack.noteCount;
    actions.append(
      make("span", {
        className: "chip warn",
        textContent: whole ? "⚠ Not rendered" : `⚠ ${audio.stale} callout${audio.stale === 1 ? "" : "s"} not rendered`,
        title: whole
          ? "This pack has no audio in your voice yet — it will be silent in a session"
          : "These callouts changed since the audio was made — they will be silent or say the old words",
      }),
      button("Render now", "Make the audio for this pack in your voice", (e) =>
        void act({ op: "render", noteSetId: pack.id }, e.currentTarget),
      ),
    );
  }

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
  ["Driving", ["inputs", "pedals", "trace", "speed", "brake", "revlights"]],
  ["Timing", ["delta", "sectors", "corners", "reference"]],
  ["Race", ["standings", "relative", "radar", "spotter-left", "spotter-right", "flags"]],
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
  revlights: "Rev Lights",
  delta: "Delta Bar",
  sectors: "Delta Sectors",
  corners: "Corner Analysis",
  reference: "Comparison Target",
  standings: "Standings",
  relative: "Relatives",
  radar: "Radar",
  "spotter-left": "Blind Spot Left",
  "spotter-right": "Blind Spot Right",
  flags: "Flags",
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

/** The last Overlays view, for the theme editor's list of open overlays. */
let lastOverlayView = null;

/** The profile editor (profile-editor.js): opened from a profile's card. */
const profileEditor = createProfileEditor({
  groups: PANEL_GROUPS,
  labels: PANEL_LABELS,
  order: PANEL_ORDER,
  send: sendOverlayCommand,
});

/** Set by "New profile": the next profile to appear is opened in the editor. */
let openNextNewProfile = false;

/** The profile whose theme the picker shows: the one being edited, else the one in use. */
const themedProfile = (view) =>
  view.profiles.find((p) => p.id === (profileEditor.profileId ?? view.activeProfileId)) ?? null;

function renderOverlayProfiles(view) {
  const before = lastOverlayView;
  lastOverlayView = view;
  const list = el("ov-profiles");
  if (!list) return;

  el("ov-hide-unfocused").checked = view.hideWhenSimUnfocused;
  renderThemePicker(view);

  const themeName = (profile) =>
    view.themes.find((t) => t.id === (profile.theme ?? view.themeId))?.name ?? profile.theme ?? "";

  list.replaceChildren(
    ...view.profiles.map((profile) => {
      const isActive = profile.id === view.activeProfileId;
      const li = document.createElement("li");
      li.className = `ov-card${isActive ? " active" : ""}`;

      const head = document.createElement("div");
      head.className = "ov-card-head";
      const name = document.createElement("span");
      name.className = "ov-card-name";
      name.textContent = profile.name;
      name.title = profile.name;
      head.append(name);
      if (isActive) {
        const chip = document.createElement("span");
        chip.className = "ov-chip";
        chip.textContent = "In use";
        head.append(chip);
      }

      const meta = document.createElement("div");
      meta.className = "ov-card-meta";
      const count = profile.panels.length;
      meta.textContent = [
        `${count} overlay${count === 1 ? "" : "s"}`,
        themeName(profile),
        profile.screen ? `${profile.screen.width}×${profile.screen.height}` : null,
      ]
        .filter(Boolean)
        .join(" · ");

      const actions = document.createElement("div");
      actions.className = "ov-card-actions";
      const button = (text, title, onClick, className = "ghost") => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = className;
        b.textContent = text;
        b.title = title;
        b.addEventListener("click", onClick);
        return b;
      };
      actions.append(button("Edit", "Choose and lay out this profile's overlays", () => profileEditor.open(profile.id), "ghost primary"));
      if (!isActive) {
        actions.append(button("Use", "Open this profile's overlays instead", () => sendOverlayCommand({ kind: "setActive", id: profile.id })));
      }
      const del = button("Delete", "Delete this profile", () => {
        if (window.confirm(`Delete the overlay profile "${profile.name}"?`)) sendOverlayCommand({ kind: "delete", id: profile.id });
      });
      del.disabled = view.profiles.length <= 1;
      actions.append(del);

      li.append(head, meta, actions);
      return li;
    }),
  );

  // A profile just made with "New profile": straight into the editor with it.
  if (openNextNewProfile && before !== null) {
    const added = view.profiles.find((p) => !before.profiles.some((q) => q.id === p.id));
    if (added !== undefined) {
      openNextNewProfile = false;
      profileEditor.open(added.id);
    }
  }
  profileEditor.render(view);
}

/** The theme picker in the editor: the profile's theme, and what can be done with it. */
function renderThemePicker(view) {
  // Rebuilt only when the list changes, so an open dropdown is not replaced under the pointer.
  const themes = view.themes ?? [];
  const select = el("ov-theme");
  const signature = themes.map((t) => `${t.id}:${t.name}`).join("|");
  if (select.dataset.signature !== signature) {
    select.dataset.signature = signature;
    const option = (t) => {
      const o = document.createElement("option");
      o.value = t.id;
      o.textContent = t.name;
      return o;
    };
    const mine = themes.filter((t) => t.custom);
    const builtIn = themes.filter((t) => !t.custom).map(option);
    if (mine.length === 0) {
      select.replaceChildren(...builtIn);
    } else {
      const group = (label, options) => {
        const g = document.createElement("optgroup");
        g.label = label;
        g.append(...options);
        return g;
      };
      select.replaceChildren(group("Built in", builtIn), group("Yours", mine.map(option)));
    }
  }
  const themeId = themedProfile(view)?.theme ?? view.themeId;
  select.value = themeId;
  const current = themes.find((t) => t.id === themeId);
  el("ov-theme-desc").textContent = current?.custom
    ? `${current.description} Edit opens its files; saving restyles the overlays straight away.`.trim()
    : (current?.description ?? "");
  el("ov-theme-edit").hidden = current?.custom !== true;
  el("ov-theme-delete").hidden = current?.custom !== true;
  el("ov-theme-publish").hidden = current?.custom !== true;
  // What is wrong with the file, while it is being edited. The overlays keep
  // the last version that worked.
  const problems = current?.problems ?? [];
  el("ov-theme-problems").hidden = problems.length === 0;
  el("ov-theme-problems").replaceChildren(
    ...problems.slice(0, 6).map((p) => {
      const li = document.createElement("li");
      li.textContent = p;
      return li;
    }),
  );
}

el("ov-hide-unfocused").addEventListener("change", (e) => {
  sendOverlayCommand({ kind: "hideWhenSimUnfocused", value: e.target.checked });
});

el("ov-theme").addEventListener("change", (e) => {
  sendOverlayCommand({ kind: "setTheme", id: e.target.value, profileId: profileEditor.profileId ?? undefined });
});
el("ov-theme-new").addEventListener("click", () => {
  const from = el("ov-theme").selectedOptions[0]?.textContent ?? "theme";
  // Worn by this profile once it exists; Edit then opens it.
  sendOverlayCommand({ kind: "newTheme", name: `My ${from}`, profileId: profileEditor.profileId ?? undefined });
});

// -- Editing a theme of your own, in the app ---------------------------------------
// A plain text box over the theme's JSON file. Every pause in typing saves it,
// and main applies it, so the overlays are the preview. A file that does not
// parse keeps the last good version on screen and lists what is wrong.

let editingTheme = null;
/** The file open in the editor: theme.json, theme.css or templates/<overlay>.html. */
let editingFile = "theme.json";
let themeFiles = ["theme.json"];
let editSaveTimer = null;
/** VS Code's editor, once it has loaded (theme-editor.js). Until then, and if it cannot, the text box. */
let themeEditor = null;
let themeEditorFailed = false;

const themeText = () => (themeEditor !== null ? themeEditor.getValue() : el("te-text").value);
const setThemeText = (text) => {
  el("te-text").value = text;
  themeEditor?.open(editingFile, text);
};

/** The overlays, with their built-in templates (panels/index.js): loaded once, the first time a theme is edited. */
let panelsModule = null;
const panels = async () => (panelsModule ??= await import("./panels/index.js"));

function themeTextChanged() {
  clearTimeout(editSaveTimer);
  el("te-status").textContent = "…";
  el("te-status").className = "form-status";
  editSaveTimer = setTimeout(() => void saveThemeText(), 350);
}

/** Swap the text box for the real editor, the first time it is wanted. */
async function ensureThemeEditor() {
  if (themeEditor !== null || themeEditorFailed) return;
  try {
    const [{ createThemeEditor }, schema, { blockList, FILTERS }] = await Promise.all([
      import("./theme-editor.js"),
      themeContent({ op: "schema" }),
      panels(),
    ]);
    el("te-editor").hidden = false;
    themeEditor = await createThemeEditor(el("te-editor"), schema, themeTextChanged, { blocks: blockList(), filters: FILTERS });
    themeEditor.open(editingFile, el("te-text").value);
    el("te-text").hidden = true;
    themeEditor.focus();
  } catch (err) {
    // The text box still works; say why the editor is plain.
    themeEditorFailed = true;
    el("te-editor").hidden = true;
    el("te-text").hidden = false;
    console.error("theme editor:", err);
  }
}

function showThemeProblems(problems) {
  el("te-problems").hidden = problems.length === 0;
  el("te-problems").replaceChildren(
    ...problems.slice(0, 8).map((p) => {
      const li = document.createElement("li");
      li.textContent = p;
      return li;
    }),
  );
  el("te-status").textContent =
    problems.length === 0
      ? "Saved — the overlays are showing it."
      : "Saved, with problems. What has a problem is left out; a theme.json that is not valid JSON leaves the overlays as they were.";
  el("te-status").className = `form-status${problems.length === 0 ? "" : " bad"}`;
}

async function saveThemeText() {
  if (editingTheme === null) return;
  try {
    showThemeProblems(await themeContent({ op: "writeFile", themeId: editingTheme, file: editingFile, text: themeText() }));
  } catch (err) {
    el("te-status").textContent = err.message;
    el("te-status").className = "form-status bad";
  }
}

/** Save what is open now, before showing something else. */
async function flushThemeText() {
  if (editSaveTimer === null) return;
  clearTimeout(editSaveTimer);
  editSaveTimer = null;
  await saveThemeText();
}

const templatePanel = (file) => /^templates\/([a-z0-9-]+)\.html$/.exec(file)?.[1] ?? null;
const fileLabel = (file) => {
  const panel = templatePanel(file);
  return panel === null ? file : `${PANEL_LABELS[panel] ?? panel}.html`;
};

function renderThemeFiles() {
  el("te-files").replaceChildren(
    ...themeFiles.map((file) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = fileLabel(file);
      b.title = file;
      b.className = file === editingFile ? "on" : "";
      b.addEventListener("click", () => void openThemeFile(file));
      return b;
    }),
  );
  el("te-remove").hidden = editingFile === "theme.json";
  el("te-remove").textContent = "Remove file";
  delete el("te-remove").dataset.armed;

  // What can still be added: a stylesheet, and a template for each overlay without one.
  const add = el("te-add");
  const options = [new Option("Add…", "")];
  if (!themeFiles.includes("theme.css")) options.push(new Option("Stylesheet (theme.css)", "theme.css"));
  for (const id of PANEL_ORDER) {
    const file = `templates/${id}.html`;
    if (!themeFiles.includes(file)) options.push(new Option(`Template: ${PANEL_LABELS[id] ?? id}`, file));
  }
  add.replaceChildren(...options);
  add.value = "";

  // Inspect: the open overlays, the one this template builds first.
  const open = lastOverlayView?.profiles.find((p) => p.id === lastOverlayView.activeProfileId)?.panels ?? [];
  const inspect = el("te-inspect-panel");
  const keep = inspect.value;
  inspect.replaceChildren(...open.map((id) => new Option(PANEL_LABELS[id] ?? id, id)));
  const wanted = templatePanel(editingFile);
  inspect.value = wanted !== null && open.includes(wanted) ? wanted : open.includes(keep) ? keep : (open[0] ?? "");
  el("te-inspect").disabled = open.length === 0;
}

async function openThemeFile(file) {
  await flushThemeText();
  editingFile = file;
  el("te-status").textContent = "";
  try {
    setThemeText(await themeContent({ op: "readFile", themeId: editingTheme, file }));
    el("te-text").disabled = false;
  } catch (err) {
    setThemeText("");
    el("te-text").disabled = true;
    el("te-status").textContent = err.message;
    el("te-status").className = "form-status bad";
  }
  renderThemeFiles();
}

/** What a new file starts as: what the theme uses now, so a change starts from the look on screen. */
async function starterText(file) {
  if (file === "theme.css") {
    return `/* ${el("te-heading").textContent.replace(/^Edit /, "")}: a stylesheet over the built-in one.

   Anything goes: it is applied after the app's own styles and wins over them.
   Inspect an overlay (below) to see its classes, and the tokens from
   theme.json are here as variables: var(--card), var(--red)… */

`;
  }
  const panel = templatePanel(file);
  const base = await themeContent({ op: "baseTemplate", themeId: editingTheme, panel });
  const own = (await panels()).PANELS[panel]?.template ?? "";
  const body = (base ?? own).trim();
  // A base theme's file keeps its own header comment; the built-in gets one.
  return base !== null
    ? `${body}\n`
    : `<!--
  ${PANEL_LABELS[panel] ?? panel}, as the app builds it. Change anything: this replaces it.

  {{ value | filter }}, data-if, data-each, data-class and <x-group> are the
  template language; <x-…> tags are building blocks drawn in code. Inspect
  the overlay and type overlayData in its console for every value there is.
-->
${body}
`;
}

el("ov-theme-edit").addEventListener("click", async () => {
  editingTheme = el("ov-theme").value;
  editingFile = "theme.json";
  themeEditor?.reset();
  el("te-heading").textContent = `Edit ${el("ov-theme").selectedOptions[0]?.textContent ?? "theme"}`;
  el("te-status").textContent = "";
  el("te-problems").hidden = true;
  try {
    themeFiles = await themeContent({ op: "listFiles", themeId: editingTheme });
  } catch {
    themeFiles = ["theme.json"];
  }
  await openThemeFile("theme.json");
  el("theme-edit").showModal();
  // After the dialog is showing: the editor measures the box it is put in.
  void ensureThemeEditor();
});
el("te-add").addEventListener("change", async () => {
  const file = el("te-add").value;
  if (file === "" || editingTheme === null) return;
  try {
    await flushThemeText();
    themeFiles = await themeContent({ op: "addFile", themeId: editingTheme, file, text: await starterText(file) });
    await openThemeFile(file);
  } catch (err) {
    el("te-status").textContent = err.message;
    el("te-status").className = "form-status bad";
    renderThemeFiles();
  }
});
el("te-remove").addEventListener("click", async () => {
  const button = el("te-remove");
  // Twice, on purpose: a template can be a lot of someone's work.
  if (button.dataset.armed !== "1") {
    button.dataset.armed = "1";
    button.textContent = `Really remove ${fileLabel(editingFile)}?`;
    return;
  }
  clearTimeout(editSaveTimer);
  editSaveTimer = null;
  try {
    themeFiles = await themeContent({ op: "removeFile", themeId: editingTheme, file: editingFile });
  } catch (err) {
    el("te-status").textContent = err.message;
    el("te-status").className = "form-status bad";
  }
  await openThemeFile("theme.json");
});
el("te-inspect").addEventListener("click", () => {
  const panel = el("te-inspect-panel").value;
  if (panel !== "") sendOverlayCommand({ kind: "inspectOverlay", panel });
});
el("te-text").addEventListener("input", themeTextChanged);
// Tab indents, as in an editor, rather than leaving the box.
el("te-text").addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  e.preventDefault();
  const box = el("te-text");
  const at = box.selectionStart;
  box.setRangeText("  ", at, box.selectionEnd, "end");
  box.dispatchEvent(new Event("input"));
});
el("te-reveal").addEventListener("click", () => {
  if (editingTheme !== null) sendOverlayCommand({ kind: "editTheme", id: editingTheme });
});
el("te-close").addEventListener("click", async () => {
  await flushThemeText();
  el("theme-edit").close();
});
el("ov-theme-folder").addEventListener("click", () => sendOverlayCommand({ kind: "openThemesFolder" }));
el("ov-theme-more").addEventListener("click", () => document.dispatchEvent(new CustomEvent("open-themes")));

// -- Publishing a theme of your own (theme-content.ts) ---------------------------

const themeContent = async (request) => {
  const response = await window.exxeed.themeContent(request);
  if (!response.ok) throw new Error(response.error);
  return response.value;
};
let publishingTheme = null;
let themePublishNeedsSignIn = false;

// Signing in while the dialog is closed: the next open reads the new state.
// Signing in with it open (from another window) refreshes it in place.
window.exxeed?.onAccountChanged?.(async () => {
  if (!el("theme-publish").open || publishingTheme === null) return;
  try {
    fillThemePublish(await themeContent({ op: "publishState", themeId: publishingTheme }), true);
  } catch {
    // Left as it was; the next click says what is wrong.
  }
});

const tpStatus = (text, bad = false) => {
  el("tp-status").textContent = text;
  el("tp-status").className = `form-status${bad ? " bad" : ""}`;
};

/** Fill the dialog from what main knows: the item if it was published before, or the theme's own name. */
function fillThemePublish(state, keepFields = false) {
  const item = state.item;
  el("tp-heading").textContent = item?.version ? `Publish v${item.version + 1}` : "Publish theme";
  el("tp-lead").textContent = !state.signedIn
    ? "Sign in (top right) to publish."
    : state.installed
      ? "This theme is someone else's. Make your own copy with New… to publish it."
      : state.problems.length > 0
        ? `Fix the theme file first: ${state.problems[0]}`
        : item?.version
          ? "Publishes the theme as it is now as a new version. People who installed it can update."
          : "Others can find it under Content → Themes, and install it with one click.";
  if (!keepFields) {
    el("tp-title").value = item?.title ?? state.themeName;
    el("tp-summary").value = item?.summary ?? "";
    el("tp-readme").value = item?.readme ?? "";
    el("tp-visibility").value = item?.visibility ?? "public";
    el("tp-changelog").value = "";
  }
  // Signed out, the button says so and takes you to sign-in, rather than
  // sitting there disabled with the reason in small print above.
  themePublishNeedsSignIn = !state.signedIn;
  el("tp-publish").textContent = state.signedIn ? "Publish" : "Sign in to publish";
  el("tp-publish").disabled = state.signedIn && (state.installed || state.problems.length > 0);
  // Why it cannot be published, where the eye is: beside the button.
  if (state.signedIn && (state.installed || state.problems.length > 0)) {
    tpStatus(state.installed ? "This theme is someone else's: use New… to make your own copy." : `Fix the theme file first: ${state.problems[0]}`, true);
  }
  el("tp-shots-section").hidden = item === null;
  el("tp-shots").replaceChildren(
    ...(item?.screenshots ?? []).map((shot) => {
      const figure = document.createElement("figure");
      const img = document.createElement("img");
      img.src = shot.url;
      img.alt = "";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ghost";
      remove.textContent = "✕";
      remove.title = "Remove this screenshot";
      remove.addEventListener("click", async () => {
        try {
          fillThemePublish(await themeContent({ op: "removeScreenshot", themeId: publishingTheme, mediaId: shot.id }), true);
        } catch (err) {
          tpStatus(err.message, true);
        }
      });
      figure.append(img, remove);
      return figure;
    }),
  );
}

el("ov-theme-publish").addEventListener("click", async () => {
  publishingTheme = el("ov-theme").value;
  tpStatus("");
  try {
    fillThemePublish(await themeContent({ op: "publishState", themeId: publishingTheme }));
    el("theme-publish").showModal();
  } catch (err) {
    el("tp-publish").disabled = true;
    el("theme-publish").showModal();
    tpStatus(err.message, true);
  }
});
el("tp-close").addEventListener("click", () => el("theme-publish").close());
el("tp-add-shot").addEventListener("click", async () => {
  try {
    fillThemePublish(await themeContent({ op: "addScreenshot", themeId: publishingTheme }), true);
  } catch (err) {
    tpStatus(err.message, true);
  }
});
el("tp-publish").addEventListener("click", async () => {
  if (themePublishNeedsSignIn) {
    el("theme-publish").close();
    el("account-btn").click();
    return;
  }
  el("tp-publish").disabled = true;
  tpStatus("Publishing…");
  try {
    const message = await themeContent({
      op: "publish",
      themeId: publishingTheme,
      title: el("tp-title").value,
      summary: el("tp-summary").value,
      readme: el("tp-readme").value,
      visibility: el("tp-visibility").value,
      changelog: el("tp-changelog").value,
    });
    fillThemePublish(await themeContent({ op: "publishState", themeId: publishingTheme }));
    tpStatus(`${message}. You can add screenshots now.`);
  } catch (err) {
    tpStatus(err.message, true);
    el("tp-publish").disabled = false;
  }
});
el("ov-theme-delete").addEventListener("click", () => {
  const name = el("ov-theme").selectedOptions[0]?.textContent ?? "this theme";
  if (window.confirm(`Delete the theme "${name}"? Its file is removed.`)) {
    sendOverlayCommand({ kind: "deleteTheme", id: el("ov-theme").value });
  }
});

el("ov-new").addEventListener("click", () => {
  openNextNewProfile = true;
  sendOverlayCommand({ kind: "create", name: "New profile" });
});

window.exxeed?.onOverlayProfiles(renderOverlayProfiles);

// -- First run ------------------------------------------------------------------
// The welcome shows once per install, the first time the window has a status
// to read, and is gone for good once dismissed (Settings.welcomed).

let welcomeShown = false;
function maybeWelcome(status) {
  if (welcomeShown || status?.showWelcome !== true) return;
  welcomeShown = true;
  el("welcome").showModal();
}
const dismissWelcome = () => {
  el("welcome").close();
  window.exxeed?.sendSessionCommand({ kind: "welcomed" });
};
el("welcome-ok").addEventListener("click", dismissWelcome);
el("welcome-test").addEventListener("click", () => {
  dismissWelcome();
  window.exxeed?.sendSessionCommand({ kind: "testMode", value: true });
});
// Escape closes a dialog without its buttons: that counts as read too.
el("welcome").addEventListener("cancel", () => window.exxeed?.sendSessionCommand({ kind: "welcomed" }));
window.exxeed?.onSessionStatus(maybeWelcome);
