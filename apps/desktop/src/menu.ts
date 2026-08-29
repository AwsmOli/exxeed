/**
 * The application menu.
 *
 * Preferences belongs here because `Cmd/Ctrl+,` is the first thing anyone tries,
 * and because a shortcut printed to stdout is not a discoverable interface.
 *
 * ## Where the menu is actually visible
 *
 * On macOS the menu bar is global, so it is there whichever window has focus —
 * including none of them. On Windows and Linux a menu belongs to a window frame,
 * and every overlay is deliberately frameless (§7), so **in overlay mode there is
 * no visible menu on those platforms**. The global shortcuts are the interface
 * there, which is why they are kept rather than replaced by menu accelerators.
 *
 * ## Accelerators vs global shortcuts
 *
 * Both are registered for the same two actions, and that is deliberate rather
 * than redundant. A menu accelerator only fires while this app has focus, and
 * during a session it never does — the sim does. The global shortcut covers that
 * case; the accelerator makes the binding visible in the menu. They call the same
 * function, so which one wins does not matter.
 */

import { app, Menu, shell, type MenuItemConstructorOptions } from "electron";

export interface MenuActions {
  readonly openPreferences: () => void;
  readonly openEditor: () => void;
  readonly toggleOverlayEdit: () => void;
  readonly overlayMode: boolean;
}

export function buildApplicationMenu(actions: MenuActions): void {
  const isMac = process.platform === "darwin";

  const preferences: MenuItemConstructorOptions = {
    label: "Preferences…",
    accelerator: "CommandOrControl+,",
    click: () => actions.openPreferences(),
  };

  const editNotes: MenuItemConstructorOptions = {
    label: "Edit Notes…",
    accelerator: "CommandOrControl+E",
    click: () => actions.openEditor(),
  };

  const arrange: MenuItemConstructorOptions = {
    label: "Arrange Overlays",
    accelerator: "CommandOrControl+Shift+E",
    // Nothing to arrange in the single-window mode, and an item that silently
    // does nothing is worse than one that is not there.
    enabled: actions.overlayMode,
    click: () => actions.toggleOverlayEdit(),
  };

  const appMenu: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: app.name,
          submenu: [
            { role: "about" },
            { type: "separator" },
            preferences,
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        },
      ]
    : [];

  const fileMenu: MenuItemConstructorOptions = isMac
    ? { label: "File", submenu: [editNotes, { type: "separator" }, { role: "close" }] }
    : {
        label: "File",
        submenu: [editNotes, preferences, { type: "separator" }, { role: "quit" }],
      };

  // Without this, copy and paste do not work in the preferences text fields on
  // macOS — the roles are what wire the system shortcuts to the focused input.
  const editMenu: MenuItemConstructorOptions = {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: "View",
    submenu: [
      arrange,
      { type: "separator" },
      { role: "reload" },
      { role: "toggleDevTools" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  };

  const helpMenu: MenuItemConstructorOptions = {
    label: "Help",
    submenu: [
      {
        label: "Build Spec",
        click: () => {
          void shell.openExternal("https://github.com/AwsmOli/exxeed/blob/main/docs/SPEC.md");
        },
      },
    ],
  };

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([...appMenu, fileMenu, editMenu, viewMenu, helpMenu]),
  );
}
