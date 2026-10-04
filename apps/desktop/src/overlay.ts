/**
 * Overlay windows — SPEC.md §7.
 *
 * One transparent, frameless, always-on-top window per panel. The flags come
 * straight from the spec: `transparent`, `frame: false`, `alwaysOnTop`,
 * `skipTaskbar`, `resizable: true`, plus `setAlwaysOnTop(true, "screen-saver")`
 * to clear the sim. Resizable like any other window — dragging an edge works
 * the same way it does on a normal frameless-but-bordered window, and the
 * size is remembered per panel alongside its position.
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

import { app, BrowserWindow, globalShortcut, ipcMain, Menu, screen } from "electron";

import {
  MIRROR_PAIRS,
  mirrorBounds,
  MOVE_WINDOW_CHANNEL,
  PANEL_SPECS,
  type MoveWindowRequest,
  type PanelId,
} from "@exxeed/overlays";

import { DEFAULT_PROFILE_ID } from "./overlay-profiles.js";

export const EDIT_MODE_SHORTCUT = "CommandOrControl+Shift+E";

export const FULLSCREEN_WARNING =
  "Overlay mode: run the sim in BORDERLESS WINDOWED, not exclusive fullscreen —\n" +
  "  transparent overlays are not supported over exclusive fullscreen.\n" +
  `  Drag any overlay to move it. ${EDIT_MODE_SHORTCUT} makes them click-through so\n` +
  "  clicks reach the sim instead; press it again to grab them.\n" +
  "  Right-click any overlay for Exxeed, or to hide it or all of them.\n";

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

/** Every overlay window, so the dock can tell them from ordinary windows. */
const overlays = new WeakSet<BrowserWindow>();

export const isOverlayWindow = (window: BrowserWindow): boolean => overlays.has(window);

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
  /** Absent for a layout saved before resizing existed — falls back to the
   *  panel's default size (`PANEL_SPECS`). */
  readonly width?: number;
  readonly height?: number;
}

type SavedLayout = Partial<Record<PanelId, Bounds>>;

const layoutPath = (profileId: string): string =>
  join(app.getPath("userData"), `overlay-layout-${profileId}.json`);

/** Where positions lived before profiles existed — read once, as a fallback. */
const legacyLayoutPath = (): string => join(app.getPath("userData"), "overlay-layout.json");

function readLayoutFile(path: string): SavedLayout | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof raw === "object" && raw !== null ? (raw as SavedLayout) : null;
  } catch {
    return null;
  }
}

/**
 * The default profile carries the pre-profile id (`overlay-profiles.ts`), so
 * falling back to the old single-layout file only when its own hasn't been
 * written yet is what migrates a pre-profile install without a copy step: the
 * first save under the new name simply supersedes it.
 */
function loadLayout(profileId: string): SavedLayout {
  const own = readLayoutFile(layoutPath(profileId));
  if (own !== null) return own;
  if (profileId !== DEFAULT_PROFILE_ID) return {};
  return readLayoutFile(legacyLayoutPath()) ?? {};
}

function saveLayout(profileId: string, layout: SavedLayout): void {
  try {
    writeFileSync(layoutPath(profileId), `${JSON.stringify(layout, null, 2)}\n`, "utf8");
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

/** A window's place on the desktop, in DIPs, height included. */
export interface PlacedBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

type DesignOf = (panel: PanelId) => readonly [number, number];

/**
 * Where each of `panels` sits for a profile: where it was put, else its
 * default place, sized from its remembered width and its design's shape —
 * the same rules `OverlayLayout#create` opens a window by.
 */
function placesFrom(layout: SavedLayout, panels: readonly PanelId[], designOf: DesignOf): Partial<Record<PanelId, PlacedBounds>> {
  const out: Partial<Record<PanelId, PlacedBounds>> = {};
  panels.forEach((panel, index) => {
    const saved = layout[panel];
    const position = saved !== undefined && onSomeDisplay(saved.x, saved.y) ? saved : defaultPosition(panels, index);
    const design = designOf(panel);
    const width = position.width ?? design[0];
    out[panel] = { x: position.x, y: position.y, width, height: Math.round((width * design[1]) / design[0]) };
  });
  return out;
}

/** Where a profile that is not open puts its overlays (see `placesFrom`). */
export function profilePlaces(profileId: string, panels: readonly PanelId[], designOf: DesignOf): Partial<Record<PanelId, PlacedBounds>> {
  return placesFrom(loadLayout(profileId), panels, designOf);
}

/** Put one overlay of a profile that is not open somewhere, or (null) back in its default place. */
export function placeInProfile(profileId: string, panel: PanelId, bounds: PlacedBounds | null): void {
  const layout = { ...loadLayout(profileId) };
  if (bounds === null) delete layout[panel];
  else layout[panel] = { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) };
  saveLayout(profileId, layout);
}

export class OverlayLayout {
  #profileId: string;
  #layout: SavedLayout;
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
  #onShowMainWindow: () => void;

  /** Whether a left/right pair moves together (its "mirrored" style); mirrored unless set otherwise. */
  #isMirrored: (panel: PanelId) => boolean = () => true;
  /** Set while placing a partner window, so its own move does not place this one back. */
  #mirroring = false;

  setMirrorTest(test: (panel: PanelId) => boolean): void {
    this.#isMirrored = test;
  }

  /**
   * Put `panel`'s partner (MIRROR_PAIRS) where `window` is, mirrored on the
   * vertical centre line of the screen it is on: same height on the screen,
   * same size, the other side.
   */
  mirrorFrom(panel: PanelId): void {
    const partner = MIRROR_PAIRS[panel];
    const window = this.#windows.get(panel);
    if (partner === undefined || window === undefined || window.isDestroyed() || this.#mirroring) return;
    if (!this.#isMirrored(panel) || !this.#isMirrored(partner)) return;
    const other = this.#windows.get(partner);
    if (other === undefined || other.isDestroyed()) return;
    const b = window.getBounds();
    const target = mirrorBounds(b, screen.getDisplayMatching(b).bounds);
    const now = other.getBounds();
    // Already there (or within a pixel of rounding): nothing to do, and no echo back.
    if (Math.abs(now.x - target.x) <= 1 && Math.abs(now.y - target.y) <= 1 && Math.abs(now.width - target.width) <= 1 && Math.abs(now.height - target.height) <= 1) return;
    this.#mirroring = true;
    try {
      other.setBounds(target);
    } finally {
      this.#mirroring = false;
    }
    this.#rememberSoon(partner, other);
  }

  /** Overlay id → [width, height] the current theme designs it at. */
  #sizes: Readonly<Record<string, readonly [number, number]>> = {};
  /** The design size each open window was last laid out for. */
  readonly #designed = new Map<PanelId, readonly [number, number]>();

  /** The size `panel` is designed at: the theme's, else the app's own. */
  #designOf(panel: PanelId): readonly [number, number] {
    const spec = PANEL_SPECS[panel];
    return this.#sizes[panel] ?? [spec.width, spec.height];
  }

  /**
   * The theme's design sizes. Every open window takes its overlay's shape,
   * at the scale it was at: a window made half size stays half size, in the
   * new theme's proportions.
   */
  setDesignSizes(sizes: Readonly<Record<string, readonly [number, number]>>): void {
    this.#sizes = sizes;
    for (const [panel, window] of this.#windows) {
      if (window.isDestroyed()) continue;
      const before = this.#designed.get(panel);
      const next = this.#designOf(panel);
      if (before !== undefined && before[0] === next[0] && before[1] === next[1]) continue;
      const { width } = window.getBounds();
      const scale = before === undefined ? width / next[0] : width / before[0];
      this.#shape(window, next);
      window.setSize(Math.round(next[0] * scale), Math.round(next[1] * scale));
      this.#designed.set(panel, next);
    }
  }

  /** Lock a window to its design's proportions, and to no less than a third of it. */
  #shape(window: BrowserWindow, design: readonly [number, number]): void {
    window.setAspectRatio(design[0] / design[1]);
    window.setMinimumSize(Math.max(40, Math.round(design[0] * 0.3)), Math.max(14, Math.round(design[1] * 0.3)));
  }

  constructor(profileId: string, onShowMainWindow: () => void) {
    this.#profileId = profileId;
    this.#layout = loadLayout(profileId);
    this.#onShowMainWindow = onShowMainWindow;
  }

  get windows(): readonly BrowserWindow[] {
    return [...this.#windows.values()];
  }

  /**
   * Chromium's developer tools on one overlay, in a window of their own: how
   * a theme's template came out, which classes to style, and — as
   * `overlayData` in its console — the data the template was given.
   */
  inspect(panel: PanelId): void {
    const window = this.#windows.get(panel);
    if (window === undefined || window.isDestroyed()) return;
    window.webContents.openDevTools({ mode: "detach", activate: true });
  }

  /** Send to every open overlay. */
  broadcast(channel: string, payload: unknown): void {
    if (this.#sticky.has(channel)) this.#last.set(channel, payload);
    for (const window of this.#windows.values()) sendTo(window, channel, payload);
  }

  /** Channels whose last message a window opened later is caught up with. */
  readonly #sticky = new Set<string>();
  readonly #last = new Map<string, unknown>();
  readonly #changed: (() => void)[] = [];

  /**
   * Remember the last message on these channels — the map, the reference
   * lap, the race, the session's status — so an overlay added while a session
   * runs gets them too, instead of every overlay being rebuilt to resend them.
   */
  setSticky(channels: readonly string[]): void {
    for (const c of channels) this.#sticky.add(c);
  }

  /** Called whenever an overlay is added or removed. */
  onWindowsChanged(callback: () => void): void {
    this.#changed.push(callback);
  }

  /** The overlays open now, in the order they were opened. */
  get panels(): PanelId[] {
    return [...this.#windows.keys()];
  }

  /**
   * Open the overlays in `panels` that are not open and close the ones that
   * are open but not in it, leaving the rest exactly as they are. Returns the
   * windows it opened, so the caller can wire them up.
   */
  sync(panels: readonly PanelId[], preload: string, page: string): BrowserWindow[] {
    const wanted = new Set(panels);
    for (const [panel, window] of [...this.#windows]) {
      if (wanted.has(panel) || window.isDestroyed()) continue;
      this.#remember(panel, window);
      window.close();
      this.#windows.delete(panel);
      this.#designed.delete(panel);
    }
    const opened: BrowserWindow[] = [];
    panels.forEach((panel, index) => {
      if (this.#windows.has(panel)) return;
      const window = this.create(panel, index, panels, preload, page);
      // Caught up once it is listening: edit mode, then what it missed.
      window.webContents.once("did-finish-load", () => {
        sendTo(window, "exxeed:edit-mode", !this.#clickThrough);
        for (const [channel, payload] of this.#last) sendTo(window, channel, payload);
      });
      opened.push(window);
    });
    for (const callback of this.#changed) callback();
    return opened;
  }

  /**
   * Show or hide every overlay at once.
   *
   * Hidden rather than closed: closing would destroy the renderers, and they
   * hold the decoded audio and the reference-lap arrays that were loaded once at
   * session start (§4.5). Rebuilding all of that to stop showing a panel would
   * be a large cost for a visual change — and the audio would have to be
   * re-decoded before the first callout of the next session.
   */
  setVisible(visible: boolean): void {
    for (const window of this.#windows.values()) {
      if (window.isDestroyed()) continue;
      if (visible) window.showInactive();
      else window.hide();
    }
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

    // The theme's design size sets the shape; the remembered width, how big.
    const design = this.#designOf(panel);
    const width = position.width ?? design[0];
    const height = Math.round((width * design[1]) / design[0]);

    const window = new BrowserWindow({
      x: position.x,
      y: position.y,
      width,
      height,
      // A panel is laid out at its theme's design size and scaled to its
      // window (renderer.js), so it may be made small — but not to nothing:
      // a panel shrunk away is lost, not smaller.
      minWidth: Math.max(40, Math.round(design[0] * 0.3)),
      minHeight: Math.max(14, Math.round(design[1] * 0.3)),
      title: `Exxeed — ${spec.title}`,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      // Resizable like any other window (§7 originally said otherwise, but a
      // fixed size was never the point — it was just what nobody had asked to
      // change yet). Dragging the edge of a frameless, transparent window
      // still works on Windows: OS-level hit-testing for the resize border
      // happens before a click reaches the page, so it does not fight with
      // the renderer's own mousedown-drag-to-move handler.
      resizable: true,
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
    // skipTransformProcessType: without it, macOS makes the whole app an
    // "accessory" process the moment this runs, which removes its dock icon —
    // for the control window and the editor too, not just the overlays. The
    // dock is managed deliberately instead (`syncDock` in main.ts).
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    overlays.add(window);
    // Deliberately NOT click-through by default. An overlay you cannot grab is
    // an overlay you cannot arrange, and making "move it" a two-step ritual
    // behind a shortcut turned the common case into the awkward one. The
    // shortcut still exists, but it now goes the other way: it makes them
    // click-through for driving, rather than grabbable for arranging.
    window.setIgnoreMouseEvents(this.#clickThrough, { forward: true });

    void window.loadFile(page, {
      search: `overlay=1&panel=${panel}&w=${design[0]}&h=${design[1]}`,
    });
    // Resizing keeps the overlay's shape: it scales, it does not reflow.
    window.setAspectRatio(design[0] / design[1]);
    this.#designed.set(panel, design);

    window.on("close", () => markClosing(window));
    // Persisting on every "moved"/"resized" would write the settings file
    // continuously for the length of a drag, so it settles first.
    window.on("moved", () => this.#rememberSoon(panel, window));
    window.on("resized", () => this.#rememberSoon(panel, window));
    // A mirrored pair follows along, live, while one of them is dragged or sized.
    window.on("move", () => this.mirrorFrom(panel));
    window.on("resize", () => this.mirrorFrom(panel));
    // The second of a mirrored pair to open takes its place from the first.
    const partner = MIRROR_PAIRS[panel];
    if (partner !== undefined && this.#windows.has(partner)) setImmediate(() => this.mirrorFrom(partner));
    window.once("closed", () => {
      this.#windows.delete(panel);
      if (this.#windows.size === 0) this.#releaseShortcut();
    });
    // Only reaches this window while it is grabbable — click-through forwards
    // a right-click to the sim same as any other, which is what someone who
    // locked the overlays for driving wants.
    window.webContents.on("context-menu", () => this.#showContextMenu(window));

    // Where it actually landed. Worth printing: over a fullscreen sim an overlay
    // can be invisible, and "off-screen or behind the game?" is otherwise
    // unanswerable.
    const restored = saved !== undefined && position === saved;
    process.stdout.write(
      `  ${panel.padEnd(9)} ${String(position.x).padStart(5)},${String(position.y).padEnd(5)} ` +
        `${width}x${height}${restored ? "  (remembered)" : ""}\n`,
    );

    this.#windows.set(panel, window);
    this.#registerShortcut();
    this.#installMoveHandler();
    return window;
  }

  #remember(panel: PanelId, window: BrowserWindow): void {
    const { x, y, width, height } = window.getBounds();
    this.#layout = { ...this.#layout, [panel]: { x, y, width, height } };
    saveLayout(this.#profileId, this.#layout);
    for (const callback of this.#saved) callback();
  }

  readonly #saved: (() => void)[] = [];

  /** Called whenever a position is saved — an overlay dragged or sized on screen. */
  onLayoutSaved(callback: () => void): void {
    this.#saved.push(callback);
  }

  /** Where each of `panels` is: open windows where they are, the rest where they would open. */
  places(panels: readonly PanelId[]): Partial<Record<PanelId, PlacedBounds>> {
    const out = placesFrom(this.#layout, panels, (p) => this.#designOf(p));
    for (const panel of panels) {
      const window = this.#windows.get(panel);
      if (window !== undefined && !window.isDestroyed()) out[panel] = window.getBounds();
    }
    return out;
  }

  /**
   * Put an overlay somewhere, from the profile editor: the open window moves
   * there and the place is saved; a closed one opens there next time. Null
   * forgets the place, back to the default.
   */
  place(panel: PanelId, bounds: PlacedBounds | null): void {
    const window = this.#windows.get(panel);
    if (bounds === null) {
      const { [panel]: _gone, ...rest } = this.#layout;
      this.#layout = rest;
      saveLayout(this.#profileId, this.#layout);
      if (window !== undefined && !window.isDestroyed()) {
        const panels = this.panels;
        const home = defaultPosition(panels, Math.max(0, panels.indexOf(panel)));
        const design = this.#designOf(panel);
        window.setBounds({ x: home.x, y: home.y, width: design[0], height: design[1] });
      }
      return;
    }
    const design = this.#designOf(panel);
    const width = Math.max(40, Math.round(bounds.width));
    const target = { x: Math.round(bounds.x), y: Math.round(bounds.y), width, height: Math.round((width * design[1]) / design[0]) };
    this.#layout = { ...this.#layout, [panel]: target };
    saveLayout(this.#profileId, this.#layout);
    if (window !== undefined && !window.isDestroyed()) {
      window.setBounds(target);
      this.mirrorFrom(panel);
    }
  }

  /**
   * The one way into the app from an overlay: there is no menu bar and no
   * taskbar entry (§7), so right-click is the only thing to try when the
   * control window has gone missing behind the sim or into the tray.
   */
  #showContextMenu(window: BrowserWindow): void {
    Menu.buildFromTemplate([
      { label: "Show Exxeed", click: () => this.#onShowMainWindow() },
      { type: "separator" },
      { label: "Hide This Overlay", click: () => window.hide() },
      { label: "Close All Overlays", click: () => this.setVisible(false) },
    ]).popup({ window });
  }

  /**
   * Close every window this layout owns, without touching anything else, and
   * resolve once they are actually gone.
   *
   * For switching profiles: the caller builds a fresh `OverlayLayout` for
   * whichever profile is now active and creates its windows, so this only has
   * to tear down the old set — but it has to finish first. `globalShortcut` is
   * OS-level state shared by every `OverlayLayout`, and the old instance
   * releasing it (§ `#releaseShortcut`, which fires once its last window closes)
   * AFTER a new instance has already re-registered it for the incoming profile
   * would silently kill the shortcut for windows that are not this layout's to
   * touch. Awaiting `closed` for every window, not just sending `close()`, is
   * what keeps the two layouts from interleaving.
   */
  destroy(): Promise<void> {
    const windows = [...this.#windows.values()].filter((w) => !w.isDestroyed());
    if (windows.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      let remaining = windows.length;
      for (const window of windows) {
        window.once("closed", () => {
          remaining -= 1;
          if (remaining === 0) resolve();
        });
        window.close();
      }
    });
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
