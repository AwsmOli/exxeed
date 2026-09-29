/**
 * Stage 3 — the transcript in, callouts about *our* corners out (SPEC.md §10).
 *
 * One prompt, used two ways. The importer can send it to a model itself, or
 * hand it to a person to paste into whichever chat they already use and paste
 * the answer back. Keeping it a single piece of text rather than a
 * provider-specific request is what makes the second path possible at all, and
 * it means the reply parser below cannot assume anything a chat window will not
 * reliably do — so it digs the JSON out of prose and code fences rather than
 * expecting a clean body.
 *
 * ## Corners by description, not by number
 *
 * The map's corners are numbered in the order detection found them, which need
 * not be the track's official numbering: a guide's "turn five" and our corner 5
 * can be different corners. The first version of this prompt listed our numbers
 * as "the only valid turns", which quietly trusted them to agree — and fixing
 * that meant a person writing a `corners.override.json` per track.
 *
 * So each corner is described the way a coach experiences it — where it is on
 * the lap, which way, how tight, where the reference lap brakes, how slow and
 * in which gear — and the model matches the coach's words to a description. It
 * also reports the number the coach *said*, which the app keeps
 * (`learnTurnNumbers`), so the track's official numbering is learned from the
 * first guide rather than typed in, and later prompts can show it.
 *
 * The other rules are §10's:
 *
 * - one callout per corner, because three lines a corner is two too many;
 * - rewrite, don't echo, for a consistent voice and a better position on the
 *   content question;
 * - no word cap on `text`, because time is the real constraint and it is
 *   enforced downstream (§6.3, §7.4); `textShort` genuinely short, because it
 *   exists to fit where the full form will not.
 */

import { z } from "zod";

import { ImportProfileSchema, type ImportProfile } from "@exxeed/core";

import { formatTimestamp, parseTimestamp, transcriptText, type TranscriptLine } from "./transcript.js";

export interface PromptCorner {
  /** Our corner number: the map's `index`. What the reply's `corner` names. */
  readonly id: number;
  readonly names: readonly string[];
  readonly direction: "left" | "right";
  /** 1 (flat kink) … 6 (hairpin). */
  readonly severity: number;
  /** Metres from the start/finish line to the turn-in. */
  readonly entryM: number;
  /** The official turn number, when the app has learned it. */
  readonly officialTurn: number | null;
  /** How far before turn-in the reference lap starts braking. Null: it does not brake. */
  readonly brakeBeforeM: number | null;
  readonly minSpeedKph: number | null;
  readonly gear: number | null;
}

export interface CalloutContext {
  readonly trackName: string;
  /** Layout, e.g. "Road Course". Empty when the track has only one. */
  readonly configName: string;
  readonly lengthM: number | null;
  readonly carName: string;
  /**
   * The track map's corners, in lap order, when one has been cut. Null means the
   * track has no map yet: the model is told to use the official numbering, and
   * the import is held until a map exists to place it on.
   */
  readonly corners: readonly PromptCorner[] | null;
  readonly video: { readonly title: string; readonly channel: string };
  readonly transcript: readonly TranscriptLine[];
}

const describeCorner = (c: PromptCorner, lengthM: number | null): string => {
  const bits = [
    lengthM === null ? null : `${Math.round(c.entryM)} m from the start line (${Math.round((c.entryM / lengthM) * 100)}% of the lap)`,
    `${c.direction}-hander`,
    ["", "flat kink", "fast", "medium-fast", "medium", "slow", "hairpin"][c.severity] ?? `severity ${c.severity}`,
    c.brakeBeforeM === null ? "no clear braking point in the reference lap" : `reference lap brakes ~${Math.round(c.brakeBeforeM)} m before turn-in`,
    c.minSpeedKph === null ? null : `slowest ~${Math.round(c.minSpeedKph)} km/h`,
    c.gear === null || c.gear < 1 ? null : `gear ${c.gear}`,
  ].filter((b) => b !== null);
  const official = c.officialTurn === null ? "" : ` (official Turn ${c.officialTurn})`;
  const name = c.names.length > 0 ? ` "${c.names.join('" / "')}"` : "";
  return `  - Corner ${c.id}${official}${name}: ${bits.join(", ")}`;
};

export function buildCalloutPrompt(ctx: CalloutContext): string {
  const layout = ctx.configName === "" ? "" : ` — ${ctx.configName}`;
  const length = ctx.lengthM === null ? "" : `, ${(ctx.lengthM / 1000).toFixed(2)} km`;
  const learned = ctx.corners?.some((c) => c.officialTurn !== null) ?? false;

  const corners =
    ctx.corners === null
      ? [
          "No corner list is available for this track yet. Use the track's official turn",
          "numbers for `corner`, and repeat the same number in `coachTurn`.",
        ].join("\n")
      : [
          `This layout has ${ctx.corners.length} corners, listed in the order they are driven from the`,
          "start/finish line. Every callout's `corner` (and `throughCorner`) must be one of these",
          "Corner numbers.",
          "",
          learned
            ? "Where a corner's official turn number is known it is shown; trust it."
            : "IMPORTANT: these Corner numbers come from our own detection and may NOT match the\n" +
              "official turn numbers a coach uses (a kink we detect may not count as a turn, or\n" +
              "two turns may be one of ours). Match the coach's advice to a corner by what they\n" +
              "describe — its order around the lap, left or right, how tight it is, the braking,\n" +
              "the gear, names and landmarks — not by the turn number they say. A track guide\n" +
              "usually narrates corners in lap order, which is the order below.",
          "",
          ...ctx.corners.map((c) => describeCorner(c, ctx.lengthM)),
        ].join("\n");

  return `You are writing spoken pace-note callouts for a sim-racing driving coach app.
A voice will read each callout to the driver just before they reach that corner, at race speed.

Track: ${ctx.trackName}${layout}${length}
Car: ${ctx.carName}
Source video: "${ctx.video.title}" by ${ctx.video.channel}

## Corners
${corners}

## What to write
From the track-guide transcript below, extract the coach's advice for each corner:
braking reference (a board, a marker, a landmark), gear, turn-in or aim point, and
where to get back on the throttle. Include only concrete, actionable driving advice.

Rules:
1. ONE callout per corner. Put braking, gear, line and throttle advice for a corner into
   that corner's single callout. Never write separate approach/apex/exit callouts.
2. Corners that are driven as one sequence (a chicane, an esses) may share one
   callout: set \`corner\` to the first and \`throughCorner\` to the last.
3. \`coachTurn\` is the turn number the coach uses for that corner, if they say one
   (e.g. "turn five" → 5), otherwise null. Never guess it.
4. Rewrite in your own words as short, imperative pace notes. Do not copy the
   coach's sentences. Example style: "Brake at the 100 board, third gear, late apex,
   use all the exit kerb."
5. \`text\` is the full callout — as long as it needs to be, but every word must earn
   its place: it has to be spoken in a few seconds at speed.
6. \`textShort\` is 2 to 4 words: the single most useful part, for when there is no
   time for the full callout. Example: "100 board, third".
7. \`confidence\` from 0 to 1: how sure you are that the advice is right AND that it
   is about that corner.
8. \`sourceTs\` is the transcript timestamp (as written, e.g. "4:31") where the coach
   gives that advice, or null.
9. If the coach's advice is specific to a different car than ${ctx.carName}, lower confidence.
10. If you cannot tell which corner a piece of advice is about, leave it out.
11. \`layoutMatches\`: false if the video is clearly about a different layout or track
    than ${ctx.trackName}${layout} (for example a shorter or longer variant of the circuit),
    and say why in \`layoutNote\`. Otherwise true, and \`layoutNote\` null.

## Answer format
Reply with ONLY a JSON object, no commentary, in exactly this shape:
\`\`\`json
{
  "layoutMatches": true,
  "layoutNote": null,
  "callouts": [
    {
      "corner": 1,
      "throughCorner": null,
      "coachTurn": 1,
      "text": "Brake at the 100 board, down to third, late apex, full kerb on exit.",
      "textShort": "100 board, third",
      "confidence": 0.8,
      "sourceTs": "2:14"
    }
  ]
}
\`\`\`

## Transcript
${transcriptText(ctx.transcript)}
`;
}

/**
 * The reply, as JSON Schema — for a provider that can constrain its output to
 * one. Kept to the subset every provider's structured-output mode accepts:
 * plain types, `required` on everything, nulls spelled out.
 */
export const CALLOUT_REPLY_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["layoutMatches", "layoutNote", "callouts"],
  properties: {
    layoutMatches: { type: "boolean" },
    layoutNote: { anyOf: [{ type: "string" }, { type: "null" }] },
    callouts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["corner", "throughCorner", "coachTurn", "text", "textShort", "confidence", "sourceTs"],
        properties: {
          corner: { type: "integer" },
          throughCorner: { anyOf: [{ type: "integer" }, { type: "null" }] },
          coachTurn: { anyOf: [{ type: "integer" }, { type: "null" }] },
          text: { type: "string" },
          textShort: { type: "string" },
          confidence: { type: "number" },
          sourceTs: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
      },
    },
  },
} as const;

const optInt = z.coerce.number().int().positive().nullish();

// `turn`/`throughTurn` are what the first version of the prompt asked for, and
// a reply pasted from an old chat still uses them.
const ReplyCalloutSchema = z
  .object({
    corner: optInt,
    turn: optInt,
    throughCorner: optInt,
    throughTurn: optInt,
    coachTurn: optInt,
    text: z.string().trim().min(1),
    textShort: z.string().trim().min(1).nullish(),
    confidence: z.coerce.number().min(0).max(1).nullish(),
    sourceTs: z.string().nullish(),
  })
  .refine((c) => (c.corner ?? c.turn) != null, { message: "no corner" });

const ReplySchema = z.object({
  callouts: z.array(z.unknown()),
  layoutMatches: z.boolean().nullish(),
  layoutNote: z.string().nullish(),
});

export interface DraftCallout {
  /** Our corner number — the map's `index`. */
  readonly turn: number;
  readonly throughTurn: number | null;
  /** The number the coach said for this corner, if any. */
  readonly coachTurn: number | null;
  readonly text: string;
  readonly textShort: string;
  readonly confidence: number | null;
  /** Milliseconds into the video, or null when the model gave none it could back. */
  readonly sourceMs: number | null;
}

export interface ParsedReply {
  readonly callouts: readonly DraftCallout[];
  /** Everything that was dropped or doubted, in words a person can act on. */
  readonly problems: readonly string[];
  /** Set when the model thinks the video is about a different layout. */
  readonly layoutWarning: string | null;
}

/**
 * The JSON inside a reply, wherever it is.
 *
 * A fenced block if there is one, otherwise the outermost braces. A pasted chat
 * answer almost always has a sentence before the JSON and often one after, and
 * insisting on a clean body would make the paste path fail for exactly the
 * people it exists for.
 */
export function extractJson(reply: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(reply);
  const candidates = [fenced?.[1], reply];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) continue;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      // Try the next candidate; the error is reported below if none parse.
    }
  }
  throw new Error("no JSON object found in the reply — it should contain { \"callouts\": [...] }");
}

export function parseCalloutReply(
  reply: string,
  validCorners: readonly number[] | null,
): ParsedReply {
  const top = ReplySchema.safeParse(extractJson(reply));
  if (!top.success) throw new Error('the reply has no "callouts" array');

  const valid = validCorners === null ? null : new Set(validCorners);
  const callouts: DraftCallout[] = [];
  const problems: string[] = [];

  top.data.callouts.forEach((raw, i) => {
    const parsed = ReplyCalloutSchema.safeParse(raw);
    if (!parsed.success) {
      problems.push(`callout ${i + 1} is malformed and was dropped`);
      return;
    }
    const c = parsed.data;
    const corner = (c.corner ?? c.turn)!;
    if (valid !== null && !valid.has(corner)) {
      problems.push(`"${c.text}" names corner ${corner}, which this track's map does not have — dropped`);
      return;
    }
    const through = c.throughCorner ?? c.throughTurn ?? null;
    const throughOk = through !== null && through > corner && (valid === null || valid.has(through));
    if (through !== null && !throughOk) {
      problems.push(`corner ${corner}'s range to ${through} is not valid — kept as corner ${corner} alone`);
    }

    callouts.push({
      turn: corner,
      throughTurn: throughOk ? through : null,
      coachTurn: c.coachTurn ?? null,
      text: c.text,
      textShort: c.textShort ?? "",
      confidence: c.confidence ?? null,
      sourceMs: c.sourceTs == null ? null : parseTimestamp(c.sourceTs),
    });
  });

  const seen = new Map<number, number>();
  for (const c of callouts) seen.set(c.turn, (seen.get(c.turn) ?? 0) + 1);
  for (const [corner, count] of seen) {
    if (count > 1) problems.push(`corner ${corner} has ${count} callouts — they will land on the same point; merge them`);
  }

  const layoutWarning =
    top.data.layoutMatches === false
      ? top.data.layoutNote ?? "the model thinks this video is about a different layout"
      : null;

  callouts.sort((a, b) => a.turn - b.turn);
  return { callouts, problems, layoutWarning };
}

export interface LearnedNumbers {
  /** Our corner number → the official turn number. */
  readonly turns: Readonly<Record<string, number>>;
  /** Why anything the reply said was not learned. */
  readonly conflicts: readonly string[];
  /** How many corners gained a number they did not have. */
  readonly added: number;
}

/**
 * The track's official turn numbering, as learned from what coaches say.
 *
 * Only what is consistent is kept: every corner maps to one number, no two
 * corners share one, and the numbers rise in lap order — a guide that says
 * "turn seven" for a corner before its "turn five" is wrong about one of them,
 * and which is not knowable, so neither is learned. What was learned before
 * wins over a new reply that disagrees with it; the disagreement is reported.
 */
export function learnTurnNumbers(
  callouts: readonly DraftCallout[],
  existing: Readonly<Record<string, number>>,
): LearnedNumbers {
  const turns: Record<string, number> = { ...existing };
  const conflicts: string[] = [];
  let added = 0;

  const said = callouts.filter((c): c is DraftCallout & { coachTurn: number } => c.coachTurn !== null);
  const byCorner = new Map<number, Set<number>>();
  for (const c of said) byCorner.set(c.turn, new Set([...(byCorner.get(c.turn) ?? []), c.coachTurn]));

  for (const [corner, numbers] of [...byCorner].sort((a, b) => a[0] - b[0])) {
    if (numbers.size > 1) {
      conflicts.push(`corner ${corner} was called turn ${[...numbers].join(" and ")} — not learned`);
      continue;
    }
    const number = [...numbers][0]!;
    const known = turns[String(corner)];
    if (known !== undefined) {
      if (known !== number) conflicts.push(`corner ${corner} is known as turn ${known}, this guide says ${number} — kept ${known}`);
      continue;
    }
    const clash = Object.entries(turns).find(([, n]) => n === number);
    if (clash !== undefined) {
      conflicts.push(`turn ${number} is already corner ${clash[0]}, not corner ${corner} — not learned`);
      continue;
    }
    const before = Object.entries(turns).filter(([c]) => Number(c) < corner).map(([, n]) => n);
    const after = Object.entries(turns).filter(([c]) => Number(c) > corner).map(([, n]) => n);
    if (before.some((n) => n >= number) || after.some((n) => n <= number)) {
      conflicts.push(`turn ${number} at corner ${corner} is out of lap order with the numbers already known — not learned`);
      continue;
    }
    turns[String(corner)] = number;
    added++;
  }

  return { turns, conflicts, added };
}

export interface ProfileSource {
  readonly videoId: string;
  readonly title: string;
  readonly channel: string;
}

/**
 * Into the `ImportProfile` the rest of the app already knows how to place
 * (`resolveProfile`, packages/core/src/import.ts). Validated on the way out, so
 * a draft edited by hand into something the importer will refuse is caught
 * here rather than at import.
 */
export function toImportProfile(
  callouts: readonly DraftCallout[],
  source: ProfileSource,
  carClass: string,
): ImportProfile {
  return ImportProfileSchema.parse({
    schema: 1,
    source: {
      type: "youtube",
      videoId: source.videoId,
      url: `https://www.youtube.com/watch?v=${source.videoId}`,
      title: source.title,
      channel: source.channel,
    },
    carClass,
    callouts: callouts.map((c) => ({
      turn: c.turn,
      ...(c.throughTurn === null ? {} : { throughTurn: c.throughTurn }),
      text: c.text,
      ...(c.textShort === "" ? {} : { textShort: c.textShort }),
      ...(c.confidence === null ? {} : { confidence: c.confidence }),
      ...(c.sourceMs === null ? {} : { sourceTs: formatTimestamp(c.sourceMs) }),
    })),
  });
}
