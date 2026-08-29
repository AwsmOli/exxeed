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
  if (document.activeElement !== $("piperModel")) $("piperModel").value = current.piperModel ?? "";
  if (document.activeElement !== $("piperBinary")) $("piperBinary").value = current.piperBinary ?? "";

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
    $("replayPath").value = current.debug.replayPath ?? "";
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

const orNull = (v) => (v.trim() === "" ? null : v.trim());
$("piperModel").addEventListener("change", (e) => save({ piperModel: orNull(e.target.value) }));
$("piperBinary").addEventListener("change", (e) => save({ piperBinary: orNull(e.target.value) }));

$("replayPath").addEventListener("change", (e) =>
  save({ debug: { replayPath: e.target.value.trim() === "" ? null : e.target.value.trim() } }));
$("replaySpeed").addEventListener("change", (e) => {
  const v = Number(e.target.value);
  if (Number.isFinite(v) && v > 0) save({ debug: { replaySpeed: v } });
});
$("loopReplay").addEventListener("change", (e) => save({ debug: { loopReplay: e.target.checked } }));
$("skipOutLap").addEventListener("change", (e) => save({ debug: { skipOutLap: e.target.checked } }));

window.exxeed.onSettingsChanged((payload) => render(payload));
window.exxeed.getSettings().then(render);
