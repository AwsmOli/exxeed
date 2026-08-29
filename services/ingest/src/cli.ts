/**
 * Video ingest pipeline — SPEC.md §10. Standalone offline CLI, never bundled
 * into the app and never called from the client: "Never call an LLM from the
 * client."
 *
 * Stages 0–5 are not built yet. Stage 6 is, because it is the one stage the
 * hand-authored note sets of §11's M2 also need — a note set with no audio is
 * a note set that cannot speak.
 *
 *   0  Normalise   extract video ID, dedupe against the processed set   free
 *   1  Metadata    duration, captions, title, channel; reject >45 min   free
 *   2  Triage      first ~500 words — is this instructional at all?     ~$0.0005
 *   3  Extract     transcript + corners AS ENUMS -> notes               ~$0.005
 *   4  Validate    cross-check against reference lap telemetry          free
 *   5  Review      human pass in the note editor (§7.4)                 time
 *   6  Render      TTS both variants -> measure -> AudioPack            local
 *
 * Usage:
 *   exxeed-ingest render <noteSetId> [options]
 *
 *   --data <dir>      artefact root, default ./data
 *   --model <path>    piper .onnx voice model (or EXXEED_PIPER_MODEL)
 *   --piper <path>    piper executable (or EXXEED_PIPER, default ./.venv/bin/piper)
 *   --length-scale N  speaking rate; below 1 is faster, default 1
 *   --voice <id>      override the voiceId recorded in the pack
 */

import { resolve } from "node:path";

import { localRepositories } from "@exxeed/repo";

import { PiperEngine, renderNoteSet } from "@exxeed/tts";

const STAGES = [
  "0 normalise", "1 metadata", "2 triage", "3 extract",
  "4 validate", "5 review", "6 render",
] as const;

/** Relative paths resolve against where the command was typed, not the package. */
const fromInvocationDir = (path: string): string =>
  resolve(process.env["INIT_CWD"] ?? process.cwd(), path);

const env = (name: string): string | undefined => {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
};

function usage(): number {
  process.stderr.write(
    "usage: exxeed-ingest render <noteSetId> [--data DIR] [--model PATH]\n" +
      "                            [--piper PATH] [--length-scale N] [--voice ID]\n\n" +
      `stages 0-5 are not implemented yet:\n${STAGES.map((s) => `  ${s}\n`).join("")}` +
      "\nsee docs/SPEC.md §10\n",
  );
  return 1;
}

async function render(argv: readonly string[]): Promise<number> {
  const positional: string[] = [];
  let dataDir = "data";
  let model = env("EXXEED_PIPER_MODEL");
  let binary = env("EXXEED_PIPER") ?? ".venv/bin/piper";
  let lengthScale = 1;
  let voiceId: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--data") dataDir = argv[++i] ?? "data";
    else if (arg === "--model") model = argv[++i];
    else if (arg === "--piper") binary = argv[++i] ?? binary;
    else if (arg === "--length-scale") lengthScale = Number(argv[++i] ?? "1");
    else if (arg === "--voice") voiceId = argv[++i];
    else positional.push(arg);
  }

  const noteSetId = positional[0];
  if (noteSetId === undefined) return usage();

  if (model === undefined) {
    process.stderr.write(
      "no voice model. Pass --model or set EXXEED_PIPER_MODEL to a piper .onnx file.\n" +
        "Voices: https://huggingface.co/rhasspy/piper-voices\n",
    );
    return 1;
  }

  const repos = localRepositories(fromInvocationDir(dataDir));
  const noteSet = await repos.noteSets.get(noteSetId);
  if (noteSet === null) throw new Error(`no note set "${noteSetId}" under ${dataDir}`);

  const engine = new PiperEngine({
    binary: fromInvocationDir(binary),
    model: fromInvocationDir(model),
    lengthScale,
    ...(voiceId === undefined ? {} : { voiceId }),
  });

  process.stdout.write(`rendering ${noteSet.notes.length} notes as "${engine.voiceId}"\n\n`);

  const result = await renderNoteSet({
    noteSet,
    engine,
    audio: repos.audio,
    noteSets: repos.noteSets,
    onClip: (clip) =>
      process.stdout.write(
        `  ${clip.key.padEnd(18)} ${String(clip.durationMs).padStart(5)}ms  "${clip.text}"\n`,
      ),
  });

  const longest = [...result.clips].sort((a, b) => b.durationMs - a.durationMs)[0]!;
  process.stdout.write(
    `\n${result.clips.length} clips, ${(result.pack.totalBytes / 1024).toFixed(0)} KiB\n` +
      `longest: ${longest.key} at ${longest.durationMs}ms — that sets its lead distance (§6.1)\n` +
      `note set updated: durations measured, dirty flags cleared\n`,
  );
  return 0;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "render") return render(rest);
  return usage();
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
