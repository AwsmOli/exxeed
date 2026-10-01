#!/usr/bin/env node
/**
 * Build track maps from Garage 61 laps, many tracks at a time.
 *
 *   pnpm --filter @exxeed/trackmap g61 --all            every Garage 61 track
 *   pnpm --filter @exxeed/trackmap g61 --track 297      one iRacing track id (repeatable)
 *
 *   --with-teammates   also use teammates' laps (default: only your own —
 *                      a teammate's lap is theirs to share)
 *   --data <dir>       artefact root, default the repo's data/
 *   --dry-run          say what would be built, write nothing
 *
 * The admin's side of sharing maps (TODO M8): the token stays on this machine
 * (GARAGE61_TOKEN, or supabase/.env), the maps are written locally, and the app
 * shares them on its next signed-in launch — so everyone else gets maps from
 * our database and never calls Garage 61. One lap per layout makes the map,
 * whatever the car; a reference lap is written too when the car is one the
 * catalog knows.
 *
 * Tracks that already have a map, here or shared, are skipped: the first map
 * per layout wins anyway, and skipping saves Garage 61's rate limit.
 */

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CornerOverridesSchema, type CornerOverrides, type TrackKey } from "@exxeed/core";
import { garage61LapCsv, garage61Laps, garage61Tracks, type Garage61Track } from "@exxeed/importer";
import {
  cloudConfig,
  createCloudClient,
  fetchMap,
  listCatalogCars,
  listLayouts,
  localRepositories,
} from "@exxeed/repo";
import { buildTrackMap, parseGarage61Csv, slug } from "@exxeed/telemetry";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

const USAGE = `usage: exxeed-g61-maps (--all | --track <iRacing track id> ...) [--with-teammates] [--data <dir>] [--dry-run]
`;

interface Args {
  readonly all: boolean;
  readonly trackIds: readonly number[];
  readonly withTeammates: boolean;
  readonly dataDir: string;
  readonly dryRun: boolean;
}

function parseArgs(argv: readonly string[]): Args | null {
  let all = false;
  let withTeammates = false;
  let dryRun = false;
  let dataDir = join(REPO_ROOT, "data");
  const trackIds: number[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--all") all = true;
    else if (arg === "--with-teammates") withTeammates = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--data") dataDir = resolve(process.env["INIT_CWD"] ?? process.cwd(), argv[++i] ?? "");
    else if (arg === "--track") {
      const id = Number(argv[++i]);
      if (!Number.isInteger(id) || id <= 0) throw new Error("--track takes an iRacing track id");
      trackIds.push(id);
    } else throw new Error(`unknown option ${arg}`);
  }
  if (!all && trackIds.length === 0) return null;
  return { all, trackIds, withTeammates, dataDir, dryRun };
}

/** The token: GARAGE61_TOKEN, or supabase/.env (gitignored). Never printed. */
function readToken(): string {
  const fromEnv = process.env["GARAGE61_TOKEN"];
  if (fromEnv) return fromEnv;
  const envFile = join(REPO_ROOT, "supabase", ".env");
  const match = existsSync(envFile) ? /^GARAGE61_TOKEN=["']?([^"'\n]+)/m.exec(readFileSync(envFile, "utf8")) : null;
  if (match?.[1] === undefined) throw new Error("no Garage 61 token: set GARAGE61_TOKEN or add it to supabase/.env");
  return match[1];
}

async function readOverrides(dataDir: string, key: TrackKey): Promise<CornerOverrides | undefined> {
  const path = join(dataDir, "tracks", key.sim, String(key.trackId), key.configId, "corners.override.json");
  try {
    return CornerOverridesSchema.parse(JSON.parse((await readFile(path, "utf8")).trimStart()));
  } catch {
    return undefined;
  }
}

const normalise = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const fmtLap = (s: number): string => `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, "0")}`;

async function main(): Promise<number> {
  let args: Args | null;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    return 2;
  }
  if (args === null) {
    process.stderr.write(USAGE);
    return 2;
  }

  const token = readToken();
  const out = (line: string): void => void process.stdout.write(`${line}\n`);
  const repos = localRepositories(args.dataDir);
  // Reading is public: no sign-in needed to see the catalog and shared maps.
  const memory = new Map<string, string>();
  const cloud = createCloudClient(cloudConfig(), {
    getItem: (k) => memory.get(k) ?? null,
    setItem: (k, v) => void memory.set(k, v),
    removeItem: (k) => void memory.delete(k),
  });

  const [g61Tracks, layouts, cars, localMaps] = await Promise.all([
    garage61Tracks(token),
    listLayouts(cloud),
    listCatalogCars(cloud),
    repos.trackMaps.listTracks(),
  ]);
  const wanted = (t: Garage61Track): boolean =>
    t.iracingTrackId !== null && (args.all || args.trackIds.includes(t.iracingTrackId));
  const tracks = g61Tracks.filter(wanted);
  out(`${tracks.length} track${tracks.length === 1 ? "" : "s"} to consider, using ${args.withTeammates ? "your and your teammates'" : "only your own"} laps${args.dryRun ? " (dry run)" : ""}`);

  let built = 0;
  for (const track of tracks) {
    const id = track.iracingTrackId!;
    const name = `${track.name}${track.variant ? ` — ${track.variant}` : ""}`;
    try {
      // The layout key by track id — the same rule as the app (canonicalTrackKey).
      const local = localMaps.find((m) => m.key.sim === "iracing" && m.key.trackId === id);
      if (local !== undefined) {
        out(`  ${name}: already mapped here`);
        continue;
      }
      const catalogued = layouts.find((l) => l.trackKey.sim === "iracing" && l.trackKey.trackId === id);
      const key: TrackKey = catalogued?.trackKey ?? {
        sim: "iracing",
        trackId: id,
        configId: slug(track.variant || track.name) || "default",
      };
      if ((await fetchMap(cloud, key).catch(() => null)) !== null) {
        out(`  ${name}: already shared`);
        continue;
      }

      const laps = await garage61Laps(token, track.id, null, { mineOnly: !args.withTeammates });
      const lap = laps[0];
      if (lap === undefined) {
        out(`  ${name}: no usable lap`);
        continue;
      }
      const car = cars.find((c) => normalise(c.name) === normalise(lap.car.name));
      if (args.dryRun) {
        out(`  ${name}: would map from ${fmtLap(lap.lapTimeS)} in the ${lap.car.name}${car ? "" : " (map only: car not in the catalog)"}`);
        continue;
      }

      const frames = parseGarage61Csv(await garage61LapCsv(token, lap.id));
      const overrides = await readOverrides(args.dataDir, key);
      const result = buildTrackMap(frames, {
        trackRef: { ...key, mapVersion: 1 },
        trackName: catalogued?.trackName ?? track.name,
        configName: catalogued?.configName ?? track.variant,
        carId: car?.carId ?? slug(lap.car.name),
        ...(catalogued?.lengthM != null ? { lengthM: catalogued.lengthM } : {}),
        ...(overrides !== undefined ? { overrides } : {}),
      });
      await repos.trackMaps.put(result.map);
      // A reference lap under a car id the sim never reports would be found by
      // nobody, so only for a car the catalog knows.
      if (car !== undefined) await repos.referenceLaps.put(result.referenceLap);
      built++;
      out(
        `  ${name}: mapped from ${fmtLap(lap.lapTimeS)} in the ${lap.car.name} — ${result.corners.length} corners, ` +
          `${result.map.lengthM.toFixed(0)} m, orientation ${(result.diagnostics.orientationAgreement * 100).toFixed(0)}%` +
          (car ? "" : " (map only)"),
      );
    } catch (err) {
      out(`  ${name}: failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  out(
    args.dryRun
      ? "dry run — nothing written"
      : `${built} map${built === 1 ? "" : "s"} written under ${args.dataDir}. Start the app signed in to share them.`,
  );
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
