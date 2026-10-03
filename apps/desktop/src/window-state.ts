/**
 * Where each of the app's ordinary windows was, and how big.
 *
 * The control window, the note editor, the importer and preferences each
 * reopen where they were left. Overlays keep their own places per profile
 * (overlay.ts); this is for windows with a frame.
 *
 * A remembered place is only used if it is still on a screen: a window last
 * seen on a monitor that has since been unplugged would otherwise open where
 * nobody can reach it.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { app, screen, type BrowserWindow } from "electron";

interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const statePath = (): string => join(app.getPath("userData"), "window-state.json");

function readAll(): Record<string, Bounds> {
  try {
    const raw: unknown = JSON.parse(readFileSync(statePath(), "utf8"));
    return typeof raw === "object" && raw !== null ? (raw as Record<string, Bounds>) : {};
  } catch {
    return {};
  }
}

const isBounds = (b: unknown): b is Bounds =>
  typeof b === "object" &&
  b !== null &&
  (["x", "y", "width", "height"] as const).every((k) => Number.isFinite((b as Record<string, unknown>)[k]));

/** Enough of the window's title bar on some screen to grab it. */
function reachable(b: Bounds): boolean {
  return screen.getAllDisplays().some(({ workArea: a }) => {
    const overlapX = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x);
    const overlapY = Math.min(b.y + 40, a.y + a.height) - Math.max(b.y, a.y);
    return overlapX >= 120 && overlapY >= 20;
  });
}

/**
 * The size and place to open a window at: where it was left if that is still
 * on a screen, otherwise the given size wherever the system puts it.
 */
export function windowBounds(
  name: string,
  defaults: { width: number; height: number },
): { width: number; height: number; x?: number; y?: number } {
  const saved = readAll()[name];
  if (!isBounds(saved) || saved.width < 200 || saved.height < 150 || !reachable(saved)) return defaults;
  return { x: saved.x, y: saved.y, width: saved.width, height: saved.height };
}

/** Remember a window's place as it is moved, resized and closed. */
export function rememberWindow(name: string, window: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null;
  const save = (): void => {
    if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return;
    // The un-maximised bounds, so a maximised window reopens at its normal size.
    const { x, y, width, height } = window.getNormalBounds();
    try {
      writeFileSync(statePath(), `${JSON.stringify({ ...readAll(), [name]: { x, y, width, height } }, null, 2)}\n`);
    } catch {
      // Not worth more than losing the position.
    }
  };
  const soon = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(save, 400);
  };
  window.on("move", soon);
  window.on("resize", soon);
  window.on("close", () => {
    if (timer !== null) clearTimeout(timer);
    save();
  });
}
