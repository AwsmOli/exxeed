/**
 * Replay harness CLI — SPEC.md §9.
 *
 * "You cannot iterate on callout timing by driving laps. Highest-leverage thing
 * in the build, so it comes BEFORE the note engine, not after."
 *
 * Pipes a recording through the note engine on a virtual clock and emits the
 * timeline. The run loop itself lives in run.ts so golden-file tests drive the
 * same code path this does.
 *
 * Usage:
 *   exxeed-replay <recording.ndjson> [options]
 *
 *   --speed N        playback rate; 0 or omitted runs flat out
 *   --notes <id>     note set to load from --data (otherwise: frames only)
 *   --data <dir>     artefact root, default ./data
 *   --lead-adjust N  driver profile lead adjustment, seconds
 *   --skip-outlap    speak from the first frame; for single-lap recordings
 */

import { resolve } from "node:path";

import { run } from "./run.js";

interface Args {
  readonly path: string;
  readonly speed: number;
  readonly notesId: string | null;
  readonly dataDir: string;
  readonly leadAdjustS: number;
  readonly skipOutLap: boolean;
}

function parseArgs(argv: readonly string[]): Args | null {
  const positional: string[] = [];
  let speed = 0;
  let notesId: string | null = null;
  let dataDir = "data";
  let leadAdjustS = 0;
  let skipOutLap = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--speed") speed = Number(argv[++i] ?? "0");
    else if (arg === "--notes") notesId = argv[++i] ?? null;
    else if (arg === "--data") dataDir = argv[++i] ?? "data";
    else if (arg === "--lead-adjust") leadAdjustS = Number(argv[++i] ?? "0");
    else if (arg === "--skip-outlap") skipOutLap = true;
    else positional.push(arg);
  }

  const path = positional[0];
  if (path === undefined) return null;
  return { path, speed, notesId, dataDir, leadAdjustS, skipOutLap };
}

/**
 * Paths resolve against the directory the command was invoked from, not the
 * package directory. pnpm --filter runs scripts from the package root, so without
 * INIT_CWD every relative path a user typed would silently resolve elsewhere.
 */
const fromInvocationDir = (path: string): string =>
  resolve(process.env["INIT_CWD"] ?? process.cwd(), path);

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) {
    process.stderr.write(
      "usage: exxeed-replay <recording.ndjson> [--speed N] [--notes ID] [--data DIR]\n" +
        "                     [--lead-adjust S] [--skip-outlap]\n",
    );
    return 1;
  }

  const startedAt = Date.now();
  const summary = await run({
    recordingPath: fromInvocationDir(args.path),
    speed: args.speed,
    noteSetId: args.notesId,
    dataDir: fromInvocationDir(args.dataDir),
    leadAdjustS: args.leadAdjustS,
    skipOutLap: args.skipOutLap,
    onLine: (line) => process.stdout.write(`${line}\n`),
  });

  for (const warning of summary.warnings) {
    process.stderr.write(`warning: ${warning}\n`);
  }

  const wallS = (Date.now() - startedAt) / 1000;
  process.stdout.write(
    `\n${summary.frames} frames, ${summary.crossings} start/finish crossings, ` +
      `${wallS.toFixed(2)}s wall\n`,
  );
  if (args.notesId !== null) {
    process.stdout.write(`${summary.played} spoken, ${summary.dropped} dropped\n`);
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
