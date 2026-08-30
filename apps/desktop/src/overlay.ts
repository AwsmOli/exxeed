/**
 * Overlay windows — SPEC.md §7.
 *
 * One transparent, frameless, always-on-top window per panel. The flags come
 * straight from the spec: `transparent`, `frame: false`, `alwaysOnTop`,
 * `skipTaskbar`, `resizable: false`, plus `setAlwaysOnTop(true, "screen-saver")`
 * to clear the sim.
 *
 * §7 also specifies `setIgnoreMouseEvents(true, { forward: true })` so clicks
 * reach the game, and that is available — but not the default. Click-through and
 * draggable are mutually exclusive, and an overlay nobody can grab is one nobody
 * can arrange; making the arranging case the one that needs a shortcut got it the
 * wrong way round. Grabbable by default, click-through on request.
 *
 * ## Why several windows rather than one
 *
 * A rig has a shape. The delta wants to be near the eyeline, the trace somewhere
 * glanceable, the map wherever there is room — and one combined panel can only be
 * in one of those places. So each panel is its own window with its own remembered
 * position, and they all render the same document with the panel chosen by query
 * string.
 *
 * ## Click-through is global
 *
 * One shortcut switches all of them at once. Per-window switching would mean
 * finding and unlocking each one before moving it, which is the opposite of
 * arranging a layout.
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

import { app, BrowserWindow, globalShortcut, ipcMain, screen } from "electron";

import {
  MOVE_WINDOW_CHANNEL,
  PANEL_SPECS,
  type MoveWindowRequest,
  type PanelId,
} from "@exxeed/overlays";

export const EDIT_MODE_SHORTCUT = "CommandOrControl+Shift+E";

export const FULLSCREEN_WARNING =
  "Overlay mode: run the sim in BORDERLESS WINDOWED, not exclusive fullscreen —\n" +
  "  transparent overlays are not supported over exclusive fullscreen.\n" +
  `  Drag any overlay to move it. ${EDIT_MODE_SHORTCUT} makes them click-through so\n` +
  "  clicks reach the sim instead; press it again to grab them.\n";

/**
 * Windows that have begun closing.
 *
 * `isDestroyed()` is not a sufficient guard and catching is not an option:
 * Electron disposes a render frame early in teardown, and a send after that
 * point does not throw — it logs "Render frame was disposed" from inside
 * Electron, where nothing here can intercept it. The `closed` event is too late
 * to help, because it fires after the frame has already gone.
 *
 * `close` fires at the START of teardown, which is the moment sending has to
 * stop. Closing five overlays at once widened a race that one window mostly hid.
 */
const closing = new WeakSet<BrowserWindow>();

export function markClosing(window: BrowserWindow): void {
  closing.add(window);
}

export function sendTo(window: BrowserWindow, channel: string, payload: unknown): void {
  if (closing.has(window) || window.isDestroyed() || window.webContents.isDestroyed()) return;
  window.webContents.send(channel, payload);
}

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

const GAP = 12;

/**
 * Default positions: down the left edge, each panel below the last, wrapping to
 * a new column when it runs out of height.
 *
 * Stacking by a fixed small offset was worse than useless — five panels landed
 * on top of each other and the first job was pulling a pile apart before any
 * arranging could start.
 */
function defaultPosition(panels: readonly PanelId[], index: number): Bounds {
  const area = screen.getPrimaryDisplay().workArea;
  let x = area.x + 24;
  let y = area.y + 24;
  let columnWidth = 0;

  for (let i = 0; i < index; i++) {
    const previous = PANEL_SPECS[panels[i]!];
    columnWidth = Math.max(columnWidth, previous.width);
    y += previous.height + GAP;

    // Off the bottom of the display — start another column.
    const next = PANEL_SPECS[panels[i + 1]!];
    if (next !== undefined && y + next.height > area.y + area.height) {
      x += columnWidth + GAP;
      y = area.y + 24;
      columnWidth = 0;
    }
  }

  return { x, y };
}

export class OverlayLayout {
  #layout: SavedLayout = loadLayout();
  #windows = new Map<PanelId, BrowserWindow>();
  /**
   * Whether clicks pass straight through to the sim.
   *
   * False by default, which is the inversion that matters: overlays are
   * grabbable unless asked otherwise. The toggle is still worth keeping — an
   * overlay sitting where you want to click is a real nuisance mid-race — but
   * arranging the layout is what people do first, and it should not require
   * knowing about a shortcut.
   */
  #clickThrough = false;
  /** Per-panel debounce, so a drag writes the layout once and not per pixel. */
  #rememberTimers = new Map<PanelId, NodeJS.Timeout>();
  #shortcutRegistered = false;
  #moveHandlerInstalled = false;

  get windows(): readonly BrowserWindow[] {
    return [...this.#windows.values()];
  }

  /** Send to every open overlay. */
  broadcast(channel: string, payload: unknown): void {
    for (const window of this.#windows.values()) sendTo(window, channel, payload);
  }

  create(
    panel: PanelId,
    index: number,
    panels: readonly PanelId[],
    preload: string,
    page: string,
  ): BrowserWindow {
    const spec = PANEL_SPECS[panel];
    const saved = this.#layout[panel];
    const position =
      saved !== undefined && onSomeDisplay(saved.x, saved.y)
        ? saved
        : defaultPosition(panels, index);

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
    // Deliberately NOT click-through by default. An overlay you cannot grab is
    // an overlay you cannot arrange, and making "move it" a two-step ritual
    // behind a shortcut turned the common case into the awkward one. The
    // shortcut still exists, but it now goes the other way: it makes them
    // click-through for driving, rather than grabbable for arranging.
    window.setIgnoreMouseEvents(this.#clickThrough, { forward: true });

    void window.loadFile(page, { search: `overlay=1&panel=${panel}` });

    window.on("close", () => markClosing(window));
    // Persisting on every "moved" would write the settings file continuously
    // for the length of a drag, so it settles first.
    window.on("moved", () => this.#rememberSoon(panel, window));
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
    this.#installMoveHandler();
    return window;
  }

  #remember(panel: PanelId, window: BrowserWindow): void {
    const { x, y } = window.getBounds();
    this.#layout = { ...this.#layout, [panel]: { x, y } };
    saveLayout(this.#layout);
  }

  /**
   * Renderer-driven dragging.
   *
   * Deliberately refuses to move anything while locked. The renderer is not
   * trusted to police that — a window that is click-through cannot be dragged by
   * a user, so a move request arriving in that state means something is wrong,
   * and honouring it would let an overlay wander during a session.
   */
  #installMoveHandler(): void {
    if (this.#moveHandlerInstalled) return;
    this.#moveHandlerInstalled = true;

    ipcMain.on(MOVE_WINDOW_CHANNEL, (event, request: MoveWindowRequest) => {
      if (this.#clickThrough) return;

      const window = BrowserWindow.fromWebContents(event.sender);
      if (window === null || window.isDestroyed()) return;

      // Only windows this layout owns.
      const entry = [...this.#windows].find(([, w]) => w === window);
      if (entry === undefined) return;

      const { dx, dy } = request;
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;

      const { x, y } = window.getBounds();
      window.setPosition(Math.round(x + dx), Math.round(y + dy));
    });
  }

  #registerShortcut(): void {
    if (this.#shortcutRegistered) return;
    this.#shortcutRegistered = globalShortcut.register(EDIT_MODE_SHORTCUT, () => {
      this.toggleEditing();
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
    if (this.#moveHandlerInstalled) {
      ipcMain.removeAllListeners(MOVE_WINDOW_CHANNEL);
      this.#moveHandlerInstalled = false;
    }
  }

  /**
   * Flip layout-edit mode.
   *
   * The layout owns this state rather than the caller. Two places can ask for it
   * — the global shortcut and the View menu — and a second copy of the flag
   * anywhere would drift the first time the other one was used.
   */
  toggleEditing(): void {
    this.setEditing(this.#clickThrough);
  }

  /** `grabbable` false makes the overlays click-through, so clicks reach the sim. */
  setEditing(grabbable: boolean): void {
    this.#clickThrough = !grabbable;
    process.stdout.write(
      grabbable
        ? `overlays grabbable — drag to arrange, ${EDIT_MODE_SHORTCUT} for click-through\n`
        : `overlays click-through — clicks reach the sim, ${EDIT_MODE_SHORTCUT} to grab them\n`,
    );

    for (const [panel, window] of this.#windows) {
      if (window.isDestroyed()) continue;
      window.setIgnoreMouseEvents(this.#clickThrough, { forward: true });
      sendTo(window, "exxeed:edit-mode", grabbable);
      if (!grabbable) this.#remember(panel, window);
    }
  }

  /**
   * Save this window's position once it has stopped moving.
   *
   * "moved" fires continuously through a drag, and #remember writes a file, so
   * persisting on every one of them would rewrite the layout a hundred times to
   * record one move.
   */
  #rememberSoon(panel: PanelId, window: BrowserWindow): void {
    const pending = this.#rememberTimers.get(panel);
    if (pending !== undefined) clearTimeout(pending);
    this.#rememberTimers.set(
      panel,
      setTimeout(() => {
        this.#rememberTimers.delete(panel);
        if (!window.isDestroyed()) this.#remember(panel, window);
      }, 400),
    );
  }
}
