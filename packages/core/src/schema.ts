/**
 * Artefact schemas — SPEC.md §4.
 *
 * These are the on-disk (and later, Supabase `jsonb`) shapes. They are validated
 * at the repository boundary, never re-validated in the hot path: the runtime is
 * deliberately stupid (§1) and does no work at 60 Hz that could have been done at
 * load time.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Keys (§4.0)
// ---------------------------------------------------------------------------

export const SimSchema = z.literal("iracing");

export const TrackKeySchema = z.object({
  sim: SimSchema,
  trackId: z.number().int().nonnegative(),
  configId: z.string().min(1),
});

export const TrackRefSchema = TrackKeySchema.extend({
  mapVersion: z.number().int().nonnegative(),
});

/** Lap position. 0..1, not 0..100 — see SPEC.md §3. */
const PctValue = z.number().min(0).max(1);

// ---------------------------------------------------------------------------
// TrackMap (§4.1)
// ---------------------------------------------------------------------------

export const CornerSchema = z.object({
  index: z.number().int().positive(),
  /** Aliases the ingest LLM may match against, e.g. ["La Source"]. */
  names: z.array(z.string()).default([]),
  entryPct: PctValue,
  apexPct: PctValue,
  exitPct: PctValue,
  direction: z.enum(["left", "right"]),
  /** 1 (flat kink) … 6 (hairpin). */
  severity: z.number().int().min(1).max(6),
});

/**
 * 2D centreline on the same pct grid as ReferenceLap. Metres, arbitrary origin,
 * derived from Lat/Lon by equirectangular projection about the track's mean
 * latitude (§4.1.1). Required — without it there is nothing to draw the note
 * editor's map from (§7.4).
 */
export const CentrelineSchema = z
  .object({
    gridSize: z.number().int().positive(),
    x: z.array(z.number()),
    y: z.array(z.number()),
  })
  .refine((c) => c.x.length === c.gridSize && c.y.length === c.gridSize, {
    message: "centreline x/y must both have exactly gridSize samples",
  });

export const TrackMapSchema = z.object({
  schema: z.literal(1),
  trackRef: TrackRefSchema,
  trackName: z.string().min(1),
  configName: z.string(),
  lengthM: z.number().positive(),
  generatedFrom: z.object({
    source: z.enum(["telemetry", "ibt", "manual"]),
    /** apexPct is mildly car-dependent, so record which car it came from (§4.1). */
    baselineCarId: z.number().int().nonnegative(),
    lapHash: z.string(),
  }),
  corners: z.array(CornerSchema),
  centreline: CentrelineSchema,
});

// ---------------------------------------------------------------------------
// LandmarkInventory (§4.2)
// ---------------------------------------------------------------------------

export const LANDMARK_TYPES = [
  "distance_board",
  "bridge",
  "marshal_post",
  "kerb",
  "surface_change",
  "sign",
  "building",
  "treeline",
  "gantry",
] as const;

export const LandmarkSchema = z.object({
  id: z.string().min(1),
  cornerIndex: z.number().int().positive(),
  type: z.enum(LANDMARK_TYPES),
  /** What the voice actually says, e.g. "hundred board". */
  label: z.string().min(1),
  /**
   * Landmarks routinely wrap past start/finish — Spa's 100 board for turn 1 sits
   * at 0.99781. Never compare these with raw subtraction (§4.6).
   */
  pct: PctValue,
  confidence: z.number().min(0).max(1),
  verified: z.boolean(),
});

export const LandmarkInventorySchema = z.object({
  trackRef: TrackRefSchema,
  landmarks: z.array(LandmarkSchema),
});

// ---------------------------------------------------------------------------
// ReferenceLap (§4.3)
// ---------------------------------------------------------------------------

export const PerCornerSchema = z.object({
  /** Null when the car did not brake for this corner at all. */
  brakeOnsetPct: PctValue.nullable(),
  throttleOnPct: PctValue.nullable(),
  minSpeedMps: z.number().nonnegative(),
});

export const ReferenceLapSchema = z.object({
  /** TrackKey, NOT TrackRef — re-cutting the map must not invalidate this (§4.0). */
  trackKey: TrackKeySchema,
  carId: z.number().int().nonnegative(),
  lapTimeS: z.number().positive(),
  /** Samples evenly spaced in pct, so comparison is array indexing with no time
   *  alignment. The single most useful decision in the data model (§4.3). */
  gridSize: z.number().int().positive(),
  channels: z.object({
    speedMps: z.array(z.number()),
    throttle: z.array(z.number()),
    brake: z.array(z.number()),
    gear: z.array(z.number()),
    steerRad: z.array(z.number()),
    /** Elapsed lap time at each pct — this is what makes the delta bar a single
     *  array lookup (§7.2). */
    elapsedS: z.array(z.number()),
  }),
  /** perCorner depends on corner numbering, so record what it was cut against
   *  and recompute when stale. */
  derivedForMapVersion: z.number().int().nonnegative(),
  perCorner: z.record(z.string(), PerCornerSchema),
  /**
   * Set when the brake channel was inferred from longitudinal deceleration
   * rather than measured — the .blap fallback in §13.3.1. Downstream code that
   * cares about braking precision should know.
   */
  brakeChannelInferred: z.boolean().default(false),
});

// ---------------------------------------------------------------------------
// NoteSet (§4.4)
// ---------------------------------------------------------------------------

export const AudioVariantSchema = z.object({
  file: z.string().min(1),
  /** Measured, never estimated (§10, §12). This is an input to the trigger, so a
   *  wrong duration is a mistimed callout, not just a cosmetic error. */
  durationMs: z.number().positive(),
});

/**
 * A note is a point on the track and something to say there.
 *
 * That is the whole model. There is no phase taxonomy and no corner association:
 * the engine does not need to know whether a message is about braking, throttle,
 * a bump, or where the pit entry is. It knows where and it knows the words.
 *
 * Two consequences worth stating, because they read as losses and are not:
 *
 *  - **Merging beats splitting.** If the throttle application at a corner is
 *    worth mentioning, it belongs in that corner's message, not in a second
 *    callout. One point, one message. The input traces (§7.1) carry the detail a
 *    driver wants to check afterwards; the voice carries what they need now.
 *  - **`pct` is the most stable anchor available**, not the least. A lap position
 *    is a physical property of the tarmac; corner numbering is a derived artefact
 *    that a `corners.override.json` can renumber (§5.2). Anchoring to the derived
 *    thing is what would be fragile.
 */
export const NoteSchema = z.object({
  id: z.string().min(1),
  /** Where on the lap this is relevant, 0..1. The event the callout aims at. */
  pct: z.number().min(0).max(1),
  text: z.string().min(1),
  /** Short form, for when the full one no longer fits before `pct` (§6.3). */
  textShort: z.string().min(1),
  /** 1 = highest. */
  priority: z.number().int().min(1),
  /** The AUTHOR's timing fix for this note, shipped inside the note set for
   *  everyone. Distinct from profile.leadAdjustS, which is one driver's
   *  preference and never leaves their machine (§6.1). */
  leadAdjustS: z.number().default(0),
  /** Ingest metadata (§10). Absent on hand-authored notes. */
  confidence: z.number().min(0).max(1).optional(),
  /** Timestamp in the source video, for the editor's jump-to-source (§7.4). */
  sourceTs: z.string().optional(),
  /** Both variants are required: the scheduler's short-form fallback (§6.3) needs
   *  a real duration to compute lead distance, so both must be rendered. */
  audio: AudioVariantSchema,
  audioShort: AudioVariantSchema,
  /** Text edited since the audio was rendered — stale WAV, therefore mistimed.
   *  A note set must never reach status "published" with a dirty note (§7.4). */
  dirty: z.boolean().default(false),
});

export const NoteSetStatusSchema = z.enum(["draft", "review", "published"]);

export const NoteSetSourceSchema = z.object({
  type: z.enum(["youtube", "manual"]),
  videoId: z.string().optional(),
  url: z.string().url().optional(),
  title: z.string().optional(),
  channel: z.string().optional(),
});

export const NoteSetSchema = z.object({
  id: z.string().min(1),
  /**
   * TrackKey, NOT TrackRef. A note set holds lap positions, not corner indices,
   * so re-cutting the track map cannot invalidate it — the same reasoning §4.0
   * applies to ReferenceLap.
   */
  trackKey: TrackKeySchema,
  /**
   * Track length in metres. Denormalised deliberately: it is the only piece of
   * geometry the runtime needs, it cannot change for a given TrackKey, and
   * carrying it makes a note set self-sufficient. The engine then needs exactly
   * one artefact plus its audio — no TrackMap, no LandmarkInventory. Those are
   * authoring inputs (§5, §10), not runtime ones.
   */
  lengthM: z.number().positive(),
  carClass: z.string().min(1),
  source: NoteSetSourceSchema,
  status: NoteSetStatusSchema,
  createdAt: z.string(),
  notes: z.array(NoteSchema),
});

// ---------------------------------------------------------------------------
// AudioPack (§4.5)
// ---------------------------------------------------------------------------

export const AudioPackSchema = z.object({
  noteSetId: z.string().min(1),
  voiceId: z.string().min(1),
  /** WAV, never MP3 — decode latency at trigger time is unacceptable (§3, §12). */
  format: z.string(),
  files: z.record(
    z.string(),
    z.object({
      path: z.string(),
      durationMs: z.number().positive(),
      bytes: z.number().int().nonnegative(),
    }),
  ),
  totalBytes: z.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type Corner = z.infer<typeof CornerSchema>;
export type Centreline = z.infer<typeof CentrelineSchema>;
export type TrackMap = z.infer<typeof TrackMapSchema>;
export type Landmark = z.infer<typeof LandmarkSchema>;
export type LandmarkInventory = z.infer<typeof LandmarkInventorySchema>;
export type PerCorner = z.infer<typeof PerCornerSchema>;
export type ReferenceLap = z.infer<typeof ReferenceLapSchema>;
export type AudioVariant = z.infer<typeof AudioVariantSchema>;
export type Note = z.infer<typeof NoteSchema>;
export type NoteSetStatus = z.infer<typeof NoteSetStatusSchema>;
export type NoteSetSource = z.infer<typeof NoteSetSourceSchema>;
export type NoteSet = z.infer<typeof NoteSetSchema>;
export type AudioPack = z.infer<typeof AudioPackSchema>;

/** Listing shape for the note-set picker — SPEC.md §4.4. Deliberately does not
 *  carry `notes`, so a picker can list a track's sets without loading them. */
export interface NoteSetSummary {
  id: string;
  trackKey: z.infer<typeof TrackKeySchema>;
  carClass: string;
  title: string;
  channel: string;
  sourceUrl: string;
  noteCount: number;
  status: NoteSetStatus;
  createdAt: string;
}

export const summariseNoteSet = (set: NoteSet): NoteSetSummary => ({
  id: set.id,
  trackKey: set.trackKey,
  carClass: set.carClass,
  title: set.source.title ?? "(untitled)",
  channel: set.source.channel ?? "(unknown)",
  sourceUrl: set.source.url ?? "",
  noteCount: set.notes.length,
  status: set.status,
  createdAt: set.createdAt,
});
