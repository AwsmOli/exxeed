/**
 * Preload — the whole IPC surface the renderer gets.
 *
 * Deliberately one-way. The renderer draws and plays sound; it does not drive the
 * telemetry loop, does not own timing, and cannot reach into main (SPEC.md §7).
 *
 * `.mts` rather than `.ts` because Electron requires ESM preload scripts to carry
 * the `.mjs` extension, and tsc emits `.mjs` from `.mts`.
 */

import { contextBridge, ipcRenderer } from "electron";

const STATE_FRAME_CHANNEL = "exxeed:state-frame";
const AUDIO_PRELOAD_CHANNEL = "exxeed:audio-preload";
const AUDIO_PLAY_CHANNEL = "exxeed:audio-play";
const MAP_CHANNEL = "exxeed:map";
const REFERENCE_CHANNEL = "exxeed:reference";
const ENGINE_EVENT_CHANNEL = "exxeed:engine-event";

const subscribe = (channel: string, callback: (payload: unknown) => void): (() => void) => {
  const listener = (_event: unknown, payload: unknown): void => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.off(channel, listener);
};

const EDIT_MODE_CHANNEL = "exxeed:edit-mode";
const MOVE_WINDOW_CHANNEL = "exxeed:move-window";
const SETTINGS_GET_CHANNEL = "exxeed:settings-get";
const SETTINGS_SET_CHANNEL = "exxeed:settings-set";
const SETTINGS_CHANGED_CHANNEL = "exxeed:settings-changed";
const RECORDING_IMPORT_CHANNEL = "exxeed:recording-import";
const RECORDING_REVEAL_CHANNEL = "exxeed:recording-reveal";
const VOICE_DOWNLOAD_CHANNEL = "exxeed:voice-download";
const PIPER_INSTALL_CHANNEL = "exxeed:piper-install";
const INSTALL_PROGRESS_CHANNEL = "exxeed:install-progress";
const EDITOR_LOAD_CHANNEL = "exxeed:editor-load";
const EDITOR_SAVE_CHANNEL = "exxeed:editor-save";
const EDITOR_RENDER_CHANNEL = "exxeed:editor-render";
const EDITOR_RENDER_REQUEST_CHANNEL = "exxeed:editor-render-request";

contextBridge.exposeInMainWorld("exxeed", {
  /** Preferences. The only request/response pair — everything else is one-way. */
  getSettings: (): Promise<unknown> => ipcRenderer.invoke(SETTINGS_GET_CHANNEL),
  setSettings: (patch: unknown): Promise<unknown> =>
    ipcRenderer.invoke(SETTINGS_SET_CHANNEL, patch),
  onSettingsChanged: (cb: (payload: unknown) => void) =>
    subscribe(SETTINGS_CHANGED_CHANNEL, cb),

  /** Pick a recording, check it replays, copy it into the recordings folder. */
  importRecording: (): Promise<unknown> => ipcRenderer.invoke(RECORDING_IMPORT_CHANNEL),

  /** Show the recordings folder, for dropping laps in by hand. */
  revealRecordings: (): Promise<string> => ipcRenderer.invoke(RECORDING_REVEAL_CHANNEL),

  /** Authoring setup: fetch a voice, install Piper, watch either arrive. */
  downloadVoice: (id: string): Promise<unknown> =>
    ipcRenderer.invoke(VOICE_DOWNLOAD_CHANNEL, id),
  installPiper: (): Promise<unknown> => ipcRenderer.invoke(PIPER_INSTALL_CHANNEL),
  onInstallProgress: (fn: (p: unknown) => void): void => {
    ipcRenderer.on(INSTALL_PROGRESS_CHANNEL, (_event, payload) => {
      fn(payload);
    });
  },

  /** The note editor (§7.4). */
  loadNotes: (): Promise<unknown> => ipcRenderer.invoke(EDITOR_LOAD_CHANNEL),
  saveNotes: (patches: unknown): Promise<unknown> =>
    ipcRenderer.invoke(EDITOR_SAVE_CHANNEL, patches),
  renderNotes: (): Promise<unknown> => ipcRenderer.invoke(EDITOR_RENDER_CHANNEL),
  onRenderRequested: (cb: () => void) =>
    subscribe(EDITOR_RENDER_REQUEST_CHANNEL, () => cb()),

  /**
   * Move this window by a screen-pixel delta. The only renderer -> main call:
   * everything else is one-way, because the renderer decides nothing (§7).
   */
  moveWindow(dx: number, dy: number): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    ipcRenderer.send(MOVE_WINDOW_CHANNEL, { dx, dy });
  },
  /** Overlay layout-edit mode toggling on or off (§7). */
  onEditMode: (cb: (editing: unknown) => void) => subscribe(EDIT_MODE_CHANNEL, cb),
  onStateFrame: (cb: (frame: unknown) => void) => subscribe(STATE_FRAME_CHANNEL, cb),
  onAudioPreload: (cb: (clips: unknown) => void) => subscribe(AUDIO_PRELOAD_CHANNEL, cb),
  onAudioPlay: (cb: (command: unknown) => void) => subscribe(AUDIO_PLAY_CHANNEL, cb),
  onMap: (cb: (view: unknown) => void) => subscribe(MAP_CHANNEL, cb),
  onReference: (cb: (view: unknown) => void) => subscribe(REFERENCE_CHANNEL, cb),
  onEngineEvent: (cb: (event: unknown) => void) => subscribe(ENGINE_EVENT_CHANNEL, cb),
});
