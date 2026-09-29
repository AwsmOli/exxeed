/**
 * Stage 3 — the transcript in, `{ turn, text }` out (SPEC.md §10).
 *
 * One prompt, used two ways. The importer can send it to a model itself, or
 * hand it to a person to paste into whichever chat they already use and paste
 * the answer back. Keeping it a single piece of text rather than a
 * provider-specific request is what makes the second path possible at all, and
 * it means the reply parser below cannot assume anything a chat window will not
 * reliably do — so it digs the JSON out of prose and code fences rather than
 * expecting a clean body.
 *
 * The rules are §10's, and the reasons for each are there:
 *
 * - corners as an enum, so a turn number is a thing in the map or nothing;
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
  readonly turn: number;
  readonly names: readonly string[];
  readonly direction: "left" | "right";
  readonly severity: number;
}

export interface CalloutContext {
  readonly trackName: string;
  /** Layout, e.g. "Road Course". Empty when the track has only one. */
  readonly configName: string;
  readonly carName: string;
  /**
   * The track map's corners, when one has been cut. Null means the track has no
   * map yet: the model is then told to use the conventional numbering and the
   * import is held until a map exists to check it against.
   */
  readonly corners: readonly PromptCorner[] | null;
  readonly video: { readonly title: string; readonly channel: string };
  readonly transcript: readonly TranscriptLine[];
}

const describeCorner = (c: PromptCorner): string => {
  const name = c.names.length > 0 ? ` "${c.names.join('" / "')}"` : "";
  return `  - Turn ${c.turn}${name}: ${c.direction}, severity ${c.severity}/6`;
};

export function buildCalloutPrompt(ctx: CalloutContext): string {
  const layout = ctx.configName === "" ? "" : ` (${ctx.configName})`;
  const turns =
    ctx.corners === null
      ? [
          "No corner list is available for this track. Number turns the way the",
          "track and its coaches conventionally do (the official turn numbers).",
        ].join("\n")
      : [
          "These are the ONLY valid turn numbers. Every callout's `turn` (and",
          "`throughTurn`) must be one of them. If you cannot tell which turn a",
          "piece of advice is about, leave it out rather than guess.",
          ...ctx.corners.map(describeCorner),
        ].join("\n");

  return `You are writing spoken pace-note callouts for a sim-racing driving coach app.
A voice will read each callout to the driver just before they reach that turn, at race speed.

Track: ${ctx.trackName}${layout}
Car: ${ctx.carName}
Source video: "${ctx.video.title}" by ${ctx.video.channel}

## Turns
${turns}

## What to write
From the track-guide transcript below, extract the coach's advice for each turn:
braking reference (a board, a marker, a landmark), gear, turn-in or aim point, and
where to get back on the throttle. Include only concrete, actionable driving advice.

Rules:
1. ONE callout per turn. Put braking, gear, line and throttle advice for a turn into
   that turn's single callout. Never write separate approach/apex/exit callouts.
2. Corners that are driven as one sequence (a chicane, an esses) may share one
   callout: set \`turn\` to the first turn and \`throughTurn\` to the last.
3. Rewrite in your own words as short, imperative pace notes. Do not copy the
   coach's sentences. Example style: "Brake at the 100 board, third gear, late apex,
   use all the exit kerb."
4. \`text\` is the full callout — as long as it needs to be, but every word must earn
   its place: it has to be spoken in a few seconds at speed.
5. \`textShort\` is 2 to 4 words: the single most useful part, for when there is no
   time for the full callout. Example: "100 board, third".
6. \`confidence\` from 0 to 1: how sure you are that the advice is right and about
   that turn.
7. \`sourceTs\` is the transcript timestamp (as written, e.g. "4:31") where the coach
   gives that advice, or null.
8. If the coach's advice is specific to a different car than ${ctx.carName}, say so by
   lowering confidence.
9. Order the callouts by turn number.

## Answer format
Reply with ONLY a JSON object, no commentary, in exactly this shape:
\`\`\`json
{
  "callouts": [
    {
      "turn": 1,
      "throughTurn": null,
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
  required: ["callouts"],
  properties: {
    callouts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["turn", "throughTurn", "text", "textShort", "confidence", "sourceTs"],
        properties: {
          turn: { type: "integer" },
          throughTurn: { anyOf: [{ type: "integer" }, { type: "null" }] },
          text: { type: "string" },
          textShort: { type: "string" },
          confidence: { type: "number" },
          sourceTs: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
      },
    },
  },
} as const;

const ReplyCalloutSchema = z.object({
  turn: z.coerce.number().int().positive(),
  throughTurn: z.coerce.number().int().positive().nullish(),
  text: z.string().trim().min(1),
  textShort: z.string().trim().min(1).nullish(),
  confidence: z.coerce.number().min(0).max(1).nullish(),
  sourceTs: z.string().nullish(),
});

const ReplySchema = z.object({ callouts: z.array(z.unknown()) });

export interface DraftCallout {
  readonly turn: number;
  readonly throughTurn: number | null;
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
  validTurns: readonly number[] | null,
): ParsedReply {
  const top = ReplySchema.safeParse(extractJson(reply));
  if (!top.success) throw new Error('the reply has no "callouts" array');

  const valid = validTurns === null ? null : new Set(validTurns);
  const callouts: DraftCallout[] = [];
  const problems: string[] = [];

  top.data.callouts.forEach((raw, i) => {
    const parsed = ReplyCalloutSchema.safeParse(raw);
    if (!parsed.success) {
      problems.push(`callout ${i + 1} is malformed and was dropped`);
      return;
    }
    const c = parsed.data;
    if (valid !== null && !valid.has(c.turn)) {
      problems.push(`"${c.text}" names turn ${c.turn}, which this track's map does not have — dropped`);
      return;
    }
    const through = c.throughTurn ?? null;
    if (through !== null && (through < c.turn || (valid !== null && !valid.has(through)))) {
      problems.push(`turn ${c.turn}'s range to ${through} is not valid — kept as turn ${c.turn} alone`);
    }

    const sourceMs = c.sourceTs == null ? null : parseTimestamp(c.sourceTs);
    callouts.push({
      turn: c.turn,
      throughTurn: through !== null && through > c.turn && (valid === null || valid.has(through)) ? through : null,
      text: c.text,
      textShort: c.textShort ?? "",
      confidence: c.confidence ?? null,
      sourceMs,
    });
  });

  const seen = new Map<number, number>();
  for (const c of callouts) seen.set(c.turn, (seen.get(c.turn) ?? 0) + 1);
  for (const [turn, count] of seen) {
    if (count > 1) problems.push(`turn ${turn} has ${count} callouts — they will land on the same point; merge them`);
  }

  callouts.sort((a, b) => a.turn - b.turn);
  return { callouts, problems };
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
