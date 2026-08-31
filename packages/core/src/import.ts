/**
 * Importing callouts described by turn number — SPEC.md §10.
 *
 * The video half of the pipeline lives in a separate tool. Its whole output is
 * `{ turn, text }`: which corner a callout is about, and what to say. That is
 * the most a transcript can honestly support — a coach says "turn four", never
 * "pct 0.1482" — and it means the helper never needs telemetry and this project
 * never needs to talk to YouTube.
 *
 * Turning a turn number into a lap position is this side's job, and it lands the
 * note at the corner's entry — nothing cleverer.
 *
 * An earlier version reached for the reference lap's measured `brakeOnsetPct`
 * instead, on the reasoning that a callout saying "brake" is about the moment
 * braking starts. That reasoning is the thing this data model deliberately does
 * not have. **A note is a point and a message.** It is not a brake note or a
 * throttle note; it can be a line about an overtaking spot coming up, or about
 * staying in fourth on the limiter up the hill because shifting to fifth is
 * slower. Anchoring on a braking point silently asserts a category the note does
 * not carry, and gets it wrong for every note that is not about braking.
 *
 * So the import places one note per named turn, at the turn, and the author
 * moves it — which is the editor's job (§7.4) and takes a person about a second.
 * A predictable starting point beats a clever one that is right two thirds of
 * the time and wrong without saying so. It also means import needs only a track
 * map: notes can be imported for a track nobody has driven in that car yet.
 *
 * ## The prerequisite that will bite
 *
 * **Our corner numbering has to match the convention coaches use.** A guide says
 * "turn four" meaning the conventional fourth; if detection emits only the
 * corners it happened to find, our indices mean something else and every mapping
 * is silently off by however many were missed. `corners.override.json` (§5.2) is
 * what keeps them aligned, per track, and an import against a track that has not
 * had that done will be quietly wrong rather than loudly broken. Hence
 * `unresolved` below, and hence refusing a turn that is not in the map.
 */

import { z } from "zod";

import { cornerByIndex } from "./map.js";
import { newNoteId } from "./note-id.js";
import type { Note, TrackMap } from "./schema.js";

export const ImportCalloutSchema = z.object({
  /** Conventional turn number, as a coach would say it. */
  turn: z.number().int().positive(),
  /**
   * Last turn of a range, for a callout covering a sequence.
   *
   * Corners close enough together get one callout, not one each (§4.4) — at
   * Daytona the bus stop is "turns 9 to 11" as a single line. Accepted because
   * that is how a helper describes what it found, and because a range is a real
   * thing in a track guide. It does not reach the note: placement is the first
   * turn either way, and the note that comes out is a point like any other.
   */
  throughTurn: z.number().int().positive().optional(),
  text: z.string().min(1),
  /** Omitted, a short form is derived — badly, and flagged for review. */
  textShort: z.string().min(1).optional(),
  priority: z.number().int().min(1).default(1),
  confidence: z.number().min(0).max(1).optional(),
  sourceTs: z.string().optional(),
});

export const ImportProfileSchema = z.object({
  schema: z.literal(1),
  source: z.object({
    type: z.enum(["youtube", "manual"]),
    videoId: z.string().optional(),
    url: z.string().url().optional(),
    title: z.string().optional(),
    channel: z.string().optional(),
  }),
  carClass: z.string().min(1),
  callouts: z.array(ImportCalloutSchema),
});

export type ImportCallout = z.infer<typeof ImportCalloutSchema>;
export type ImportProfile = z.infer<typeof ImportProfileSchema>;

export interface UnresolvedCallout {
  readonly callout: ImportCallout;
  readonly reason: string;
}

export interface ResolvedProfile {
  readonly notes: readonly Note[];
  /** Callouts that could not be placed. Never silently dropped. */
  readonly unresolved: readonly UnresolvedCallout[];
  readonly warnings: readonly string[];
}

/**
 * A placeholder duration, so an imported note is a valid `Note` before anything
 * has been spoken.
 *
 * §12 forbids estimating audio duration, and this does not break that: every
 * imported note is `dirty`, the set is `draft`, and §7.4 refuses to publish a set
 * containing a dirty note. The number exists so the schema is satisfiable between
 * import and render, not so anything can be timed against it. Rendering replaces
 * it with a measured one.
 */
const placeholderMs = (text: string): number => 300 + text.split(/\s+/).length * 320;

/**
 * A short form when the helper gave none.
 *
 * Deliberately crude, and warned about. The short form exists to fit where the
 * full one no longer does, so it wants to be the *useful* half — the Daytona set
 * uses "Long left", not "Turn one" — and picking which half is useful is
 * authoring, not something to infer from the words. The first clause is the least
 * wrong guess for the shape these sentences take; the warning is the real output.
 */
const deriveShort = (text: string): string => {
  const clause = text.split(",")[0]!.trim();
  if (clause !== "" && clause.split(/\s+/).length <= 4) return clause;
  return text.split(/\s+/).slice(0, 3).join(" ").replace(/[,.;:]$/, "");
};

/** Where a callout about this turn starts out. The turn, and the author moves it. */
function positionFor(turn: number, map: TrackMap): number | null {
  return cornerByIndex(map, turn)?.entryPct ?? null;
}

export function resolveProfile(
  profile: ImportProfile,
  map: TrackMap,
  options: { readonly voiceDir?: string } = {},
): ResolvedProfile {
  const notes: Note[] = [];
  const unresolved: UnresolvedCallout[] = [];
  const warnings: string[] = [];

  for (const callout of profile.callouts) {
    if (callout.throughTurn !== undefined && callout.throughTurn < callout.turn) {
      unresolved.push({ callout, reason: "range ends before it begins" });
      continue;
    }

    const placed = positionFor(callout.turn, map);
    if (placed === null) {
      unresolved.push({
        callout,
        reason:
          `no turn ${callout.turn} in this map — check corners.override.json ` +
          `numbers the track the way a coach would`,
      });
      continue;
    }

    const id = newNoteId(new Set(notes.map((n) => n.id)));
    const textShort = callout.textShort ?? deriveShort(callout.text);
    if (callout.textShort === undefined) {
      warnings.push(
        `"${id}" has no short form; guessed "${textShort}". It plays when the full ` +
          `one will not fit, so it wants the useful half, not the first half`,
      );
    }

    const dir = options.voiceDir ?? "imported";
    notes.push({
      id,
      pct: placed,
      text: callout.text,
      textShort,
      priority: callout.priority,
      leadAdjustS: 0,
      ...(callout.confidence === undefined ? {} : { confidence: callout.confidence }),
      ...(callout.sourceTs === undefined ? {} : { sourceTs: callout.sourceTs }),
      audio: { file: `${dir}/${id}.wav`, durationMs: placeholderMs(callout.text) },
      audioShort: { file: `${dir}/${id}_short.wav`, durationMs: placeholderMs(textShort) },
      // Nothing has been spoken yet, so every note is stale by definition.
      dirty: true,
    });
  }

  // Two callouts about the same turn land on the same point and would sit on
  // top of each other. Worth saying: it usually means the helper split a corner
  // the coach treated as one.
  //
  // Counted by position, not by id. Ids used to be derived from the turn, so
  // duplicates showed up as duplicate ids; they are opaque handles now and are
  // unique by construction, which would have made this check silently useless.
  const atPct = new Map<number, string[]>();
  for (const note of notes) atPct.set(note.pct, [...(atPct.get(note.pct) ?? []), note.textShort]);
  for (const [, texts] of atPct) {
    if (texts.length > 1) {
      warnings.push(
        `${texts.length} callouts resolved to the same point — they will collide: ` +
          texts.map((t) => `"${t}"`).join(", "),
      );
    }
  }

  notes.sort((a, b) => a.pct - b.pct);
  return { notes, unresolved, warnings };
}
