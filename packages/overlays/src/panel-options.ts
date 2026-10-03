/**
 * What each overlay shows, and how it is built.
 *
 * Two kinds of choice per overlay, both made per profile in the Overlays tab:
 *
 *  - **parts**: the pieces that can be switched off — a column of Standings,
 *    the rev lights on Input Telemetry, the heat map on the Track Map. Stored
 *    as the list of hidden parts, so a part added later is shown by default.
 *  - **style**: a different structure for the same overlay — the delta as a
 *    bar or as a dial. The first style listed is the default.
 *
 * A theme decides how things look; this decides what is there. They are kept
 * apart so switching theme never changes which columns someone chose.
 */

import type { PanelId } from "./index.js";

export interface PanelChoice {
  readonly id: string;
  readonly label: string;
}

/** The parts of each overlay that can be hidden. Overlays not listed have none. */
export const PANEL_PARTS: Partial<Record<PanelId, readonly PanelChoice[]>> = {
  inputs: [
    { id: "graph", label: "Input trace" },
    { id: "pedals", label: "Pedal bars" },
    { id: "speed", label: "Speed and gear" },
    { id: "wheel", label: "Steering wheel" },
  ],
  pedals: [
    { id: "delta", label: "Delta" },
    { id: "revlights", label: "Rev lights" },
    { id: "graph", label: "Input trace" },
    { id: "pedals", label: "Pedal bars" },
    { id: "reference", label: "Reference speed and gear" },
    { id: "ffb", label: "Force feedback bar" },
    { id: "wheel", label: "Steering wheel" },
  ],
  delta: [
    { id: "number", label: "Delta as a number" },
    { id: "laps", label: "Lap times (themes that show them)" },
  ],
  sectors: [{ id: "laps", label: "Best, last and reference lap" }],
  standings: [
    { id: "header", label: "Session header" },
    { id: "number", label: "Car number" },
    { id: "license", label: "Licence" },
    { id: "irating", label: "iRating" },
    { id: "gap", label: "Gap to leader" },
    { id: "interval", label: "Interval" },
    { id: "last", label: "Last lap" },
    { id: "best", label: "Best lap" },
  ],
  relative: [
    { id: "header", label: "Conditions header" },
    { id: "number", label: "Car number" },
    { id: "lap", label: "Lap" },
    { id: "license", label: "Licence" },
    { id: "irating", label: "iRating" },
    { id: "footer", label: "Lap and time footer" },
  ],
  map: [
    { id: "heat", label: "Delta heat map" },
    { id: "sectors", label: "Sector marks" },
    { id: "callouts", label: "Callout points" },
    { id: "cars", label: "Other cars" },
  ],
  radar: [{ id: "label", label: "Caption (themes that have one)" }],
  minimap: [
    { id: "cars", label: "Other cars" },
    { id: "label", label: "Caption (themes that have one)" },
  ],
  tyres: [
    { id: "temps", label: "Temperatures" },
    { id: "pressure", label: "Pressures" },
    { id: "wear", label: "Wear" },
    { id: "note", label: "Note that the values are from the last pit stop" },
  ],
  fuel: [
    { id: "header", label: "Lap and time header" },
    { id: "bar", label: "Fuel bar" },
    { id: "predicted", label: "Predicted fuel per lap" },
    { id: "usage", label: "Usage table" },
    { id: "finish", label: "Fuel to finish" },
  ],
  weather: [
    { id: "sky", label: "Sky and track state" },
    { id: "humidity", label: "Humidity and rain" },
    { id: "wind", label: "Wind" },
  ],
};

/** The structures an overlay can take. The first is the default. Overlays not listed have one. */
export const PANEL_STYLES: Partial<Record<PanelId, readonly PanelChoice[]>> = {
  delta: [
    { id: "bar", label: "Bar" },
    { id: "dial", label: "Dial" },
  ],
  weather: [
    { id: "strip", label: "Strip" },
    { id: "stack", label: "Stacked cards" },
  ],
  map: [
    { id: "light", label: "Light road" },
    { id: "dark", label: "Dark road with turn numbers" },
  ],
};

export interface PanelSettings {
  /** Ids from `PANEL_PARTS` that are switched off. */
  readonly hidden: readonly string[];
  /** An id from `PANEL_STYLES`, or null for the default. */
  readonly style: string | null;
}

export const DEFAULT_PANEL_SETTINGS: PanelSettings = { hidden: [], style: null };

/** Stored settings with anything unknown dropped — a part or style removed since it was saved. */
export function sanitizePanelSettings(panel: PanelId, raw: unknown): PanelSettings {
  if (typeof raw !== "object" || raw === null) return DEFAULT_PANEL_SETTINGS;
  const r = raw as { hidden?: unknown; style?: unknown };
  const parts = new Set((PANEL_PARTS[panel] ?? []).map((p) => p.id));
  const styles = (PANEL_STYLES[panel] ?? []).map((s) => s.id);
  const hidden = Array.isArray(r.hidden)
    ? [...new Set(r.hidden.filter((h): h is string => typeof h === "string" && parts.has(h)))]
    : [];
  // The default style is stored as null, so a new default later is picked up.
  const style = typeof r.style === "string" && styles.includes(r.style) && r.style !== styles[0] ? r.style : null;
  return { hidden, style };
}

/** Main → every overlay window: `{ panel, settings }`. A window takes the one for its own panel. */
export const PANEL_SETTINGS_CHANNEL = "exxeed:panel-settings";
/** Overlay window → main, invoke with its panel id: the settings to start with. */
export const PANEL_SETTINGS_GET_CHANNEL = "exxeed:panel-settings-get";

export interface PanelSettingsMessage {
  readonly panel: PanelId;
  readonly settings: PanelSettings;
}
