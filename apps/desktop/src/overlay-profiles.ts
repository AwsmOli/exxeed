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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      ...(typeof p["theme"] === "string" && p["theme"] !== "" ? { theme: p["theme"] } : {}),
      ...readScreen(p["screen"]),
      ...(p["hasBackground"] === true ? { hasBackground: true } : {}),
    }));

  if (profiles.length === 0) return fallback;

  const activeProfileId =
    typeof parsed.activeProfileId === "string" && profiles.some((p) => p.id === parsed.activeProfileId)
      ? parsed.activeProfileId
      : profiles[0]!.id;

  return { activeProfileId, profiles };
}

/** A sane resolution, or nothing. */
function readScreen(raw: unknown): { screen?: { width: number; height: number } } {
  if (typeof raw !== "object" || raw === null) return {};
  const { width, height } = raw as { width?: unknown; height?: unknown };
  const ok = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 320 && n <= 16384;
  return ok(width) && ok(height) ? { screen: { width: Math.round(width), height: Math.round(height) } } : {};
}

/** Where a profile's editor screenshot is kept. One per profile, always a PNG/JPEG/WebP. */
export const backgroundPath = (profileId: string): string =>
  join(app.getPath("userData"), "overlay-backgrounds", `${profileId.replace(/[^a-z0-9-]/gi, "_")}.img`);

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
      ...(this.active.theme !== undefined ? { theme: this.active.theme } : {}),
      ...(this.active.screen !== undefined ? { screen: this.active.screen } : {}),
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
    rmSync(backgroundPath(id), { force: true });
  }

  /** Change a profile's own fields: its theme, its resolution. */
  #update(id: string, change: (p: OverlayProfile) => OverlayProfile): void {
    this.#profiles = this.#profiles.map((p) => (p.id === id ? change(p) : p));
    this.#persist();
  }

  setTheme(id: string, theme: string): void {
    this.#update(id, (p) => ({ ...p, theme }));
  }

  setScreen(id: string, width: number, height: number): void {
    const { screen } = readScreen({ width, height });
    if (screen !== undefined) this.#update(id, (p) => ({ ...p, screen }));
  }

  /** The editor's backdrop: image bytes to keep, or null to drop it. */
  setBackground(id: string, image: Buffer | null): void {
    if (!this.#profiles.some((p) => p.id === id)) return;
    const path = backgroundPath(id);
    if (image === null) rmSync(path, { force: true });
    else {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, image);
    }
    this.#update(id, (p) => {
      const { hasBackground: _gone, ...rest } = p;
      return image === null ? rest : { ...rest, hasBackground: true };
    });
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
