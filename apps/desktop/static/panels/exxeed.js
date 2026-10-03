// Exxeed's own panels — the callout log (§7.3) and the raw telemetry dump.

import { templated } from "./templated.js";

const fixed = (v, n) => (typeof v === "number" ? v.toFixed(n) : "—");

// ---------------------------------------------------------------------------
// Callouts (§7.3): what the engine said, and — the more useful half — what it
// withheld and why. "Why was nothing said" is the question you actually have
// in the car.
// ---------------------------------------------------------------------------

const CALLOUTS = `
<div class="panel callouts" data-class="is-empty: empty">
  <div class="titlebar split keep"><span>Callouts</span><span class="muted n">{{ count }}</span></div>
  <div class="card grow"><ul class="log"><li data-each="events" class="{{ className }}">{{ text }}</li></ul></div>
  <div class="empty">nothing said yet</div>
</div>`;

/** events[]: text, className ("play" or "drop"), newest first. */
export const callouts = templated({
  template: CALLOUTS,
  model: (s) => ({ empty: s.events.length === 0, events: s.events, count: s.events.length || "" }),
  deps: ["events"],
});

// ---------------------------------------------------------------------------
// Telemetry: the channel dump. A debugging instrument, not something to read
// at 200 km/h — main only opens it in a debug build.
// ---------------------------------------------------------------------------

/** The next note on the road ahead, whether it will still speak, and how far. */
function nextNote(s) {
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
}

function telemetryModel(s) {
  const f = s.frame;
  const populated = typeof f?.lat === "number" && (f.lat !== 0 || f.lon !== 0);
  const rows = [
    ["LapDistPct", fixed(f?.lapDistPct, 5)],
    ["Speed (m/s)", fixed(f?.speedMps, 2)],
    ["Speed (km/h)", fixed(typeof f?.speedMps === "number" ? f.speedMps * 3.6 : undefined, 1)],
    ["Throttle", fixed(f?.throttle, 2)],
    ["Brake", fixed(f?.brake, 2)],
    ["Gear", String(f?.gear ?? "—")],
    // M0b reads this off a real lap to pin the sign convention (§5). Shown
    // with an explicit sign so "which way is left" is answerable on sight.
    ["SteeringWheelAngle", typeof f?.steerRad === "number" ? `${f.steerRad >= 0 ? "+" : ""}${f.steerRad.toFixed(4)} rad` : "—"],
    ["Lat / Lon", populated ? `${f.lat.toFixed(5)}, ${f.lon.toFixed(5)}` : "not populated"],
    ["Lap", String(f?.lap ?? "—")],
    ["Suppressed by", f?.suppressedBy ?? "—", Boolean(f?.suppressedBy)],
    ["Queued", f?.queuedNoteIds?.length ? f.queuedNoteIds.join(", ") : "—"],
    ["Next note", nextNote(s)],
    ["Clips loaded", String(s.clips)],
    ["Frames received", String(s.frames)],
    ["Source", f?.sourceName ?? "—"],
  ];
  return { rows: rows.map(([label, value, warn]) => ({ label, value, warn: warn === true })) };
}

const TELEMETRY = `
<div class="panel telemetry">
  <div class="card grow">
    <table class="kvt"><tbody>
      <tr data-each="rows"><td>{{ label }}</td><td data-class="warn: warn">{{ value }}</td></tr>
    </tbody></table>
  </div>
</div>`;

export const telemetry = templated({ template: TELEMETRY, model: telemetryModel });
