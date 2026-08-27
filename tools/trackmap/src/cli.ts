/**
 * Track map builder CLI — SPEC.md §5 and milestone M1.
 *
 * Cuts a `TrackMap` and a `ReferenceLap` from one recorded lap and writes them
 * through the repository layer, because §8 is absolute about that: "Nothing
 * outside packages/repo may touch the filesystem or the network for these
 * artefacts."
 *
 * Usage:
 *   exxeed-trackmap <lap.ndjson> --track-id N --config <id> [options]
 *
 *   --track-id N        iRacing TrackID (WeekendInfo.TrackID)
 *   --config <id>       layout id, e.g. road_course
 *   --map-version N     TrackRef.mapVersion, default 1
 *   --car-id N          iRacing CarID the lap was driven in, default 0
 *   --name <s>          display name, default the recording's own header
 *   --config-name <s>   layout display name
 *   --length N          track length in metres; inferred from lapDistM if omitted
 *   --grid N            grid size, default 2000
 *   --overrides <path>  corners.override.json (§5.2)
 *   --data <dir>        artefact root, default ./data
 *   --svg <path>        also write a map to look at
 *   --dry-run           print what would be written, write nothing
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { CornerOverridesSchema, type CornerOverrides, type TrackRef } from "@exxeed/core";
import { localRepositories } from "@exxeed/repo";

import { buildTrackMap, readFrames } from "./build.js";
import { renderMapSvg } from "./render.js";

interface Args {
  readonly path: string;
  readonly trackId: number;
  readonly configId: string;
  readonly mapVersion: number;
  readonly carId: number;
  readonly name: string | null;
  readonly configName: string | null;
  readonly lengthM: number | null;
  readonly gridSize: number;
  readonly overridesPath: string | null;
  readonly dataDir: string;
  readonly svgPath: string | null;
  readonly dryRun: boolean;
}

const USAGE = `usage: exxeed-trackmap <lap.ndjson> --track-id N --config <id> [options]

  --track-id N        iRacing TrackID (WeekendInfo.TrackID)
  --config <id>       layout id, e.g. road_course
  --map-version N     TrackRef.mapVersion, default 1
  --car-id N          iRacing CarID the lap was driven in, default 0
  --name <s>          display name for the track
  --config-name <s>   display name for the layout
  --length N          track length in metres; inferred from lapDistM if omitted
  --grid N            grid size, default 2000
  --overrides <path>  corners.override.json (SPEC.md §5.2)
  --data <dir>        artefact root, default ./data
  --svg <path>        also write an SVG to eyeball
  --dry-run           print what would be written, write nothing
`;

function parseArgs(argv: readonly string[]): Args | null {
  const positional: string[] = [];
  let trackId: number | null = null;
  let configId: string | null = null;
  let mapVersion = 1;
  let carId = 0;
  let name: string | null = null;
  let configName: string | null = null;
  let lengthM: number | null = null;
  let gridSize = 2000;
  let overridesPath: string | null = null;
  let dataDir = "data";
  let svgPath: string | null = null;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };

    switch (arg) {
      case "--track-id": trackId = Number(next()); break;
      case "--config": configId = next(); break;
      case "--map-version": mapVersion = Number(next()); break;
      case "--car-id": carId = Number(next()); break;
      case "--name": name = next(); break;
      case "--config-name": configName = next(); break;
      case "--length": lengthM = Number(next()); break;
      case "--grid": gridSize = Number(next()); break;
      case "--overrides": overridesPath = next(); break;
      case "--data": dataDir = next(); break;
      case "--svg": svgPath = next(); break;
      case "--dry-run": dryRun = true; break;
      default:
        if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
        positional.push(arg);
    }
  }

  const path = positional[0];
  if (path === undefined || trackId === null || configId === null) return null;

  return {
    path, trackId, configId, mapVersion, carId, name, configName,
    lengthM, gridSize, overridesPath, dataDir, svgPath, dryRun,
  };
}

// Paths resolve against the directory the command was invoked from, not the
// package — same reason as the replay CLI, which learned this the hard way.
const from = (p: string): string => resolve(process.env["INIT_CWD"] ?? process.cwd(), p);

async function main(): Promise<number> {
  let args: Args | null;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${String(err instanceof Error ? err.message : err)}\n\n${USAGE}`);
    return 2;
  }
  if (args === null) {
    process.stderr.write(USAGE);
    return 2;
  }

  const frames = await readFrames(from(args.path));

  let overrides: CornerOverrides | undefined;
  if (args.overridesPath !== null) {
    const raw: unknown = JSON.parse(await readFile(from(args.overridesPath), "utf8"));
    overrides = CornerOverridesSchema.parse(raw);
  }

  const trackRef: TrackRef = {
    sim: "iracing",
    trackId: args.trackId,
    configId: args.configId,
    mapVersion: args.mapVersion,
  };

  const built = buildTrackMap(frames, {
    recordingPath: args.path,
    trackRef,
    trackName: args.name ?? `track ${args.trackId}`,
    configName: args.configName ?? args.configId,
    carId: args.carId,
    ...(args.lengthM !== null ? { lengthM: args.lengthM } : {}),
    gridSize: args.gridSize,
    ...(overrides !== undefined ? { overrides } : {}),
  });

  const d = built.diagnostics;
  const out = process.stdout;
  out.write(`${built.map.trackName} — ${built.map.configName}\n`);
  out.write(`  lap        ${d.frames} frames, ${d.lapTimeS.toFixed(2)}s, coverage ${(d.coverage * 100).toFixed(1)}%\n`);
  out.write(`  length     ${d.lengthM.toFixed(1)}m ${args.lengthM === null ? "(inferred from lapDistM)" : "(given)"}\n`);
  out.write(`  centreline path ${d.pathLengthM.toFixed(0)}m, closure ${d.closureErrorM.toFixed(2)}m, `);
  out.write(`yaw ${d.yawSign > 0 ? "+" : "-"}1, orientation ${(d.orientationAgreement * 100).toFixed(1)}%\n`);
  out.write(`  corners    ${built.detected.length} detected -> ${built.corners.length} after overrides\n`);
  for (const w of d.warnings) out.write(`  warning: ${w}\n`);

  out.write("\n   T   entry    apex     exit    dir    sev  brakeOnset  throttleOn  minSpd\n");
  for (const c of built.corners) {
    const m = built.referenceLap.perCorner[String(c.index)]!;
    const fmt = (v: number | null): string => (v === null ? "     —  " : v.toFixed(4).padStart(8));
    out.write(
      `  ${String(c.index).padStart(2)}  ${c.entryPct.toFixed(4)}  ${c.apexPct.toFixed(4)}  ` +
        `${c.exitPct.toFixed(4)}  ${c.direction.padEnd(5)}  ${c.severity}   ${fmt(m.brakeOnsetPct)}    ` +
        `${fmt(m.throttleOnPct)}  ${(m.minSpeedMps * 3.6).toFixed(0).padStart(4)}kph\n`,
    );
  }

  if (args.svgPath !== null) {
    await writeFile(from(args.svgPath), renderMapSvg(built.map, built.referenceLap), "utf8");
    out.write(`\nwrote ${args.svgPath}\n`);
  }

  if (args.dryRun) {
    out.write("\ndry run — nothing written\n");
    return 0;
  }

  const repos = localRepositories(from(args.dataDir));
  await repos.trackMaps.put(built.map);
  await repos.referenceLaps.put(built.referenceLap);
  out.write(`\nwrote TrackMap and ReferenceLap under ${args.dataDir}\n`);

  return 0;
}

main().then(
  (code) => { process.exitCode = code; },
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
