/**
 * Preload — the whole IPC surface the renderer gets.
 *
 * Deliberately one-way and one channel. The renderer draws; it does not drive the
 * telemetry loop, does not own timing, and cannot reach into main (SPEC.md §7).
 *
 * `.mts` rather than `.ts` because Electron requires ESM preload scripts to carry
 * the `.mjs` extension, and tsc emits `.mjs` from `.mts`.
 */

import { contextBridge, ipcRenderer } from "electron";

const STATE_FRAME_CHANNEL = "exxeed:state-frame";

contextBridge.exposeInMainWorld("exxeed", {
  onStateFrame(callback: (frame: unknown) => void): () => void {
    const listener = (_event: unknown, frame: unknown): void => callback(frame);
    ipcRenderer.on(STATE_FRAME_CHANNEL, listener);
    return () => ipcRenderer.off(STATE_FRAME_CHANNEL, listener);
  },
});
