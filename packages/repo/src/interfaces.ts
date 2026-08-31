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
  CarRegistry,
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
  /** Keyed by TrackKey + the sim's car slug. No mapVersion — see the note above. */
  get(key: TrackKey, carId: string): Promise<ReferenceLap | null>;
  /**
   * Which cars have a reference lap for this track, as the sim's own slugs.
   *
   * A NoteSet names a track and a car *class*, not a car id (§4.4). The car
   * registry bridges the two: slug to class, so a note set can be checked
   * against the car actually being driven.
   */
  listCars(key: TrackKey): Promise<string[]>;
  put(lap: ReferenceLap): Promise<void>;
}

export interface NoteSetRepository {
  /** Keyed by TrackKey: a note set holds lap positions, not corner indices. */
  listForTrack(key: TrackKey, carClass?: string): Promise<NoteSetSummary[]>;
  /** Every note set on disk, for a picker that has no track chosen yet. */
  listAll(): Promise<NoteSetSummary[]>;
  get(id: string): Promise<NoteSet | null>;
  put(set: NoteSet): Promise<void>;
}

export interface AudioRepository {
  getPack(noteSetId: string, voiceId: string): Promise<AudioPack | null>;
  /** Which voices a note set has been rendered in. */
  listVoices(noteSetId: string): Promise<string[]>;
  /**
   * Raw WAV bytes. Every file for the loaded track is read into memory at session
   * start; nothing touches disk at trigger time (SPEC.md §4.5).
   */
  readFile(pack: AudioPack, noteId: string): Promise<Uint8Array | null>;
  /**
   * Write one rendered clip and return the pack-relative path to record for it.
   * Here rather than in the renderer because §8 is absolute: nothing outside
   * packages/repo touches the filesystem for these artefacts.
   */
  putClip(noteSetId: string, voiceId: string, key: string, bytes: Uint8Array): Promise<string>;
  putPack(pack: AudioPack): Promise<void>;
}

/** Everything the runtime needs, in one place, so wiring is a single object. */
/**
 * The slug-to-class table (§13 Q2). One per sim, and small — it is read once at
 * session start alongside everything else, never on the trigger path.
 */
export interface CarRegistryRepository {
  /** Null when no registry exists for this sim yet. Not an error: an unknown car
   *  loses the class check and nothing more. */
  get(sim: string): Promise<CarRegistry | null>;
}

export interface Repositories {
  readonly trackMaps: TrackMapRepository;
  readonly landmarks: LandmarkRepository;
  readonly referenceLaps: ReferenceLapRepository;
  readonly noteSets: NoteSetRepository;
  readonly audio: AudioRepository;
  readonly cars: CarRegistryRepository;
}
