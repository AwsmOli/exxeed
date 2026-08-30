/**
 * Local-file repositories — SPEC.md §8.
 *
 * v1 is local-first: everything lives under /data, no server, no accounts. The
 * paths mirror the Supabase key structure in §8.1 so that when the Supabase
 * implementations land they wrap these as a write-through disk cache rather than
 * replacing them. Offline with a previously-driven track has to keep working —
 * that isn't a nice-to-have, it's someone in the middle of a race.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  AudioPack,
  LandmarkInventory,
  NoteSet,
  NoteSetSummary,
  ReferenceLap,
  TrackKey,
  TrackMap,
  TrackRef,
} from "@exxeed/core";
import {
  AudioPackSchema,
  LandmarkInventorySchema,
  NoteSetSchema,
  ReferenceLapSchema,
  TrackMapSchema,
  summariseNoteSet,
  trackKeyEquals,
} from "@exxeed/core";

import type {
  AudioRepository,
  LandmarkRepository,
  NoteSetRepository,
  Repositories,
  ReferenceLapRepository,
  TrackMapRepository,
  TrackSummary,
} from "./interfaces.js";

const readJson = async (path: string): Promise<unknown | null> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
};

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

/**
 * Subdirectory names only.
 *
 * Walking a tree with plain readdir and recursing into every entry falls over on
 * the first stray file — `data/tracks/.gitkeep` is committed, so that is not a
 * hypothetical — and ENOTDIR is not something the ENOENT guard below catches.
 */
const listDirs = async (path: string): Promise<string[]> => {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
};

const listDir = async (path: string): Promise<string[]> => {
  try {
    return await readdir(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
};

/** data/tracks/{sim}/{trackId}/{configId}/v{mapVersion}/ */
const trackDir = (root: string, ref: TrackRef): string =>
  join(root, "tracks", ref.sim, String(ref.trackId), ref.configId, `v${ref.mapVersion}`);

/** data/tracks/{sim}/{trackId}/{configId}/ — all cut versions of one layout. */
const layoutDir = (root: string, key: TrackKey): string =>
  join(root, "tracks", key.sim, String(key.trackId), key.configId);

export class LocalFileTrackMapRepository implements TrackMapRepository {
  constructor(private readonly root: string) {}

  async get(ref: TrackRef): Promise<TrackMap | null> {
    const raw = await readJson(join(trackDir(this.root, ref), "map.json"));
    return raw === null ? null : TrackMapSchema.parse(raw);
  }

  async latestVersion(key: TrackKey): Promise<number | null> {
    const versions = (await listDir(layoutDir(this.root, key)))
      .filter((name) => /^v\d+$/.test(name))
      .map((name) => Number(name.slice(1)));
    return versions.length === 0 ? null : Math.max(...versions);
  }

  /**
   * Walk data/tracks/{sim}/{trackId}/{configId}/v{n}/ and read the newest map in
   * each layout. Small and rare enough to do plainly: a handful of tracks, read
   * only when the picker is refreshed.
   */
  async listTracks(): Promise<TrackSummary[]> {
    const root = join(this.root, "tracks");
    const out: TrackSummary[] = [];

    for (const sim of await listDirs(root)) {
      for (const trackId of await listDirs(join(root, sim))) {
        for (const configId of await listDirs(join(root, sim, trackId))) {
          const key: TrackKey = { sim: "iracing", trackId: Number(trackId), configId };
          if (!Number.isFinite(key.trackId)) continue;

          const version = await this.latestVersion(key);
          if (version === null) continue;

          const map = await this.get({ ...key, mapVersion: version });
          if (map === null) continue;

          out.push({
            key,
            mapVersion: version,
            trackName: map.trackName,
            configName: map.configName,
            cornerCount: map.corners.length,
          });
        }
      }
    }

    return out.sort((a, b) => a.trackName.localeCompare(b.trackName));
  }

  async put(map: TrackMap): Promise<void> {
    await writeJson(join(trackDir(this.root, map.trackRef), "map.json"), TrackMapSchema.parse(map));
  }
}

export class LocalFileLandmarkRepository implements LandmarkRepository {
  constructor(private readonly root: string) {}

  async get(ref: TrackRef): Promise<LandmarkInventory | null> {
    const raw = await readJson(join(trackDir(this.root, ref), "landmarks.json"));
    return raw === null ? null : LandmarkInventorySchema.parse(raw);
  }

  async put(inventory: LandmarkInventory): Promise<void> {
    await writeJson(
      join(trackDir(this.root, inventory.trackRef), "landmarks.json"),
      LandmarkInventorySchema.parse(inventory),
    );
  }
}

export class LocalFileReferenceLapRepository implements ReferenceLapRepository {
  constructor(private readonly root: string) {}

  /** data/reflaps/{sim}/{trackId}/{configId}/{carId}.json — no version segment,
   *  deliberately. A recorded lap survives every re-cut of the track map. */
  #path(key: TrackKey, carId: number): string {
    return join(this.root, "reflaps", key.sim, String(key.trackId), key.configId, `${carId}.json`);
  }

  async get(key: TrackKey, carId: number): Promise<ReferenceLap | null> {
    const raw = await readJson(this.#path(key, carId));
    return raw === null ? null : ReferenceLapSchema.parse(raw);
  }

  async listCars(key: TrackKey): Promise<number[]> {
    const dir = join(this.root, "reflaps", key.sim, String(key.trackId), key.configId);
    return (await listDir(dir))
      .filter((name) => /^\d+\.json$/.test(name))
      .map((name) => Number(name.replace(/\.json$/, "")))
      .sort((a, b) => a - b);
  }

  async put(lap: ReferenceLap): Promise<void> {
    await writeJson(this.#path(lap.trackKey, lap.carId), ReferenceLapSchema.parse(lap));
  }
}

export class LocalFileNoteSetRepository implements NoteSetRepository {
  constructor(private readonly root: string) {}

  #dir(): string {
    return join(this.root, "notesets");
  }

  async get(id: string): Promise<NoteSet | null> {
    const raw = await readJson(join(this.#dir(), `${id}.json`));
    return raw === null ? null : NoteSetSchema.parse(raw);
  }

  async listAll(): Promise<NoteSetSummary[]> {
    const files = (await listDir(this.#dir())).filter((f) => f.endsWith(".json"));
    const summaries: NoteSetSummary[] = [];

    for (const file of files) {
      const raw = await readJson(join(this.#dir(), file));
      if (raw === null) continue;
      // A note set that fails to parse should not hide the ones that do — a
      // picker showing four of five is more useful than an error page.
      const parsed = NoteSetSchema.safeParse(raw);
      if (parsed.success) summaries.push(summariseNoteSet(parsed.data));
    }

    return summaries.sort((a, b) => a.id.localeCompare(b.id));
  }

  async listForTrack(key: TrackKey, carClass?: string): Promise<NoteSetSummary[]> {
    const files = (await listDir(this.#dir())).filter((f) => f.endsWith(".json"));
    const summaries: NoteSetSummary[] = [];

    for (const file of files) {
      const raw = await readJson(join(this.#dir(), file));
      if (raw === null) continue;
      const set = NoteSetSchema.parse(raw);
      // Match on TrackKey. A note set holds lap positions, not corner indices, so
      // it survives every re-cut of the track map (§4.0, §4.4).
      if (!trackKeyEquals(set.trackKey, key)) continue;
      if (carClass !== undefined && set.carClass !== carClass) continue;
      summaries.push(summariseNoteSet(set));
    }

    return summaries.sort((a, b) => a.id.localeCompare(b.id));
  }

  async put(set: NoteSet): Promise<void> {
    await writeJson(join(this.#dir(), `${set.id}.json`), NoteSetSchema.parse(set));
  }
}

export class LocalFileAudioRepository implements AudioRepository {
  constructor(private readonly root: string) {}

  /** data/audio/{noteSetId}/{voiceId}/pack.json, mirroring §8.1's Storage layout. */
  #packPath(noteSetId: string, voiceId: string): string {
    return join(this.root, "audio", noteSetId, voiceId, "pack.json");
  }

  async listVoices(noteSetId: string): Promise<string[]> {
    return (await listDir(join(this.root, "audio", noteSetId))).sort();
  }

  async getPack(noteSetId: string, voiceId: string): Promise<AudioPack | null> {
    const raw = await readJson(this.#packPath(noteSetId, voiceId));
    return raw === null ? null : AudioPackSchema.parse(raw);
  }

  async readFile(pack: AudioPack, noteId: string): Promise<Uint8Array | null> {
    const entry = pack.files[noteId];
    if (entry === undefined) return null;
    try {
      return await readFile(join(this.root, "audio", entry.path));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async putClip(
    noteSetId: string,
    voiceId: string,
    key: string,
    bytes: Uint8Array,
  ): Promise<string> {
    const relative = `${noteSetId}/${voiceId}/${key}.wav`;
    const absolute = join(this.root, "audio", relative);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes);
    return relative;
  }

  async putPack(pack: AudioPack): Promise<void> {
    await writeJson(this.#packPath(pack.noteSetId, pack.voiceId), AudioPackSchema.parse(pack));
  }
}

/** Wire the whole local set at once. `root` is the /data directory. */
export const localRepositories = (root: string): Repositories => ({
  trackMaps: new LocalFileTrackMapRepository(root),
  landmarks: new LocalFileLandmarkRepository(root),
  referenceLaps: new LocalFileReferenceLapRepository(root),
  noteSets: new LocalFileNoteSetRepository(root),
  audio: new LocalFileAudioRepository(root),
});
