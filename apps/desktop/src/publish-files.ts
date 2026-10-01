/**
 * Files going out with the next version of a pack: setups and iRacing lap
 * files — TODO.md M8 step 6.
 *
 * The list starts as the latest version's files, so a v4 that only moves a
 * braking point still carries v3's setups, and the author adds, removes and
 * relabels from there. New files are held here in memory, read and checked,
 * and uploaded when the version is published — not before, because a first
 * publish has no item to upload into until it is created.
 */

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

import { BrowserWindow, dialog, type WebContents } from "electron";

import { carIdFromPath, readLapFileHeader } from "@exxeed/core";
import type { PublishFile } from "@exxeed/overlays";
import {
  listVersionFiles,
  MAX_PACK_FILE_BYTES,
  sha256Hex,
  uploadPackFile,
  type CloudClient,
  type PackFile,
  type PackFileKind,
} from "@exxeed/repo";

/** One entry in the list: either carried from the last version, or new and still local. */
interface Attachment {
  readonly key: string;
  readonly kind: PackFileKind;
  label: string;
  readonly name: string;
  readonly carId: string | null;
  readonly detail: string | null;
  /** Carried from the latest version: already uploaded. */
  readonly published: PackFile | null;
  /** Added since: the bytes, uploaded on publish. */
  readonly local: Uint8Array | null;
  readonly sha256: string;
  readonly size: number;
}

/** Per note set: the version the list started from, its files, and the list now. */
const lists = new Map<string, { fromVersionId: string | null; carried: readonly PackFile[]; files: Attachment[] }>();

const KIND_BY_EXTENSION: Record<string, PackFileKind> = { ".sto": "setup", ".blap": "blap", ".olap": "olap" };

const fmtLap = (s: number): string => `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, "0")}`;

/** The attachment list for a note set, started from its latest version's files. */
export async function attachments(client: CloudClient, noteSetId: string, latestVersionId: string | null): Promise<Attachment[]> {
  const existing = lists.get(noteSetId);
  if (existing !== undefined && existing.fromVersionId === latestVersionId) return existing.files;

  const carried = latestVersionId === null ? [] : await listVersionFiles(client, latestVersionId);
  const files: Attachment[] = carried.map((f) => ({
    key: f.sha256,
    kind: f.kind,
    label: f.label,
    name: f.label,
    carId: f.carId,
    detail: null,
    published: f,
    local: null,
    sha256: f.sha256,
    size: f.bytes,
  }));
  lists.set(noteSetId, { fromVersionId: latestVersionId, carried, files });
  return files;
}

export const toView = (files: readonly Attachment[]): PublishFile[] =>
  files.map((f) => ({
    key: f.key,
    kind: f.kind,
    label: f.label,
    name: f.name,
    bytes: f.size,
    detail: f.detail,
    isNew: f.local !== null,
  }));

/** Do the files differ from the version the list started from — added, removed or relabelled? */
export function filesChanged(noteSetId: string): boolean {
  const list = lists.get(noteSetId);
  if (list === undefined) return false;
  const now = list.files.map((f) => `${f.sha256}:${f.label}`).sort().join("|");
  const before = list.carried.map((f) => `${f.sha256}:${f.label}`).sort().join("|");
  return now !== before;
}

/**
 * Pick files and add them. A setup's car is the pack's (`defaultCarId`); a
 * lap file says its own car, and its header gives a better label than the file
 * name: the driver and the lap time.
 */
export async function addFiles(sender: WebContents, noteSetId: string, defaultCarId: string | null): Promise<void> {
  const list = lists.get(noteSetId);
  if (list === undefined) throw new Error("open the publish dialog again");

  const window = BrowserWindow.fromWebContents(sender);
  const options = {
    title: "Attach setups or lap files",
    properties: ["openFile" as const, "multiSelections" as const],
    filters: [{ name: "iRacing setups and lap files", extensions: ["sto", "blap", "olap"] }],
  };
  const picked = window === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(window, options);
  if (picked.canceled) return;

  for (const path of picked.filePaths) {
    const kind = KIND_BY_EXTENSION[extname(path).toLowerCase()];
    if (kind === undefined) throw new Error(`${basename(path)} is not a setup (.sto) or lap file (.blap, .olap)`);
    const bytes = new Uint8Array(await readFile(path));
    if (bytes.byteLength === 0) throw new Error(`${basename(path)} is empty`);
    if (bytes.byteLength > MAX_PACK_FILE_BYTES) throw new Error(`${basename(path)} is too large to be a setup or lap file`);

    let label = basename(path, extname(path));
    let detail: string | null = null;
    let carId = defaultCarId;
    if (kind !== "setup") {
      const header = readLapFileHeader(bytes);
      if (header === null) throw new Error(`${basename(path)} does not look like an iRacing lap file`);
      detail = `${header.driver}${header.lapTimeS === null ? "" : ` · ${fmtLap(header.lapTimeS)}`}`;
      label = `${kind === "blap" ? "Best lap" : "Optimal lap"} · ${detail}`;
      carId = carIdFromPath(header.carPath);
    }

    const sha256 = sha256Hex(bytes);
    if (list.files.some((f) => f.sha256 === sha256)) continue; // already attached
    list.files.push({ key: sha256, kind, label: label.slice(0, 60), name: basename(path), carId, detail, published: null, local: bytes, sha256, size: bytes.byteLength });
  }
  if (list.files.length > 20) {
    list.files.splice(20);
    throw new Error("a version carries at most 20 files");
  }
}

export function removeFile(noteSetId: string, key: string): void {
  const list = lists.get(noteSetId);
  if (list !== undefined) list.files = list.files.filter((f) => f.key !== key);
}

export function setFileLabel(noteSetId: string, key: string, label: string): void {
  const trimmed = label.trim();
  if (trimmed.length < 1 || trimmed.length > 60) throw new Error("a file's label is 1 to 60 characters");
  const file = lists.get(noteSetId)?.files.find((f) => f.key === key);
  if (file !== undefined) file.label = trimmed;
}

export const hasNewFiles = (noteSetId: string): boolean => (lists.get(noteSetId)?.files ?? []).some((f) => f.local !== null);

/** Upload what is new, and return the full list as the version will record it. */
export async function uploadForVersion(client: CloudClient, noteSetId: string, itemId: string): Promise<PackFile[]> {
  const files = lists.get(noteSetId)?.files ?? [];
  const out: PackFile[] = [];
  for (const f of files) {
    const stored = f.published ?? { ...(await uploadPackFile(client, itemId, f.kind, f.local!)), kind: f.kind, label: f.label, carId: f.carId };
    out.push({ ...stored, label: f.label });
  }
  return out;
}

/** After publishing, the list starts again from the new version. */
export function forget(noteSetId: string): void {
  lists.delete(noteSetId);
}
