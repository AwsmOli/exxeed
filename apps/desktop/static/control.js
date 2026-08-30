// The control window's renderer. It decides nothing (§7) — it sends commands and
// draws whatever main says the state is.

const el = (id) => document.getElementById(id);

const PHASES = {
  stopped: "Stopped",
  waiting: "Waiting for the sim",
  running: "Running",
};

let phase = "stopped";

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
        edit.className = "pack-edit";
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

el("pick-auto").addEventListener("change", () => {
  window.exxeed?.sendSessionCommand({ kind: "selectNoteSet", id: null });
});

window.exxeed?.onSessionStatus(render);
