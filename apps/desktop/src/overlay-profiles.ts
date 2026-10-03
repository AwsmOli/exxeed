/**
 * Overlay profiles — named, switchable sets of which overlay panels are open.
 *
 * Deliberately split from `overlay.ts`'s per-panel positions: this file only
 * tracks which profiles exist, their names, which panels each one opens, and
 * which one is active. Renaming or reordering profiles never touches a saved
 * drag position, and a profile's positions live in their own
 * `overlay-layout-<id>.json` (see `overlay.ts`) so deleting a profile is one
 * list edit rather than a merge of two files.
 */

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { app } from "electron";

import {
  DEFAULT_PANEL_SETTINGS,
  PANELS,
  sanitizePanelSettings,
  type OverlayProfile,
  type PanelId,
  type PanelSettings,
} from "@exxeed/overlays";

/**
 * The profile every install starts with, and the id the pre-profile single
 * layout (`overlay-layout.json`) is migrated into. Fixed rather than a random
 * id so that migration is a straight lookup.
 */
export const DEFAULT_PROFILE_ID = "default";

interface ProfilesFile {
  readonly activeProfileId: string;
  readonly profiles: readonly OverlayProfile[];
}

const profilesPath = (): string => join(app.getPath("userData"), "overlay-profiles.json");

const isPanelId = (v: unknown): v is PanelId =>
  typeof v === "string" && (PANELS as readonly string[]).includes(v);

function load(defaultPanels: readonly PanelId[]): ProfilesFile {
  const fallback: ProfilesFile = {
    activeProfileId: DEFAULT_PROFILE_ID,
    profiles: [{ id: DEFAULT_PROFILE_ID, name: "Default", panels: defaultPanels }],
  };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(profilesPath(), "utf8"));
  } catch {
    // First run, or a file an older version never wrote. A fresh Default is fine.
    return fallback;
  }

  if (typeof raw !== "object" || raw === null) return fallback;
  const parsed = raw as { activeProfileId?: unknown; profiles?: unknown };
  if (!Array.isArray(parsed.profiles)) return fallback;

  const profiles: OverlayProfile[] = parsed.profiles
    .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null)
    .map((p) => ({
      id: typeof p["id"] === "string" && p["id"] !== "" ? p["id"] : randomUUID(),
      name: typeof p["name"] === "string" && p["name"] !== "" ? p["name"] : "Untitled",
      panels: Array.isArray(p["panels"]) && p["panels"].every(isPanelId) && p["panels"].length > 0
        ? (p["panels"] as PanelId[])
        : defaultPanels,
      settings: readSettings(p["settings"]),
    }));

  if (profiles.length === 0) return fallback;

  const activeProfileId =
    typeof parsed.activeProfileId === "string" && profiles.some((p) => p.id === parsed.activeProfileId)
      ? parsed.activeProfileId
      : profiles[0]!.id;

  return { activeProfileId, profiles };
}

/** A profile's per-overlay settings from disk, with anything unknown dropped. */
function readSettings(raw: unknown): Partial<Record<PanelId, PanelSettings>> {
  const out: Partial<Record<PanelId, PanelSettings>> = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const [panel, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isPanelId(panel)) out[panel] = sanitizePanelSettings(panel, value);
  }
  return out;
}

function save(file: ProfilesFile): void {
  try {
    writeFileSync(profilesPath(), `${JSON.stringify(file, null, 2)}\n`, "utf8");
  } catch {
    // Losing the remembered profile list is not worth taking the app down for.
  }
}

export class OverlayProfileStore {
  #profiles: OverlayProfile[];
  #activeId: string;

  constructor(defaultPanels: readonly PanelId[]) {
    const file = load(defaultPanels);
    this.#profiles = [...file.profiles];
    this.#activeId = file.activeProfileId;
  }

  get profiles(): readonly OverlayProfile[] {
    return this.#profiles;
  }

  get activeId(): string {
    return this.#activeId;
  }

  get active(): OverlayProfile {
    return this.#profiles.find((p) => p.id === this.#activeId) ?? this.#profiles[0]!;
  }

  #persist(): void {
    save({ activeProfileId: this.#activeId, profiles: this.#profiles });
  }

  create(name: string): OverlayProfile {
    const record: OverlayProfile = {
      id: randomUUID(),
      name: name.trim() === "" ? "Untitled" : name.trim(),
      // A blank slate would open nothing, so start from what the active profile
      // already shows — the common case is "one more arrangement like this one".
      panels: [...this.active.panels],
      settings: { ...this.active.settings },
    };
    this.#profiles = [...this.#profiles, record];
    this.#persist();
    return record;
  }

  rename(id: string, name: string): void {
    const trimmed = name.trim();
    if (trimmed === "") return;
    this.#profiles = this.#profiles.map((p) => (p.id === id ? { ...p, name: trimmed } : p));
    this.#persist();
  }

  /**
   * Delete a profile. Refuses to delete the last one — there must always be a
   * profile to fall back to, and inventing one back would surprise whoever just
   * asked to delete their only profile.
   */
  delete(id: string): void {
    if (this.#profiles.length <= 1) return;
    this.#profiles = this.#profiles.filter((p) => p.id !== id);
    if (this.#activeId === id) this.#activeId = this.#profiles[0]!.id;
    this.#persist();
  }

  setActive(id: string): void {
    if (!this.#profiles.some((p) => p.id === id)) return;
    this.#activeId = id;
    this.#persist();
  }

  /** An empty list would open no windows at all, with no way back inside the app. */
  setPanels(id: string, panels: readonly PanelId[]): void {
    if (panels.length === 0) return;
    this.#profiles = this.#profiles.map((p) => (p.id === id ? { ...p, panels: [...panels] } : p));
    this.#persist();
  }

  /** One overlay's settings in a profile; the defaults when none were ever chosen. */
  settingsOf(id: string, panel: PanelId): PanelSettings {
    return this.#profiles.find((p) => p.id === id)?.settings?.[panel] ?? DEFAULT_PANEL_SETTINGS;
  }

  /** Change one overlay's settings in a profile. Returns what is now stored. */
  setSettings(id: string, panel: PanelId, change: (current: PanelSettings) => PanelSettings): PanelSettings {
    const next = sanitizePanelSettings(panel, change(this.settingsOf(id, panel)));
    this.#profiles = this.#profiles.map((p) =>
      p.id === id ? { ...p, settings: { ...p.settings, [panel]: next } } : p,
    );
    this.#persist();
    return next;
  }
}
