/**
 * Installing a pack's setups into iRacing — TODO.md M8 step 6.
 *
 * iRacing keeps setups in `Documents/iRacing/setups/<car folder>/`, and lists
 * subfolders in the garage. A pack's setups go in a subfolder of their own,
 * `Exxeed - <pack title>`, so they sit beside the driver's own and never
 * overwrite one. That subfolder is the app's: it is replaced on update and
 * removed on uninstall, and nothing outside it is ever touched.
 *
 * Which folder is the car's is found, not guessed: the existing folder whose
 * name slugs to the car id (`mx5-mx52016`). The exact naming is to verify on the
 * rig; a car whose folder is not found is reported, and the driver can still
 * use Save files… on the pack's page.
 *
 * Lap files are not installed here. The sim reads one under a fixed name per
 * car and track, so installing one means replacing the driver's own — that
 * waits for "use as my delta reference" with a backup (TODO M8 step 6).
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { app } from "electron";

import { downloadPackFile, listVersionFiles, type CloudClient } from "@exxeed/repo";
import { slug } from "@exxeed/telemetry";

/** `Documents/iRacing/setups`, or null where there is no iRacing (macOS, or not installed). */
function setupsRoot(): string | null {
  if (process.platform !== "win32") return null;
  const root = join(app.getPath("documents"), "iRacing", "setups");
  return existsSync(root) ? root : null;
}

/** A title or label as a folder or file name Windows accepts. */
const safeName = (text: string): string =>
  text.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "pack";

const packFolder = (title: string): string => `Exxeed - ${safeName(title)}`;

async function carFolders(root: string): Promise<Map<string, string>> {
  const entries = await readdir(root, { withFileTypes: true });
  return new Map(entries.filter((e) => e.isDirectory()).map((e) => [slug(e.name), e.name]));
}

/**
 * Put a version's setups into the sim's folders. Returns a line for the
 * install message, or null when the version has no setups or there is no
 * iRacing folder on this machine.
 */
export async function installSetups(client: CloudClient, versionId: string, packTitle: string): Promise<string | null> {
  const root = setupsRoot();
  if (root === null) return null;
  const setups = (await listVersionFiles(client, versionId)).filter((f) => f.kind === "setup");
  if (setups.length === 0) return null;

  const folders = await carFolders(root);
  const placed: string[] = [];
  const missing = new Set<string>();
  const cleaned = new Set<string>();
  for (const file of setups) {
    const car = file.carId === null ? undefined : folders.get(file.carId);
    if (car === undefined) {
      missing.add(file.carId ?? "an unknown car");
      continue;
    }
    const dir = join(root, car, packFolder(packTitle));
    // Replaced whole on each install, so a setup dropped in v4 does not linger.
    if (!cleaned.has(dir)) {
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      cleaned.add(dir);
    }
    await writeFile(join(dir, `${safeName(file.label)}.sto`), await downloadPackFile(client, file));
    placed.push(file.label);
  }

  const parts: string[] = [];
  if (placed.length > 0) parts.push(`${placed.length} setup${placed.length === 1 ? "" : "s"} in the garage under "${packFolder(packTitle)}"`);
  if (missing.size > 0) parts.push(`no iRacing setups folder found for ${[...missing].join(", ")} — use Save files… on the pack's page`);
  return parts.join("; ");
}

/** Remove a pack's setup folders, from every car. Only ever the app's own folder. */
export async function removeSetups(packTitle: string): Promise<void> {
  const root = setupsRoot();
  if (root === null) return;
  for (const car of (await carFolders(root)).values()) {
    await rm(join(root, car, packFolder(packTitle)), { recursive: true, force: true });
  }
}
