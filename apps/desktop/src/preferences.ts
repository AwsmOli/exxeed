/**
 * The preferences window, and the settings IPC behind it.
 *
 * A normal window, not an overlay: it is used with the sim paused or in the
 * background, so none of §7's transparency and click-through applies.
 */

import { fileURLToPath } from "node:url";

import { BrowserWindow, globalShortcut, ipcMain } from "electron";

import {
  SETTINGS_CHANGED_CHANNEL,
  SETTINGS_GET_CHANNEL,
  SETTINGS_SET_CHANNEL,
  type Settings,
  type SettingsPayload,
} from "@exxeed/overlays";
import { localRepositories } from "@exxeed/repo";

import { debugEnabled, type SettingsStore } from "./settings.js";

export const PREFERENCES_SHORTCUT = "CommandOrControl+Shift+P";

const PAGE = fileURLToPath(new URL("../static/preferences.html", import.meta.url));

/** Which fields the environment is overriding, so the window can say so. */
function overriddenFields(): string[] {
  const map: Record<string, string> = {
    EXXEED_NOTES: "note set",
    EXXEED_VOICE: "voice",
    EXXEED_DATA: "data folder",
    EXXEED_CAR: "reference car",
    EXXEED_LEAD_ADJUST: "lead adjust",
    EXXEED_PANELS: "panels",
    EXXEED_REPLAY: "replay file",
    EXXEED_SPEED: "replay speed",
    EXXEED_SKIP_OUTLAP: "skip out-lap",
  };
  return Object.entries(map)
    .filter(([name]) => {
      const v = process.env[name];
      return v !== undefined && v !== "";
    })
    .map(([, label]) => label);
}

async function buildPayload(
  store: SettingsStore,
  resolveDataDir: (settings: Settings) => string,
): Promise<SettingsPayload & { options: { overridden: string[] } }> {
  const settings = store.get();
  const dataDir = resolveDataDir(settings);
  const repos = localRepositories(dataDir);

  const noteSets = await repos.noteSets.listAll();
  const chosen = noteSets.find((n) => n.id === settings.noteSetId);

  // Only the voices this note set has actually been rendered in, and only the
  // cars with a lap on this track — a picker offering things that do not exist
  // is worse than one that is short.
  const voices = settings.noteSetId === null ? [] : await repos.audio.listVoices(settings.noteSetId);
  const cars = chosen === undefined ? [] : await repos.referenceLaps.listCars(chosen.trackKey);

  return {
    settings,
    options: {
      noteSets: noteSets.map((n) => ({
        id: n.id,
        label: `${n.id}  (${n.noteCount} notes, ${n.carClass}, ${n.status})`,
      })),
      voices,
      cars,
      debugEnabled: debugEnabled(),
      dataDir,
      overridden: overriddenFields(),
    },
  };
}

export function installSettingsIpc(
  store: SettingsStore,
  resolveDataDir: (settings: Settings) => string,
): void {
  ipcMain.handle(SETTINGS_GET_CHANNEL, () => buildPayload(store, resolveDataDir));

  ipcMain.handle(SETTINGS_SET_CHANNEL, async (_event, patch: Partial<Settings>) => {
    store.update(patch);
    const payload = await buildPayload(store, resolveDataDir);

    // Tell every other window too, so two open copies cannot disagree.
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(SETTINGS_CHANGED_CHANNEL, payload);
      }
    }
    return payload;
  });
}

let preferences: BrowserWindow | null = null;

export function openPreferences(preload: string): BrowserWindow {
  if (preferences !== null && !preferences.isDestroyed()) {
    preferences.show();
    preferences.focus();
    return preferences;
  }

  preferences = new BrowserWindow({
    width: 660,
    height: 780,
    title: "Exxeed — Preferences",
    backgroundColor: "#101215",
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  void preferences.loadFile(PAGE);
  preferences.once("closed", () => {
    preferences = null;
  });
  return preferences;
}

export function registerPreferencesShortcut(preload: string): void {
  const registered = globalShortcut.register(PREFERENCES_SHORTCUT, () => {
    openPreferences(preload);
  });
  if (!registered) {
    process.stderr.write(
      `could not register ${PREFERENCES_SHORTCUT} — open preferences from the menu instead\n`,
    );
  }
}
