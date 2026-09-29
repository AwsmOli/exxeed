/**
 * What the app knows about a track beyond its map: the corners described the
 * way a driver meets them, and the official turn numbering it has learned.
 *
 * Both exist so that importing a guide needs nobody to write anything by hand.
 * The map's corner numbers are detection's, not the track's; rather than a
 * person reconciling the two in a `corners.override.json`, the prompt describes
 * each corner (prompt.ts) and the model matches by description, and the number
 * the coach used comes back and is kept here. After the first guide, the
 * official numbering is simply known.
 *
 * `turn-numbers.json` sits beside the map in the track's folder, is written only
 * by the app, and never changes the map — the map's `index` stays what note sets
 * and imports anchor to (§4.0), and this is a label on top of it.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { BRAKE_SEARCH_M, type ReferenceLap, type TrackKey, type TrackMap } from "@exxeed/core";
import type { PromptCorner } from "@exxeed/importer";
import { localRepositories } from "@exxeed/repo";

interface TurnNumbersFile {
  readonly schema: 1;
  /** Our corner index → official turn number. */
  readonly turns: Readonly<Record<string, number>>;
  /** The videos the numbers were learned from, for anyone wondering why. */
  readonly learnedFrom: readonly string[];
}

const numbersPath = (dataDir: string, key: TrackKey): string =>
  join(dataDir, "tracks", key.sim, String(key.trackId), key.configId, "turn-numbers.json");

export async function readTurnNumbers(dataDir: string, key: TrackKey): Promise<TurnNumbersFile> {
  try {
    const raw = JSON.parse(await readFile(numbersPath(dataDir, key), "utf8")) as Partial<TurnNumbersFile>;
    return { schema: 1, turns: raw.turns ?? {}, learnedFrom: raw.learnedFrom ?? [] };
  } catch {
    return { schema: 1, turns: {}, learnedFrom: [] };
  }
}

export async function writeTurnNumbers(
  dataDir: string,
  key: TrackKey,
  turns: Readonly<Record<string, number>>,
  videoId: string,
): Promise<void> {
  const current = await readTurnNumbers(dataDir, key);
  const next: TurnNumbersFile = {
    schema: 1,
    turns,
    learnedFrom: current.learnedFrom.includes(videoId) ? current.learnedFrom : [...current.learnedFrom, videoId],
  };
  await writeFile(numbersPath(dataDir, key), `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

/** The reference lap to describe corners from: this car's if there is one, any otherwise. */
async function referenceFor(dataDir: string, key: TrackKey, carId: string | null): Promise<ReferenceLap | null> {
  const repos = localRepositories(dataDir);
  const cars = await repos.referenceLaps.listCars(key);
  const chosen = carId !== null && cars.includes(carId) ? carId : cars[0];
  if (chosen === undefined) return null;
  try {
    return await repos.referenceLaps.get(key, chosen);
  } catch {
    // An unreadable lap costs the descriptions their braking and speed, no more.
    return null;
  }
}

/**
 * Every corner on the map, described for the prompt.
 *
 * The reference lap supplies what a coach talks about — where braking starts,
 * how slow, which gear — and without one the corners are still described by
 * position, direction and tightness, which is enough to match most guides.
 */
export async function describeCorners(
  dataDir: string,
  key: TrackKey,
  map: TrackMap,
  carId: string | null,
): Promise<PromptCorner[]> {
  const reference = await referenceFor(dataDir, key, carId);
  const numbers = (await readTurnNumbers(dataDir, key)).turns;
  const length = map.lengthM;

  return map.corners.map((c) => {
    const metrics = reference?.perCorner[String(c.index)];
    const onset = metrics?.brakeOnsetPct ?? null;
    // Forward distance from the onset to turn-in, wrap-safe; braking that starts
    // after turn-in (trail into a long corner) reads as "at turn-in".
    const raw = onset === null ? null : Math.max(0, ((((c.entryPct - onset) % 1) + 1.5) % 1 - 0.5) * length);
    // brakeOnsetPct searches back 300 m and clamps there (onsets.ts), so a value
    // at the edge is the window, not a braking point — and "brakes 301 m before"
    // would send the model looking for a board that is not there.
    const before = raw !== null && raw >= BRAKE_SEARCH_M - 10 ? null : raw;
    const grid = reference?.gridSize ?? 0;
    const gear = reference === null ? null : (reference.channels.gear[Math.floor(c.apexPct * grid)] ?? null);
    return {
      id: c.index,
      names: c.names,
      direction: c.direction,
      severity: c.severity,
      entryM: c.entryPct * length,
      officialTurn: numbers[String(c.index)] ?? null,
      brakeBeforeM: before,
      minSpeedKph: metrics === undefined ? null : metrics.minSpeedMps * 3.6,
      gear,
    };
  });
}
