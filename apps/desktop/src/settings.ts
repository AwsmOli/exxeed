/**
 * The settings store.
 *
 * Persisted as JSON in userData, next to the overlay layout. Environment
 * variables still work, but only as start-up overrides: the scripts and tests in
 * this repo lean on them heavily, and taking them away to add a UI would be
 * trading one group's convenience for another's.
 *
 * An override does NOT get written back to disk. Running one session with
 * `EXXEED_SPEED=8` should not quietly become the saved preference.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { app } from "electron";

import {
  resolveDebugEnabled,
  withDefaults,
  withEnvOverrides,
  type Settings,
} from "@exxeed/overlays";

const overrides = (): Readonly<Record<string, string | undefined>> => process.env;

const settingsPath = (): string => join(app.getPath("userData"), "settings.json");

/**
 * Is the debug surface available at all? One flag, replacing several — and on by
 * default when running from source, so `pnpm dev` needs no flag at all.
 */
export const debugEnabled = (): boolean =>
  resolveDebugEnabled(app.isPackaged, process.env["EXXEED_DEBUG"]);

function readStored(): Partial<Settings> {
  try {
    const raw: unknown = JSON.parse(readFileSync(settingsPath(), "utf8"));
    return typeof raw === "object" && raw !== null ? (raw as Partial<Settings>) : {};
  } catch {
    return {};
  }
}

/**
 * Merge stored values over the defaults, field by field.
 *
 * Not a spread: a settings file written by an older version is missing keys, and
 * a shallow merge would drop the whole `debug` group the moment one field of it
 * was absent.
 */
export class SettingsStore {
  #stored: Partial<Settings> = readStored();
  #current: Settings = withEnvOverrides(withDefaults(this.#stored), overrides());
  #listeners: ((settings: Settings) => void)[] = [];

  get(): Settings {
    return this.#current;
  }

  onChange(listener: (settings: Settings) => void): void {
    this.#listeners.push(listener);
  }

  /** Merge a patch, persist it, and tell everyone. Returns the new settings. */
  update(patch: Partial<Settings>): Settings {
    this.#stored = {
      ...this.#stored,
      ...patch,
      ...(patch.debug === undefined
        ? {}
        : { debug: { ...this.#current.debug, ...patch.debug } }),
    };

    try {
      writeFileSync(settingsPath(), `${JSON.stringify(this.#stored, null, 2)}\n`, "utf8");
    } catch (err) {
      process.stderr.write(`could not save settings: ${String(err)}\n`);
    }

    // Overrides still win after an edit, so what the app is actually doing and
    // what the window shows cannot drift apart.
    this.#current = withEnvOverrides(withDefaults(this.#stored), overrides());
    for (const listener of this.#listeners) listener(this.#current);
    return this.#current;
  }
}
