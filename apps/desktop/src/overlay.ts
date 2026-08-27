/**
 * Overlay window — SPEC.md §7.
 *
 * The window flags come straight from the spec: transparent, frameless,
 * always-on-top, skipTaskbar, non-resizable, plus `setAlwaysOnTop(true,
 * "screen-saver")` to sit above the sim, and `setIgnoreMouseEvents(true, {
 * forward: true })` so clicks pass through to the game underneath.
 *
 * That last one is toggled off in layout-edit mode, because a click-through
 * window cannot be dragged and would otherwise be stuck wherever it first opened.
 *
 * ## The thing that will generate every support question
 *
 * Transparent overlays are NOT supported over exclusive fullscreen. The sim has
 * to run borderless windowed. Worth wording as "unsupported" rather than
 * "impossible": Windows 10/11 Fullscreen Optimizations often converts DX11
 * exclusive fullscreen to a composited path, so some people will report it
 * working anyway and there is no point arguing with them.
 *
 * §7 says this belongs in the first-run flow, not the FAQ. There is no first-run
 * flow until M6, so for now it goes to stdout at launch where it cannot be missed.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { app, BrowserWindow, globalShortcut, screen } from "electron";

export const EDIT_MODE_SHORTCUT = "CommandOrControl+Shift+E";

export const FULLSCREEN_WARNING =
  "Overlay mode: run the sim in BORDERLESS WINDOWED, not exclusive fullscreen —\n" +
  "  transparent overlays are not supported over exclusive fullscreen.\n" +
  `  Press ${EDIT_MODE_SHORTCUT} to unlock the overlay and drag it, again to lock it.\n`;

interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const DEFAULT_SIZE = { width: 340, height: 330 };

const boundsPath = (): string => join(app.getPath("userData"), "overlay-bounds.json");

/**
 * Remembering position matters more than it sounds: the overlay is click-through
 * by default, so a forgotten position means unlocking and re-dragging it every
 * single launch.
 */
function loadBounds(): Bounds {
  const primary = screen.getPrimaryDisplay().workArea;
  const fallback: Bounds = { x: primary.x + 24, y: primary.y + 24, ...DEFAULT_SIZE };

  try {
    const saved = JSON.parse(readFileSync(boundsPath(), "utf8")) as Partial<Bounds>;
    if (typeof saved.x !== "number" || typeof saved.y !== "number") return fallback;

    // A display that was there last time may not be now. Snap back rather than
    // opening the overlay somewhere the user cannot see it.
    const onScreen = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return (
        saved.x! >= a.x - 50 &&
        saved.y! >= a.y - 50 &&
        saved.x! < a.x + a.width &&
        saved.y! < a.y + a.height
      );
    });
    if (!onScreen) return fallback;

    return {
      x: saved.x,
      y: saved.y,
      width: saved.width ?? DEFAULT_SIZE.width,
      height: saved.height ?? DEFAULT_SIZE.height,
    };
  } catch {
    return fallback;
  }
}

function saveBounds(window: BrowserWindow): void {
  try {
    const { x, y, width, height } = window.getBounds();
    writeFileSync(boundsPath(), JSON.stringify({ x, y, width, height }, null, 2), "utf8");
  } catch {
    // Losing a remembered position is not worth taking the app down for.
  }
}

export function createOverlayWindow(preload: string, page: string): BrowserWindow {
  const bounds = loadBounds();

  const window = new BrowserWindow({
    ...bounds,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    // Otherwise the transparent window paints an opaque backdrop on some
    // compositors, which defeats the point.
    backgroundColor: "#00000000",
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // This renderer is the audio output device and the only thing the driver
      // can see. Throttling it when the sim takes focus — which is always —
      // would defeat both jobs (§7).
      backgroundThrottling: false,
    },
  });

  // "screen-saver" is the level that actually sits above a fullscreen game;
  // plain alwaysOnTop is not enough.
  window.setAlwaysOnTop(true, "screen-saver");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.setIgnoreMouseEvents(true, { forward: true });

  void window.loadFile(page, { search: "overlay=1" });

  let editing = false;
  const setEditing = (next: boolean): void => {
    editing = next;
    window.setIgnoreMouseEvents(!editing, { forward: true });
    window.webContents.send("exxeed:edit-mode", editing);
    if (!editing) saveBounds(window);
  };

  const registered = globalShortcut.register(EDIT_MODE_SHORTCUT, () => setEditing(!editing));
  if (!registered) {
    process.stderr.write(
      `could not register ${EDIT_MODE_SHORTCUT} — the overlay cannot be unlocked to move it\n`,
    );
  }

  // Where it actually landed. Worth printing: over a fullscreen sim the overlay
  // may be invisible, and "is it off-screen or is it behind the game?" is
  // otherwise unanswerable.
  const b = window.getBounds();
  process.stdout.write(
    `  overlay at ${b.x},${b.y} ${b.width}x${b.height} — ` +
      `alwaysOnTop=${String(window.isAlwaysOnTop())}, click-through until unlocked\n`,
  );

  window.on("moved", () => {
    if (editing) saveBounds(window);
  });
  window.once("closed", () => globalShortcut.unregister(EDIT_MODE_SHORTCUT));

  return window;
}
