/**
 * Overlay windows — SPEC.md §7.
 *
 * One transparent, frameless, click-through window per panel. The flags come
 * straight from the spec: `transparent`, `frame: false`, `alwaysOnTop`,
 * `skipTaskbar`, `resizable: false`, plus `setAlwaysOnTop(true, "screen-saver")`
 * to clear the sim and `setIgnoreMouseEvents(true, { forward: true })` so clicks
 * reach the game.
 *
 * ## Why several windows rather than one
 *
 * A rig has a shape. The delta wants to be near the eyeline, the trace somewhere
 * glanceable, the map wherever there is room — and one combined panel can only be
 * in one of those places. So each panel is its own window with its own remembered
 * position, and they all render the same document with the panel chosen by query
 * string.
 *
 * ## Layout-edit mode is global
 *
 * Click-through windows cannot be dragged, so one shortcut unlocks all of them at
 * once. Per-window unlocking would mean finding and unlocking each one before
 * moving it, which is the opposite of arranging a layout.
 *
 * ## The thing that will generate every support question
 *
 * Transparent overlays are NOT supported over exclusive fullscreen. The sim has
 * to run borderless windowed. Worth wording as "unsupported" rather than
 * "impossible": Windows 10/11 Fullscreen Optimizations often converts DX11
 * exclusive fullscreen to a composited path, so some people will report it
 * working anyway and there is no point arguing with them.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { app, BrowserWindow, globalShortcut, screen } from "electron";

import { PANEL_SPECS, type PanelId } from "@exxeed/overlays";

export const EDIT_MODE_SHORTCUT = "CommandOrControl+Shift+E";

export const FULLSCREEN_WARNING =
  "Overlay mode: run the sim in BORDERLESS WINDOWED, not exclusive fullscreen —\n" +
  "  transparent overlays are not supported over exclusive fullscreen.\n" +
  `  Press ${EDIT_MODE_SHORTCUT} to unlock every overlay and drag it, again to lock.\n`;

interface Bounds {
  readonly x: number;
  readonly y: number;
}

type SavedLayout = Partial<Record<PanelId, Bounds>>;

const layoutPath = (): string => join(app.getPath("userData"), "overlay-layout.json");

function loadLayout(): SavedLayout {
  try {
    const raw: unknown = JSON.parse(readFileSync(layoutPath(), "utf8"));
    if (typeof raw !== "object" || raw === null) return {};
    return raw as SavedLayout;
  } catch {
    // No layout yet, or one written by an older version. Defaults are fine.
    return {};
  }
}

function saveLayout(layout: SavedLayout): void {
  try {
    writeFileSync(layoutPath(), `${JSON.stringify(layout, null, 2)}\n`, "utf8");
  } catch {
    // Losing a remembered layout is not worth taking the app down for.
  }
}

/** Is this position on a display that still exists? */
function onSomeDisplay(x: number, y: number): boolean {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return x >= a.x - 50 && y >= a.y - 50 && x < a.x + a.width && y < a.y + a.height;
  });
}

/**
 * Default positions: stacked down the left edge, in panel order. Deliberately not
 * overlapping, so a first run gives something arrangeable rather than a pile.
 */
function defaultPosition(index: number): Bounds {
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + 24, y: area.y + 24 + index * 8 };
}

export class OverlayLayout {
  #layout: SavedLayout = loadLayout();
  #windows = new Map<PanelId, BrowserWindow>();
  #editing = false;
  #shortcutRegistered = false;

  get windows(): readonly BrowserWindow[] {
    return [...this.#windows.values()];
  }

  /** Send to every open overlay. */
  broadcast(channel: string, payload: unknown): void {
    for (const window of this.#windows.values()) {
      if (!window.webContents.isDestroyed()) window.webContents.send(channel, payload);
    }
  }

  create(panel: PanelId, index: number, preload: string, page: string): BrowserWindow {
    const spec = PANEL_SPECS[panel];
    const saved = this.#layout[panel];
    const position =
      saved !== undefined && onSomeDisplay(saved.x, saved.y) ? saved : defaultPosition(index);

    const window = new BrowserWindow({
      x: position.x,
      y: position.y,
      width: spec.width,
      height: spec.height,
      title: `Exxeed — ${spec.title}`,
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
        // One of these windows is the audio device and all of them are things the
        // driver has to be able to read. Throttling when the sim takes focus —
        // which is always — would defeat both (§7).
        backgroundThrottling: false,
      },
    });

    // "screen-saver" is the level that actually sits above a fullscreen game;
    // plain alwaysOnTop is not enough.
    window.setAlwaysOnTop(true, "screen-saver");
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.setIgnoreMouseEvents(true, { forward: true });

    void window.loadFile(page, { search: `overlay=1&panel=${panel}` });

    window.on("moved", () => {
      if (this.#editing) this.#remember(panel, window);
    });
    window.once("closed", () => {
      this.#windows.delete(panel);
      if (this.#windows.size === 0) this.#releaseShortcut();
    });

    // Where it actually landed. Worth printing: over a fullscreen sim an overlay
    // can be invisible, and "off-screen or behind the game?" is otherwise
    // unanswerable.
    const restored = saved !== undefined && position === saved;
    process.stdout.write(
      `  ${panel.padEnd(9)} ${String(position.x).padStart(5)},${String(position.y).padEnd(5)} ` +
        `${spec.width}x${spec.height}${restored ? "  (remembered)" : ""}\n`,
    );

    this.#windows.set(panel, window);
    this.#registerShortcut();
    return window;
  }

  #remember(panel: PanelId, window: BrowserWindow): void {
    const { x, y } = window.getBounds();
    this.#layout = { ...this.#layout, [panel]: { x, y } };
    saveLayout(this.#layout);
  }

  #registerShortcut(): void {
    if (this.#shortcutRegistered) return;
    this.#shortcutRegistered = globalShortcut.register(EDIT_MODE_SHORTCUT, () => {
      this.setEditing(!this.#editing);
    });
    if (!this.#shortcutRegistered) {
      process.stderr.write(
        `could not register ${EDIT_MODE_SHORTCUT} — overlays cannot be unlocked to move\n`,
      );
    }
  }

  #releaseShortcut(): void {
    if (!this.#shortcutRegistered) return;
    globalShortcut.unregister(EDIT_MODE_SHORTCUT);
    this.#shortcutRegistered = false;
  }

  setEditing(editing: boolean): void {
    this.#editing = editing;

    for (const [panel, window] of this.#windows) {
      if (window.isDestroyed()) continue;
      window.setIgnoreMouseEvents(!editing, { forward: true });
      window.webContents.send("exxeed:edit-mode", editing);
      if (!editing) this.#remember(panel, window);
    }
  }
}
