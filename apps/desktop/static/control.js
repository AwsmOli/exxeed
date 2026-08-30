// The control window's renderer. It decides nothing (§7) — it sends three
// commands and draws whatever main tells it the state is.

const el = (id) => document.getElementById(id);

const PHASES = {
  stopped: "Stopped",
  waiting: "Waiting for the sim",
  running: "Running",
};

let phase = "stopped";

const render = (s) => {
  phase = s.phase;

  el("phase").textContent = PHASES[s.phase] ?? s.phase;
  el("dot").className = `dot ${s.phase}`;
  el("detail").textContent = s.detail ?? "";

  const power = el("power");
  // Stopped is the only state with nothing running to stop; waiting counts as on,
  // because it is the app trying, and the button has to be able to call it off.
  power.textContent = s.phase === "stopped" ? "Start" : "Stop";
  power.classList.toggle("on", s.phase !== "stopped");

  el("track").textContent = s.trackName ?? "—";
  el("car").textContent = s.carName ?? "—";
  el("notes").textContent = s.noteSetId ?? "—";
  el("recording").textContent =
    s.recordingTo === null
      ? s.phase === "running"
        ? "not needed — this track is mapped"
        : "—"
      : s.recordingTo;

  el("autoStart").checked = s.autoStart === true;
  el("runAtLogin").checked = s.runAtLogin === true;
  el("startMinimized").checked = s.startMinimized === true;
};

el("power").addEventListener("click", () => {
  window.exxeed?.sendSessionCommand({ kind: phase === "stopped" ? "start" : "stop" });
});

for (const kind of ["autoStart", "runAtLogin", "startMinimized"]) {
  el(kind).addEventListener("change", (event) => {
    window.exxeed?.sendSessionCommand({ kind, value: event.target.checked });
  });
}

// Closing the window only hides it now, so quitting needs its own control.
el("quit").addEventListener("click", () => {
  window.exxeed?.sendSessionCommand({ kind: "quit" });
});

window.exxeed?.onSessionStatus(render);
