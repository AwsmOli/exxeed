// Preferences. Everything here changes at human speed, so it is plain DOM with
// no drawing loop and none of §7.0's hot-path rules.

const $ = (id) => document.getElementById(id);

/** Fields that need the session rebuilt rather than just re-read. */
const RELOADING = new Set(["noteSetId", "voiceId", "dataDir", "carId"]);

let current = null;
let options = null;
let savedTimer = null;

const flash = (text) => {
  const el = $("saved");
  el.textContent = text;
  if (savedTimer !== null) clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { el.textContent = ""; }, 2200);
};

const fill = (select, values, selected, emptyLabel) => {
  select.replaceChildren();
  if (emptyLabel !== undefined) {
    const none = document.createElement("option");
    none.value = "";
    none.textContent = emptyLabel;
    select.append(none);
  }
  for (const v of values) {
    const option = document.createElement("option");
    option.value = String(v.value ?? v);
    option.textContent = String(v.label ?? v);
    select.append(option);
  }
  select.value = selected === null || selected === undefined ? "" : String(selected);
};

function render(payload) {
  current = payload.settings;
  options = payload.options;

  $("data-dir").textContent = options.dataDir;

  fill($("noteSet"), options.noteSets.map((n) => ({ value: n.id, label: n.label })),
    current.noteSetId, "— none (telemetry only) —");
  fill($("voice"), options.voices, current.voiceId,
    options.voices.length === 0 ? "— none rendered —" : undefined);
  fill($("car"), options.cars, current.carId, "— first available —");

  $("leadAdjust").value = String(current.leadAdjustS);
  renderVoices(payload.options);

  const panels = $("panels");
  panels.replaceChildren();
  for (const id of ["telemetry", "map", "trace", "delta", "callouts"]) {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = current.panels.includes(id);
    box.addEventListener("change", () => {
      const chosen = [...panels.querySelectorAll("input")]
        .filter((b) => b.checked)
        .map((b) => b.dataset.panel);
      // Refuse to leave nothing: an empty selection opens no windows at all and
      // there is no way back from inside the app.
      if (chosen.length === 0) {
        box.checked = true;
        flash("at least one panel has to stay on");
        return;
      }
      save({ panels: chosen });
    });
    box.dataset.panel = id;
    label.append(box, document.createTextNode(id));
    panels.append(label);
  }

  $("debug").hidden = !options.debugEnabled;
  $("restart-note").hidden = false;

  if (options.debugEnabled) {
    // The picker is the folder. A saved path that is no longer in it still shows,
    // as its own entry, so a missing recording reads as missing rather than as
    // the setting having silently reset itself to "none".
    const recordings = options.recordings ?? [];
    const saved = current.debug.replayPath;
    const entries = recordings.map((r) => ({ value: r.path, label: r.label }));
    if (saved !== null && !recordings.some((r) => r.path === saved)) {
      entries.unshift({ value: saved, label: `${saved}  —  not in the folder` });
    }
    fill($("replayPath"), entries, saved,
      recordings.length === 0
        ? "— none (nothing in the folder yet) —"
        : "— none (connect to iRacing) —");

    $("recordingsDir").textContent = options.recordingsDir ?? "";

    $("replaySpeed").value = String(current.debug.replaySpeed);
    $("loopReplay").checked = current.debug.loopReplay;
    $("skipOutLap").checked = current.debug.skipOutLap;
  }

  // Anything set from the environment wins over what is saved here, so say so
  // rather than letting an edit look like it did nothing.
  const overridden = payload.options.overridden ?? [];
  const note = $("override-note");
  note.hidden = overridden.length === 0;
  if (overridden.length > 0) {
    note.textContent =
      `Set from the environment for this run, so edits to ${overridden.join(", ")} ` +
      `will not take effect until you restart without them.`;
  }
}

const mb = (bytes) => `${(bytes / 1048576).toFixed(0)} MB`;

/**
 * The Voice rendering section.
 *
 * The select mixes what is installed with what can be fetched, because the
 * distinction is not one an author cares about — they want a voice, and whether
 * it is already on disk is the app's problem, not theirs.
 */
function renderVoices(options) {
  const setup = options.rendering;
  if (setup === undefined) return;

  const entries = setup.catalogue.map((v) => ({
    value: v.id,
    label: v.installed ? v.label : `${v.label}  —  download, ${mb(v.bytes)}`,
  }));
  // A voice installed by hand that is not in the catalogue still has to be
  // selectable; it is just one nobody has checked the licence of.
  for (const installed of setup.installed) {
    if (!entries.some((e) => e.value === installed.id)) {
      entries.push({ value: installed.id, label: `${installed.id}  —  licence unchecked` });
    }
  }

  const chosen = current.renderVoiceId ?? setup.installed[0]?.id ?? null;
  fill($("renderVoice"), entries, chosen, setup.installed.length === 0 ? "— none yet —" : undefined);

  const selected = setup.catalogue.find((v) => v.id === $("renderVoice").value);
  $("getVoice").hidden = selected === undefined || selected.installed;
  $("voiceLicence").textContent =
    selected === undefined
      ? "Not one of the checked voices — confirm its licence before shipping audio made with it."
      : selected.attribution === null
        ? selected.licence
        : `${selected.licence}. Credit: ${selected.attribution}`;

  const where = { setting: "the path you set", bundled: "installed here", path: "on PATH", venv: "the project venv" };
  $("piperStatus").textContent =
    setup.piperFrom === null ? "not found" : `found — ${where[setup.piperFrom] ?? setup.piperFrom}`;
  $("getPiper").hidden = !setup.piperInstallable;
  $("piperHint").textContent = setup.piperHint ?? "";
}

async function save(patch) {
  const reloads = Object.keys(patch).some((k) => RELOADING.has(k));
  const payload = await window.exxeed.setSettings(patch);
  render(payload);
  flash(reloads ? "saved — session reloaded" : "saved");
}

$("noteSet").addEventListener("change", (e) =>
  save({ noteSetId: e.target.value === "" ? null : e.target.value }));
$("voice").addEventListener("change", (e) => save({ voiceId: e.target.value }));
$("car").addEventListener("change", (e) =>
  save({ carId: e.target.value === "" ? null : Number(e.target.value) }));
$("leadAdjust").addEventListener("change", (e) => {
  const v = Number(e.target.value);
  if (Number.isFinite(v)) save({ leadAdjustS: v });
});

$("renderVoice").addEventListener("change", (e) =>
  save({ renderVoiceId: e.target.value === "" ? null : e.target.value }));

const progress = $("voiceProgress");
window.exxeed.onInstallProgress((p) => {
  progress.style.display = "";
  progress.className = "hint";
  const pct = p.total > 0 ? ` — ${Math.round((p.received / p.total) * 100)}%` : "";
  progress.textContent = `Downloading ${p.id}${pct}`;
});

const install = async (button, run) => {
  button.disabled = true;
  try {
    const outcome = await run().catch((error) => ({ ok: false, message: String(error) }));
    progress.style.display = "";
    progress.className = outcome.ok ? "hint ok" : "hint bad";
    progress.textContent = outcome.message;
    render(await window.exxeed.getSettings());
  } finally {
    button.disabled = false;
  }
};

$("getVoice").addEventListener("click", () =>
  install($("getVoice"), () => window.exxeed.downloadVoice($("renderVoice").value)));
$("getPiper").addEventListener("click", () =>
  install($("getPiper"), () => window.exxeed.installPiper()));

$("replayPath").addEventListener("change", (e) =>
  save({ debug: { replayPath: e.target.value === "" ? null : e.target.value } }));

$("importRecording").addEventListener("click", async () => {
  const button = $("importRecording");
  const result = $("importResult");
  button.disabled = true;
  try {
    const outcome = await window.exxeed.importRecording().catch((error) => ({
      ok: false, message: `Not imported — ${error?.message ?? error}`, path: null,
    }));
    // An empty message is a cancelled dialog, which is not a failure to report.
    if (outcome.message === "") return;
    result.style.display = "";
    result.className = outcome.ok ? "hint ok" : "hint bad";
    result.textContent = outcome.message;
    // Select what was just imported: importing and then not using it is not
    // a thing anyone does, and the alternative is finding it in the list again.
    if (outcome.ok && outcome.path !== null) {
      await save({ debug: { replayPath: outcome.path } });
    } else {
      render(await window.exxeed.getSettings());
    }
  } finally {
    button.disabled = false;
  }
});
$("replaySpeed").addEventListener("change", (e) => {
  const v = Number(e.target.value);
  if (Number.isFinite(v) && v > 0) save({ debug: { replaySpeed: v } });
});
$("loopReplay").addEventListener("change", (e) => save({ debug: { loopReplay: e.target.checked } }));
$("skipOutLap").addEventListener("change", (e) => save({ debug: { skipOutLap: e.target.checked } }));

$("revealRecordings").addEventListener("click", async () => {
  const problem = await window.exxeed.revealRecordings();
  if (problem) {
    const result = $("importResult");
    result.style.display = "";
    result.className = "hint bad";
    result.textContent = problem;
  }
});

// Coming back from the file manager is the moment a hand-dropped lap should
// appear. Without this the folder button leaves you looking at a stale list with
// no obvious way to refresh it, which is most of the way back to the text box.
//
// Not while a field is being edited: focus returns to whatever was focused when
// you left, and re-rendering there would replace half-typed text with the saved
// value. Any edit commits on change, so the next refresh picks it up anyway.
window.addEventListener("focus", () => {
  const editing = document.activeElement;
  if (editing !== null && editing.tagName === "INPUT" && editing.type !== "checkbox") return;
  window.exxeed.getSettings().then(render);
});

window.exxeed.onSettingsChanged((payload) => render(payload));
window.exxeed.getSettings().then(render);
