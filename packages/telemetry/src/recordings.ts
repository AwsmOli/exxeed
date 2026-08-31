/**
 * The recordings folder — listing it, and taking a file into it.
 *
 * `data/recordings/` is already where a session's own recording lands (§9),
 * grouped `<trackId>/<carId>/<stamp>.ndjson` by main.ts. This makes that folder
 * the *only* way a replay gets chosen: the app walks it, offers what is in it,
 * and importing means copying a file in after checking it will actually replay.
 *
 * The alternative was a text box holding a path, which is worse in the way that
 * matters — a typo, a moved file or a lap recorded on the other machine all fail
 * at session start with no picker to correct them from, and the failure looks
 * exactly like a broken engine.
 */

import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { createInterface } from "node:readline";

import { parseFrame } from "./replay.js";

/** The `kind: "meta"` header the recorder writes as a recording's first line. */
export interface RecordingMeta {
  readonly startedAt?: string;
  readonly source?: string;
  readonly trackId?: string;
  readonly trackName?: string;
  readonly trackConfig?: string;
  readonly carId?: string;
  readonly carName?: string;
  readonly lapTimeS?: number;
  readonly note?: string;
}

export interface RecordingEntry {
  /** Relative to the recordings folder, which is what a setting stores. */
  readonly path: string;
  readonly label: string;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
  readonly meta: RecordingMeta | null;
}

export interface RecordingCheck {
  readonly ok: boolean;
  /** Everything wrong with it, not just the first thing. */
  readonly problems: readonly string[];
  readonly meta: RecordingMeta | null;
  /** Frames actually parsed from the sample, not the file's total. */
  readonly framesSampled: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** Reads a meta line if the first line is one. A recording without one still replays. */
export function parseMeta(line: string | undefined): RecordingMeta | null {
  if (line === undefined || line.trim() === "") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw["kind"] !== "meta") return null;
  return {
    ...(str(raw["startedAt"]) === undefined ? {} : { startedAt: str(raw["startedAt"])! }),
    ...(str(raw["source"]) === undefined ? {} : { source: str(raw["source"])! }),
    ...(str(raw["trackId"]) === undefined ? {} : { trackId: str(raw["trackId"])! }),
    ...(str(raw["trackName"]) === undefined ? {} : { trackName: str(raw["trackName"])! }),
    ...(str(raw["trackConfig"]) === undefined ? {} : { trackConfig: str(raw["trackConfig"])! }),
    ...(str(raw["carId"]) === undefined ? {} : { carId: str(raw["carId"])! }),
    ...(str(raw["carName"]) === undefined ? {} : { carName: str(raw["carName"])! }),
    ...(num(raw["lapTimeS"]) === undefined ? {} : { lapTimeS: num(raw["lapTimeS"])! }),
    ...(str(raw["note"]) === undefined ? {} : { note: str(raw["note"])! }),
  };
}

/**
 * Whether these lines will replay — the whole of what "usable" means, in one
 * pure function so it can be tested without a filesystem.
 *
 * The checks are the ones that separate a recording from a file that merely
 * parses. A stationary car produces perfectly valid frames and replays as a
 * session where nothing ever happens, which is indistinguishable from a broken
 * engine, so movement is checked rather than assumed.
 */
export function inspectRecording(lines: readonly string[]): RecordingCheck {
  const problems: string[] = [];
  const meta = parseMeta(lines[0]);

  const pcts: number[] = [];
  let framesSampled = 0;
  let firstError: string | null = null;

  for (const line of lines) {
    if (line.trim() === "") continue;
    let frame;
    try {
      frame = parseFrame(line);
    } catch (error) {
      firstError ??= error instanceof Error ? error.message : String(error);
      continue;
    }
    if (frame === null) continue;
    framesSampled += 1;
    pcts.push(frame.lapDistPct as unknown as number);
  }

  if (framesSampled === 0) {
    problems.push(
      firstError === null
        ? "no telemetry frames — this is not an Exxeed recording"
        : `no readable telemetry frames (${firstError})`,
    );
  } else if (framesSampled < 2) {
    problems.push("only one frame, so there is nothing to replay");
  }

  if (firstError !== null && framesSampled > 0) {
    problems.push(`some lines are not readable frames (${firstError})`);
  }

  if (pcts.some((p) => p < 0 || p > 1)) {
    problems.push("lapDistPct outside 0..1 — recorded in percent rather than a fraction?");
  }

  // Wraparound-safe: a sample straddling the line is movement, not a jump back.
  const moved = pcts.some((p, i) => i > 0 && Math.abs(p - pcts[i - 1]!) > 1e-6);
  if (framesSampled >= 2 && !moved) {
    problems.push("the car never moves in this sample — a parked or paused recording");
  }

  return { ok: problems.length === 0, problems, meta, framesSampled };
}

/** Reads at most `limit` lines. A recording is hundreds of megabytes; a check is not. */
export async function readHead(path: string, limit = 400): Promise<string[]> {
  const lines: string[] = [];
  const stream = createReadStream(path, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      lines.push(line);
      if (lines.length >= limit) break;
    }
  } finally {
    reader.close();
    stream.destroy();
  }
  return lines;
}

const HUMAN_DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/**
 * What the picker shows. The stamp on its own is unreadable and the folder it
 * sits in already says track and car, so this leads with those and keeps the
 * date as the thing that distinguishes two laps of the same car at the same
 * track — which is the only case where it has to be read closely.
 */
export function describeRecording(entry: {
  path: string;
  meta: RecordingMeta | null;
  modifiedAt: string;
}): string {
  const when = HUMAN_DATE.format(new Date(entry.modifiedAt));
  const meta = entry.meta;
  if (meta?.trackName === undefined) return `${entry.path}  —  ${when}`;

  const config =
    meta.trackConfig === undefined || meta.trackConfig === "" ? "" : ` (${meta.trackConfig})`;
  const car = meta.carName === undefined ? "" : ` — ${meta.carName}`;
  const lap =
    meta.lapTimeS === undefined
      ? ""
      : `  ${Math.floor(meta.lapTimeS / 60)}:${(meta.lapTimeS % 60).toFixed(3).padStart(6, "0")}`;
  return `${meta.trackName}${config}${car}${lap}  —  ${when}`;
}

async function walk(dir: string, root: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // The folder need not exist yet.
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, root, out);
    else if (entry.name.endsWith(".ndjson")) out.push(relative(root, full));
  }
}

/**
 * Everything in the recordings folder, newest first.
 *
 * Recursive because the recorder groups by track and car, so the folder is a
 * tree the moment there is more than one session in it.
 */
export async function listRecordings(recordingsDir: string): Promise<RecordingEntry[]> {
  const paths: string[] = [];
  await walk(recordingsDir, recordingsDir, paths);

  const entries = await Promise.all(
    paths.map(async (path): Promise<RecordingEntry> => {
      const full = join(recordingsDir, path);
      const info = await stat(full);
      const meta = parseMeta((await readHead(full, 1))[0]);
      const modifiedAt = info.mtime.toISOString();
      const normalised = path.split(sep).join("/");
      return {
        path: normalised,
        label: describeRecording({ path: normalised, meta, modifiedAt }),
        sizeBytes: info.size,
        modifiedAt,
        meta,
      };
    }),
  );

  return entries.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

export interface ImportResult {
  readonly ok: boolean;
  readonly check: RecordingCheck;
  /** Relative to the recordings folder. Absent when the check failed. */
  readonly path?: string;
}

/**
 * Take a file into the recordings folder, after checking it will replay.
 *
 * Copies rather than moves: the source is somewhere the person chose it from,
 * and quietly emptying a folder they pointed at is not something an import
 * button should do.
 *
 * The destination mirrors the recorder's own `<trackId>/<carId>/` grouping when
 * the file says what it is, so an imported lap and a driven one sit side by side
 * instead of in two parallel schemes.
 */
export async function importRecording(
  sourcePath: string,
  recordingsDir: string,
): Promise<ImportResult> {
  const check = inspectRecording(await readHead(sourcePath));
  if (!check.ok) return { ok: false, check };

  const meta = check.meta;
  const dir =
    meta?.trackId === undefined
      ? "imported"
      : meta.carId === undefined
        ? meta.trackId
        : join(meta.trackId, meta.carId);

  let name = basename(sourcePath);
  if (!name.endsWith(".ndjson")) name = `${name}.ndjson`;

  await mkdir(join(recordingsDir, dir), { recursive: true });

  // Never overwrite a lap that is already there — two files with the same name
  // from different folders is ordinary, and one of them silently replacing the
  // other is not recoverable.
  let target = join(dir, name);
  for (let n = 2; await exists(join(recordingsDir, target)); n++) {
    target = join(dir, `${name.replace(/\.ndjson$/, "")}-${String(n)}.ndjson`);
  }

  await mkdir(dirname(join(recordingsDir, target)), { recursive: true });
  await copyFile(sourcePath, join(recordingsDir, target));
  return { ok: true, check, path: target.split(sep).join("/") };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
