/**
 * Where the app keeps things, running from source or installed.
 *
 * From source, everything lives under the repo's data/ folder, as it always
 * has: voices, Piper, downloaded tools and recordings sit beside the note sets
 * a developer is working on. Installed, the program's own folder is read-only
 * (Program Files), so everything the app writes goes under the user's
 * application data instead — %APPDATA%\Exxeed on Windows — and only what ships
 * with the app is read from its resources.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { app } from "electron";

/**
 * The repository root, when running from source. fileURLToPath leaves a
 * trailing separator on a directory URL, which every use would then double.
 */
export const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url)).replace(/[\\/]+$/, "");

/**
 * The root everything written lives under: the repo from source, the user's
 * application data when installed. By appData + name rather than userData, so
 * it does not depend on app.setName having run before this module is loaded.
 */
export const WRITABLE_ROOT = app.isPackaged ? join(app.getPath("appData"), "Exxeed") : REPO_ROOT;

/** Files that ship with the app and are only read: its resources when installed. */
export const RESOURCES_ROOT = app.isPackaged ? process.resourcesPath : REPO_ROOT;

/** A folder under data/ in the writable root. */
export const dataPath = (...parts: string[]): string => join(WRITABLE_ROOT, "data", ...parts);
