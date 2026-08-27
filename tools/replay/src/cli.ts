/**
 * Replay harness CLI — SPEC.md §9.
 *
 * "You cannot iterate on callout timing by driving laps. Highest-leverage thing
 * in the build, so it comes BEFORE the note engine, not after."
 *
 * At M0a this prints the frame timeline. At M2 the note engine is piped in here
 * and the output becomes the FIRE/DROP timeline from §9:
 *
 *   lap 3  pct 0.9812  spd 241kph  FIRE t1_brake     lead 117m  dAhead 116m
 *   lap 3  pct 0.0203  spd  98kph  DROP t1_line      reason: no_fit_after_short
 *
 * which golden-file tests then assert against, so any change to the trigger math
 * that moves a fire point shows up as a diff.
 *
 * Usage:
 *   exxeed-replay <recording.ndjson> [--speed N] [--every N] [--quiet]
 *
 *   --speed N   playback rate; 0 or omitted means flat out
 *   --every N   print every Nth frame (default 10, so 60 Hz stays readable)
 */

import { toKph } from "@exxeed/core";
import { ReplayAdapter, type TelemetryFrame } from "@exxeed/telemetry";

interface Args {
  readonly path: string;
  readonly speed: number;
  readonly every: number;
  readonly quiet: boolean;
}

function parseArgs(argv: readonly string[]): Args | null {
  const positional: string[] = [];
  let speed = 0;
  let every = 10;
  let quiet = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--speed") speed = Number(argv[++i] ?? "0");
    else if (arg === "--every") every = Math.max(1, Number(argv[++i] ?? "1"));
    else if (arg === "--quiet") quiet = true;
    else positional.push(arg);
  }

  const path = positional[0];
  if (path === undefined) return null;
  return { path, speed, every, quiet };
}

const pad = (s: string | number, width: number): string => String(s).padStart(width);

const line = (f: TelemetryFrame): string =>
  `lap ${pad(f.lap, 2)}  pct ${f.lapDistPct.toFixed(4)}  ` +
  `spd ${pad(toKph(f.speedMps).toFixed(0), 3)}kph  ` +
  `thr ${f.throttle.toFixed(2)}  brk ${f.brake.toFixed(2)}  gear ${f.gear}`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) {
    process.stderr.write(
      "usage: exxeed-replay <recording.ndjson> [--speed N] [--every N] [--quiet]\n",
    );
    return 1;
  }

  const source = new ReplayAdapter(args.path, { speed: args.speed });
  await source.connect();

  const startedAt = Date.now();
  let frames = 0;
  let laps = 0;
  let lastPct = 0;

  for await (const frame of source) {
    frames++;
    if (frame.lapDistPct < lastPct) laps++;
    lastPct = frame.lapDistPct;

    if (!args.quiet && frames % args.every === 0) {
      process.stdout.write(`${line(frame)}\n`);
    }
  }

  await source.close();

  const wallS = (Date.now() - startedAt) / 1000;
  process.stdout.write(
    `\n${frames} frames, ${laps} start/finish crossings, ${wallS.toFixed(2)}s wall\n`,
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`${String(err)}\n`);
    process.exit(1);
  },
);
