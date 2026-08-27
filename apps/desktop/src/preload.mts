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

const subscribe = (channel: string, callback: (payload: unknown) => void): (() => void) => {
  const listener = (_event: unknown, payload: unknown): void => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.off(channel, listener);
};

const EDIT_MODE_CHANNEL = "exxeed:edit-mode";

contextBridge.exposeInMainWorld("exxeed", {
  /** Overlay layout-edit mode toggling on or off (§7). */
  onEditMode: (cb: (editing: unknown) => void) => subscribe(EDIT_MODE_CHANNEL, cb),
  onStateFrame: (cb: (frame: unknown) => void) => subscribe(STATE_FRAME_CHANNEL, cb),
  onAudioPreload: (cb: (clips: unknown) => void) => subscribe(AUDIO_PRELOAD_CHANNEL, cb),
  onAudioPlay: (cb: (command: unknown) => void) => subscribe(AUDIO_PLAY_CHANNEL, cb),
  onMap: (cb: (view: unknown) => void) => subscribe(MAP_CHANNEL, cb),
});
