/**
 * Replay harness CLI — SPEC.md §9.
 *
 * "You cannot iterate on callout timing by driving laps. Highest-leverage thing
 * in the build, so it comes BEFORE the note engine, not after."
 *
 * Pipes a recording through the note engine on a virtual clock and emits the
 * timeline. Golden-file that output and any change to the trigger math that moves
 * a fire point shows up as a diff.
 *
 * Usage:
 *   exxeed-replay <recording.ndjson> [options]
 *
 *   --speed N        playback rate; 0 or omitted runs flat out
 *   --notes <id>     note set to load from --data (otherwise: frames only)
 *   --data <dir>     artefact root, default ./data
 *   --lead-adjust N  driver profile lead adjustment, seconds
 *   --frames         also print a frame line every --every ticks
 *   --every N        frame print interval (default 30)
 */

import { resolve } from "node:path";

import type { DriverProfile, NoteSet, TrackMap } from "@exxeed/core";
import { indexLandmarks, metres, NoteEngine, resolveNotes, toKph } from "@exxeed/core";
import { localRepositories } from "@exxeed/repo";
import { ReplayAdapter, toTickInput, type TelemetryFrame } from "@exxeed/telemetry";

import { formatEvent } from "./timeline.js";

interface Args {
  readonly path: string;
  readonly speed: number;
  readonly notesId: string | null;
  readonly dataDir: string;
  readonly leadAdjustS: number;
  readonly frames: boolean;
  readonly every: number;
}

function parseArgs(argv: readonly string[]): Args | null {
  const positional: string[] = [];
  let speed = 0;
  let notesId: string | null = null;
  let dataDir = "data";
  let leadAdjustS = 0;
  let frames = false;
  let every = 30;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--speed") speed = Number(argv[++i] ?? "0");
    else if (arg === "--notes") notesId = argv[++i] ?? null;
    else if (arg === "--data") dataDir = argv[++i] ?? "data";
    else if (arg === "--lead-adjust") leadAdjustS = Number(argv[++i] ?? "0");
    else if (arg === "--frames") frames = true;
    else if (arg === "--every") every = Math.max(1, Number(argv[++i] ?? "1"));
    else positional.push(arg);
  }

  const path = positional[0];
  if (path === undefined) return null;
  return { path, speed, notesId, dataDir, leadAdjustS, frames, every };
}

/**
 * Paths are resolved against the directory the command was invoked from, not the
 * package directory. pnpm --filter runs scripts from the package root, so without
 * INIT_CWD every relative path a user typed would silently resolve somewhere
 * they did not mean.
 */
const fromInvocationDir = (path: string): string =>
  resolve(process.env["INIT_CWD"] ?? process.cwd(), path);

async function loadEngine(args: Args): Promise<NoteEngine | null> {
  if (args.notesId === null) return null;

  const repos = localRepositories(fromInvocationDir(args.dataDir));

  const noteSet: NoteSet | null = await repos.noteSets.get(args.notesId);
  if (noteSet === null) throw new Error(`no note set "${args.notesId}" under ${args.dataDir}`);

  const map: TrackMap | null = await repos.trackMaps.get(noteSet.trackRef);
  if (map === null) throw new Error(`no track map for ${JSON.stringify(noteSet.trackRef)}`);

  const inventory = await repos.landmarks.get(noteSet.trackRef);
  if (inventory === null) throw new Error(`no landmark inventory for this track`);

  const { resolved, unresolved } = resolveNotes(
    noteSet.notes,
    map,
    indexLandmarks(inventory),
  );

  // Unresolvable notes are a data problem, and silently dropping them is how a
  // note set ends up quietly half-working. Say so once, at load.
  for (const note of unresolved) {
    process.stderr.write(`warning: note "${note.id}" has an unresolvable anchor, skipping\n`);
  }

  const profile: DriverProfile = { leadAdjustS: args.leadAdjustS };
  return new NoteEngine(resolved, metres(map.lengthM), profile);
}

const frameLine = (f: TelemetryFrame): string =>
  `lap ${String(f.lap).padStart(2)}  pct ${f.lapDistPct.toFixed(4)}  ` +
  `spd ${toKph(f.speedMps).toFixed(0).padStart(3)}kph  ` +
  `thr ${f.throttle.toFixed(2)}  brk ${f.brake.toFixed(2)}  gear ${f.gear}`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) {
    process.stderr.write(
      "usage: exxeed-replay <recording.ndjson> [--speed N] [--notes ID] [--data DIR]\n" +
        "                     [--lead-adjust S] [--frames] [--every N]\n",
    );
    return 1;
  }

  const engine = await loadEngine(args);
  const source = new ReplayAdapter(fromInvocationDir(args.path), { speed: args.speed });
  await source.connect();

  const startedAt = Date.now();
  let frames = 0;
  let crossings = 0;
  let played = 0;
  let dropped = 0;
  let lastPct = 0;

  for await (const frame of source) {
    frames++;
    if (frame.lapDistPct < lastPct) crossings++;
    lastPct = frame.lapDistPct;

    if (engine !== null) {
      for (const event of engine.tick(toTickInput(frame)).events) {
        if (event.kind === "play") played++;
        else dropped++;
        process.stdout.write(`${formatEvent(event, frame.lap)}\n`);
      }
    }

    if (args.frames && frames % args.every === 0) {
      process.stdout.write(`${frameLine(frame)}\n`);
    }
  }

  await source.close();

  const wallS = (Date.now() - startedAt) / 1000;
  process.stdout.write(
    `\n${frames} frames, ${crossings} start/finish crossings, ${wallS.toFixed(2)}s wall\n`,
  );
  if (engine !== null) {
    process.stdout.write(`${played} spoken, ${dropped} dropped\n`);
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
