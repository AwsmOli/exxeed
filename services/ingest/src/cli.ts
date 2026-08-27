/**
 * Video ingest pipeline — SPEC.md §10. Stub until M5.
 *
 * Standalone Node CLI. Runs offline, never bundled into the Electron app, and
 * never called from the client: "Never call an LLM from the client."
 *
 * Built as a funnel so bad submissions die cheaply — most public YouTube laps are
 * silent hotlaps with music over them and are worth nothing. Average cost per
 * SUBMITTED video lands under a cent because most die at stage 1 or 2.
 *
 *   0  Normalise   extract video ID, dedupe against the processed set   free
 *   1  Metadata    duration, captions, title, channel; reject >45 min   free
 *   2  Triage      first ~500 words → is this instructional at all?     ~$0.0005
 *   3  Extract     transcript + corners + landmarks AS ENUMS → notes    ~$0.005
 *   4  Validate    cross-check against reference lap telemetry          free
 *   5  Review      human pass in the note editor (§7.4)                 time
 *   6  Render      TTS both variants → ffprobe → AudioPack              ~$0.04/track
 *
 * Two rules that are easy to lose and expensive to relearn:
 *
 *  - Stage 3 passes the corner list and landmark inventory as ENUMS. Every note
 *    must use a cornerIndex and anchor.id from those sets, or emit null. No fuzzy
 *    string matching, ever (§12).
 *  - Stage 4 has ground truth and should use it. A hallucinated braking reference
 *    doesn't produce a bad paragraph, it produces a crash.
 */

const STAGES = [
  "0 normalise",
  "1 metadata",
  "2 triage",
  "3 extract",
  "4 validate",
  "5 review",
  "6 render",
] as const;

process.stdout.write(
  `exxeed-ingest — not implemented yet (M5).\n\nPlanned stages:\n${STAGES.map(
    (s) => `  ${s}\n`,
  ).join("")}\nSee docs/SPEC.md §10. Stage 6 needs ffprobe on PATH.\n`,
);
