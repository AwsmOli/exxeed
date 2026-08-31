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
 *   exxeed-ingest import <profile.json> --id <noteSetId> --track-id N --config <id>
 *   exxeed-ingest render <noteSetId> [options]
 *
 *   --data <dir>      artefact root, default ./data
 *   --model <path>    piper .onnx voice model (or EXXEED_PIPER_MODEL)
 *   --piper <path>    piper executable (or EXXEED_PIPER, default ./.venv/bin/piper)
 *   --length-scale N  speaking rate; below 1 is faster, default 1
 *   --voice <id>      override the voiceId recorded in the pack
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { ImportProfileSchema, resolveProfile, type NoteSet } from "@exxeed/core";
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

/**
 * Stage 3's output, in — `{ turn, text }` and nothing else.
 *
 * The video half of the pipeline is a separate tool (§10), so this is the seam.
 * It never sees a transcript and the helper never sees telemetry: turning a turn
 * number into a lap position needs the corner list and the reference lap's
 * measured braking points, both of which live here.
 */
async function importProfile(argv: readonly string[]): Promise<number> {
  const positional: string[] = [];
  let dataDir = "data";
  let id: string | undefined;
  let trackId: number | undefined;
  let configId: string | undefined;
  let carId: string | undefined;
  let voiceDir: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--data") dataDir = argv[++i] ?? "data";
    else if (arg === "--id") id = argv[++i];
    else if (arg === "--track-id") trackId = Number(argv[++i]);
    else if (arg === "--config") configId = argv[++i];
    else if (arg === "--car-id") carId = argv[++i];
    else if (arg === "--voice-dir") voiceDir = argv[++i];
    else positional.push(arg);
  }

  const path = positional[0];
  if (path === undefined || id === undefined || trackId === undefined || configId === undefined) {
    process.stderr.write(
      "usage: exxeed-ingest import <profile.json> --id <noteSetId> " +
        "--track-id N --config <id> [--car-id <id>] [--data DIR]\n",
    );
    return 1;
  }

  const raw: unknown = JSON.parse(await readFile(fromInvocationDir(path), "utf8"));
  const profile = ImportProfileSchema.parse(raw);

  const repos = localRepositories(fromInvocationDir(dataDir));
  const trackKey = { sim: "iracing", trackId, configId } as const;

  const mapVersion = await repos.trackMaps.latestVersion(trackKey);
  if (mapVersion === null) throw new Error(`no track map for ${trackId}/${configId}`);
  const map = await repos.trackMaps.get({ ...trackKey, mapVersion });
  if (map === null) throw new Error(`no track map v${String(mapVersion)}`);

  const cars = await repos.referenceLaps.listCars(trackKey);
  const chosenCar = carId ?? cars[0];
  const lap = chosenCar === undefined ? null : await repos.referenceLaps.get(trackKey, chosenCar);

  const resolved = resolveProfile(profile, map, lap, {
    ...(voiceDir === undefined ? {} : { voiceDir }),
  });

  for (const warning of resolved.warnings) process.stderr.write(`warning: ${warning}\n`);
  for (const u of resolved.unresolved) {
    process.stderr.write(`unresolved: turn ${String(u.callout.turn)} — ${u.reason}\n`);
  }

  if (resolved.notes.length === 0) {
    process.stderr.write("nothing resolved; writing nothing\n");
    return 1;
  }

  const noteSet: NoteSet = {
    id,
    trackKey,
    lengthM: map.lengthM,
    carClass: profile.carClass,
    source: profile.source,
    // Imported, unheard, and every note stale until rendered. §7.4 will not let a
    // set with a dirty note be published, which is the right place for that gate.
    status: "draft",
    createdAt: new Date().toISOString(),
    notes: [...resolved.notes],
  };
  await repos.noteSets.put(noteSet);

  process.stdout.write(`\nimported ${resolved.notes.length} callouts as "${id}"\n`);
  for (const note of resolved.notes) {
    process.stdout.write(`  ${note.id.padEnd(6)} pct ${note.pct.toFixed(4)}  "${note.text}"\n`);
  }
  process.stdout.write(
    `\nEvery note is dirty — the durations above are placeholders, not measurements.\n` +
      `Render before driving:  exxeed-ingest render ${id} --data ${dataDir} --model <voice.onnx>\n`,
  );
  return 0;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "render") return render(rest);
  if (command === "import") return importProfile(rest);
  return usage();
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
