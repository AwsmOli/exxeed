/**
 * Repository interfaces — SPEC.md §8.
 *
 * "Local now, HTTP later, without rewriting callers. Nothing outside
 * packages/repo may touch the filesystem or the network for these artefacts."
 *
 * Content is addressed by the same keys Supabase will use (§8.1), so swapping
 * LocalFile* for Supabase* is a DI change and nothing else.
 *
 * Watch the key types. `ReferenceLapRepository` is keyed by TrackKey, NOT
 * TrackRef — re-cutting a track map bumps mapVersion and must not invalidate
 * laps you already drove. Everything holding corner indices takes a TrackRef.
 * That asymmetry is the entire point of §4.0 and is easy to get wrong later.
 */

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

export interface TrackMapRepository {
  get(ref: TrackRef): Promise<TrackMap | null>;
  /** Latest map version for a physical track, or null if none is cut yet. */
  latestVersion(key: TrackKey): Promise<number | null>;
  put(map: TrackMap): Promise<void>;
}

export interface LandmarkRepository {
  get(ref: TrackRef): Promise<LandmarkInventory | null>;
  put(inventory: LandmarkInventory): Promise<void>;
}

export interface ReferenceLapRepository {
  /** Keyed by TrackKey + carId. No mapVersion — see the note above. */
  get(key: TrackKey, carId: number): Promise<ReferenceLap | null>;
  put(lap: ReferenceLap): Promise<void>;
}

export interface NoteSetRepository {
  /** Keyed by TrackKey: a note set holds lap positions, not corner indices. */
  listForTrack(key: TrackKey, carClass?: string): Promise<NoteSetSummary[]>;
  get(id: string): Promise<NoteSet | null>;
  put(set: NoteSet): Promise<void>;
}

export interface AudioRepository {
  getPack(noteSetId: string, voiceId: string): Promise<AudioPack | null>;
  /**
   * Raw WAV bytes. Every file for the loaded track is read into memory at session
   * start; nothing touches disk at trigger time (SPEC.md §4.5).
   */
  readFile(pack: AudioPack, noteId: string): Promise<Uint8Array | null>;
  putPack(pack: AudioPack): Promise<void>;
}

/** Everything the runtime needs, in one place, so wiring is a single object. */
export interface Repositories {
  readonly trackMaps: TrackMapRepository;
  readonly landmarks: LandmarkRepository;
  readonly referenceLaps: ReferenceLapRepository;
  readonly noteSets: NoteSetRepository;
  readonly audio: AudioRepository;
}
