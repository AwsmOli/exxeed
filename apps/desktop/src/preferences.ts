/**
 * The preferences window, and the settings IPC behind it.
 *
 * A normal window, not an overlay: it is used with the sim paused or in the
 * background, so none of §7's transparency and click-through applies.
 */

import { fileURLToPath } from "node:url";

import { BrowserWindow, dialog, globalShortcut, ipcMain, shell } from "electron";

import {
  INSTALL_PROGRESS_CHANNEL,
  PIPER_INSTALL_CHANNEL,
  RECORDING_IMPORT_CHANNEL,
  RECORDING_REVEAL_CHANNEL,
  VOICE_DOWNLOAD_CHANNEL,
  SETTINGS_CHANGED_CHANNEL,
  SETTINGS_GET_CHANNEL,
  SETTINGS_SET_CHANNEL,
  type InstallView,
  type RecordingImportView,
  type VoiceSetup,
  type Settings,
  type SettingsPayload,
} from "@exxeed/overlays";
import { localRepositories } from "@exxeed/repo";
import { importRecording, listRecordings } from "@exxeed/telemetry";
import {
  downloadVoice,
  installPiper,
  listInstalledVoices,
  PIPER_DOWNLOADS,
  PIPER_MANUAL_HINT,
  resolvePiper,
  VOICE_CATALOGUE,
} from "@exxeed/tts";

import { mkdir } from "node:fs/promises";

import { debugEnabled, type SettingsStore } from "./settings.js";
import { PIPER_DIR, REPO_ROOT, VOICES_DIR } from "./voices.js";

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
    EXXEED_VOICE_MODEL: "render voice",
  };
  return Object.entries(map)
    .filter(([name]) => {
      const v = process.env[name];
      return v !== undefined && v !== "";
    })
    .map(([, label]) => label);
}

/** What the Voice rendering section draws. Authoring only — see VoiceSetup. */
async function buildVoiceSetup(settings: Settings): Promise<VoiceSetup> {
  const installed = await listInstalledVoices(VOICES_DIR);
  const piper = await resolvePiper({
    setting: settings.piperBinary,
    bundledDir: PIPER_DIR,
    repoRoot: REPO_ROOT,
  });
  const installable = PIPER_DOWNLOADS[process.platform] !== undefined;

  return {
    installed: installed.map((v) => ({ id: v.id, licence: v.catalogue?.licence ?? null })),
    catalogue: VOICE_CATALOGUE.map((v) => ({
      id: v.id,
      label: v.label,
      licence: v.licence,
      attribution: v.attribution,
      bytes: v.bytes,
      installed: installed.some((i) => i.id === v.id),
    })),
    piperFrom: piper?.from ?? null,
    piperHint: piper !== null || installable ? null : PIPER_MANUAL_HINT,
    piperInstallable: piper === null && installable,
    voicesDir: VOICES_DIR,
  };
}

async function buildPayload(
  store: SettingsStore,
  resolveDataDir: (settings: Settings) => string,
  recordingsDir: string,
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

  // Only worth walking the folder when the picker that shows it is visible.
  const recordings = debugEnabled() ? await listRecordings(recordingsDir) : [];

  return {
    settings,
    options: {
      noteSets: noteSets.map((n) => ({
        id: n.id,
        label: `${n.id}  (${n.noteCount} notes, ${n.carClass}, ${n.status})`,
      })),
      voices,
      cars,
      recordings: recordings.map((r) => ({ path: r.path, label: r.label })),
      recordingsDir,
      rendering: await buildVoiceSetup(settings),
      debugEnabled: debugEnabled(),
      dataDir,
      overridden: overriddenFields(),
    },
  };
}

export function installSettingsIpc(
  store: SettingsStore,
  resolveDataDir: (settings: Settings) => string,
  recordingsDir: string,
): void {
  ipcMain.handle(SETTINGS_GET_CHANNEL, () => buildPayload(store, resolveDataDir, recordingsDir));

  ipcMain.handle(SETTINGS_SET_CHANNEL, async (_event, patch: Partial<Settings>) => {
    store.update(patch);
    const payload = await buildPayload(store, resolveDataDir, recordingsDir);

    // Tell every other window too, so two open copies cannot disagree.
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(SETTINGS_CHANGED_CHANNEL, payload);
      }
    }
    return payload;
  });

  /**
   * Import: pick a file, check it will replay, copy it in.
   *
   * The check is the point of the button. Copying a file is trivial; what is
   * worth doing before a session starts is finding out that the file has no
   * frames, or was recorded stationary, at a moment when there is somewhere to
   * say so — rather than at 60 Hz against a panel that just stays empty.
   */
  ipcMain.handle(RECORDING_IMPORT_CHANNEL, async (event): Promise<RecordingImportView> => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const picked = await (owner === null
      ? dialog.showOpenDialog(OPEN_RECORDING)
      : dialog.showOpenDialog(owner, OPEN_RECORDING));

    if (picked.canceled || picked.filePaths[0] === undefined) {
      return { ok: false, message: "", path: null };
    }

    try {
      const result = await importRecording(picked.filePaths[0], recordingsDir);
      if (!result.ok) {
        return {
          ok: false,
          message: `Not imported — ${result.check.problems.join("; ")}`,
          path: null,
        };
      }
      return { ok: true, message: `Imported as ${result.path ?? ""}`, path: result.path ?? null };
    } catch (error) {
      return {
        ok: false,
        message: `Not imported — ${error instanceof Error ? error.message : String(error)}`,
        path: null,
      };
    }
  });

  /**
   * Fetch a voice. Tens of megabytes, so progress goes back to the window.
   *
   * Only catalogue voices, and deliberately: the catalogue is the list whose
   * model *and* dataset licences were read and permit shipping what comes out.
   * A free-text URL here would quietly reintroduce the problem it exists to stop.
   */
  ipcMain.handle(VOICE_DOWNLOAD_CHANNEL, async (event, id: string): Promise<InstallView> => {
    const voice = VOICE_CATALOGUE.find((v) => v.id === id);
    if (voice === undefined) return { ok: false, message: `unknown voice "${id}"` };

    try {
      await downloadVoice(voice, VOICES_DIR, (received, total) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send(INSTALL_PROGRESS_CHANNEL, { id, received, total });
        }
      });
      // Select what was just fetched — downloading a voice and not using it is
      // not a thing anyone does.
      store.update({ renderVoiceId: id });
      return { ok: true, message: `${id} installed` };
    } catch (error) {
      return {
        ok: false,
        message: `Could not download ${id} — ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });

  ipcMain.handle(PIPER_INSTALL_CHANNEL, async (event): Promise<InstallView> => {
    const result = await installPiper(PIPER_DIR, (received, total) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(INSTALL_PROGRESS_CHANNEL, { id: "piper", received, total });
      }
    });
    return { ok: result.ok, message: result.message };
  });

  /**
   * Open the recordings folder, creating it first.
   *
   * On a fresh checkout the folder does not exist yet, and "the button did
   * nothing" is the worst possible answer to "where do I put my laps".
   */
  ipcMain.handle(RECORDING_REVEAL_CHANNEL, async (): Promise<string> => {
    try {
      await mkdir(recordingsDir, { recursive: true });
    } catch (error) {
      return `Could not create ${recordingsDir} — ${error instanceof Error ? error.message : String(error)}`;
    }
    // Returns a message on failure and an empty string on success.
    return shell.openPath(recordingsDir);
  });
}

const OPEN_RECORDING: Electron.OpenDialogOptions = {
  title: "Import a recording",
  filters: [{ name: "Recordings", extensions: ["ndjson"] }],
  properties: ["openFile"],
};

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
