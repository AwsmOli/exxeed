// Exxeed's own panels — the callout log (§7.3) and the raw telemetry dump.

import { $, html, setText } from "./util.js";

const fixed = (v, n) => (typeof v === "number" ? v.toFixed(n) : "—");

// ---------------------------------------------------------------------------
// Callouts (§7.3): what the engine said, and — the more useful half — what it
// withheld and why. "Why was nothing said" is the question you actually have
// in the car.
// ---------------------------------------------------------------------------

export function callouts() {
  const el = html(`
    <div class="panel is-empty">
      <div class="titlebar split keep"><span>Callouts</span><span class="muted n" data-k="count"></span></div>
      <div class="card grow"><ul class="log"></ul></div>
      <div class="empty">nothing said yet</div>
    </div>`);
  const list = $(el, ".log");
  let seen = -1;

  return {
    el,
    draw(s) {
      if (s.v.events === seen) return;
      seen = s.v.events;
      el.classList.toggle("is-empty", s.events.length === 0);
      setText($(el, '[data-k="count"]'), s.events.length === 0 ? "" : `${s.events.length}`);
      list.replaceChildren(
        ...s.events.map((e) => {
          const li = document.createElement("li");
          li.className = e.className;
          li.textContent = e.text;
          return li;
        }),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Telemetry: the channel dump. A debugging instrument, not something to read
// at 200 km/h — main only opens it in a debug build.
// ---------------------------------------------------------------------------

export function telemetry() {
  const rows = [
    ["LapDistPct", "pct"],
    ["Speed (m/s)", "mps"],
    ["Speed (km/h)", "kph"],
    ["Throttle", "thr"],
    ["Brake", "brk"],
    ["Gear", "gear"],
    ["SteeringWheelAngle", "steer"],
    ["Lat / Lon", "latlon"],
    ["Lap", "lap"],
    ["Suppressed by", "sup"],
    ["Queued", "queued"],
    ["Next note", "next"],
    ["Clips loaded", "clips"],
    ["Frames received", "frames"],
    ["Source", "source"],
  ];
  const el = html(`
    <div class="panel"><div class="card grow">
      <table class="kvt"><tbody>
        ${rows.map(([label, key]) => `<tr><td>${label}</td><td data-k="${key}">—</td></tr>`).join("")}
      </tbody></table>
    </div></div>`);
  const k = (name) => $(el, `[data-k="${name}"]`);

  const nextNote = (s) => {
    const f = s.frame;
    if (s.map === null || f === null) return "—";
    const n = s.map.x.length;
    const armed = new Set(f.armedNoteIds ?? []);
    let best = null;
    for (const note of s.map.notes) {
      // Always positive, the long way round if need be (§4.6) — which is
      // exactly what "next" means here.
      const ahead = (((note.index - Math.floor(f.lapDistPct * n)) % n) + n) % n;
      if (best === null || ahead < best.ahead) best = { ...note, ahead };
    }
    if (best === null) return "—";
    const metres = (best.ahead / n) * s.map.lengthM;
    return `${best.id} · ${metres.toFixed(0)}m · ${armed.has(best.id) ? "armed" : "spent"}`;
  };

  return {
    el,
    draw(s) {
      const f = s.frame;
      setText(k("pct"), fixed(f?.lapDistPct, 5));
      setText(k("mps"), fixed(f?.speedMps, 2));
      setText(k("kph"), fixed(typeof f?.speedMps === "number" ? f.speedMps * 3.6 : undefined, 1));
      setText(k("thr"), fixed(f?.throttle, 2));
      setText(k("brk"), fixed(f?.brake, 2));
      setText(k("gear"), String(f?.gear ?? "—"));
      // M0b reads this off a real lap to pin the sign convention (§5). Shown
      // with an explicit sign so "which way is left" is answerable on sight.
      setText(
        k("steer"),
        typeof f?.steerRad === "number" ? `${f.steerRad >= 0 ? "+" : ""}${f.steerRad.toFixed(4)} rad` : "—",
      );
      const populated = typeof f?.lat === "number" && (f.lat !== 0 || f.lon !== 0);
      setText(k("latlon"), populated ? `${f.lat.toFixed(5)}, ${f.lon.toFixed(5)}` : "not populated");
      setText(k("lap"), String(f?.lap ?? "—"));
      setText(k("sup"), f?.suppressedBy ?? "—");
      k("sup").style.color = f?.suppressedBy ? "var(--orange)" : "";
      setText(k("queued"), f?.queuedNoteIds?.length ? f.queuedNoteIds.join(", ") : "—");
      setText(k("next"), nextNote(s));
      setText(k("clips"), String(s.clips));
      setText(k("frames"), String(s.frames));
      setText(k("source"), f?.sourceName ?? "—");
    },
  };
}
