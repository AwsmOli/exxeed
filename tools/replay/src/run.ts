/**
 * The replay run loop — SPEC.md §9.
 *
 * Separated from the CLI so golden-file tests can drive it directly. "Golden-file
 * tests assert exact fire points for a checked-in recording. Any change to the
 * trigger math that moves a fire point shows up as a diff."
 */

import { resolve } from "node:path";

import type { DriverProfile, NoteSet, TrackMap } from "@exxeed/core";
import {
  indexLandmarks,
  metres,
  NoteEngine,
  resolveNotes,
  type LandmarkIndex,
} from "@exxeed/core";
import { localRepositories } from "@exxeed/repo";
import { ReplayAdapter, toTickInput } from "@exxeed/telemetry";

import { formatEvent } from "./timeline.js";

export interface RunOptions {
  readonly recordingPath: string;
  readonly speed?: number;
  readonly noteSetId?: string | null;
  readonly dataDir?: string;
  readonly leadAdjustS?: number;
  /** Called for every timeline line, in order. */
  readonly onLine?: (line: string) => void;
}

export interface RunSummary {
  readonly frames: number;
  readonly crossings: number;
  readonly played: number;
  readonly dropped: number;
  readonly lines: readonly string[];
  readonly warnings: readonly string[];
}

export async function loadEngine(
  dataDir: string,
  noteSetId: string,
  profile: DriverProfile,
): Promise<{ engine: NoteEngine; warnings: string[] }> {
  const repos = localRepositories(dataDir);

  const noteSet: NoteSet | null = await repos.noteSets.get(noteSetId);
  if (noteSet === null) throw new Error(`no note set "${noteSetId}" under ${dataDir}`);

  const map: TrackMap | null = await repos.trackMaps.get(noteSet.trackRef);
  if (map === null) throw new Error(`no track map for ${JSON.stringify(noteSet.trackRef)}`);

  // Optional — see the note in apps/desktop/src/session.ts. A set anchored
  // entirely to corners needs no inventory, and a missing one degrades to
  // unresolvable anchors on the notes that wanted a landmark, not to a refusal.
  const inventory = await repos.landmarks.get(noteSet.trackRef);
  const landmarks: LandmarkIndex = inventory === null ? new Map() : indexLandmarks(inventory);

  const { resolved, unresolved } = resolveNotes(noteSet.notes, map, landmarks);

  // Unresolvable notes are a data problem, and silently dropping them is how a
  // note set ends up quietly half-working. Say so once, at load.
  const warnings = unresolved.map(
    (note) => `note "${note.id}" has an unresolvable anchor, skipping`,
  );

  return { engine: new NoteEngine(resolved, metres(map.lengthM), profile), warnings };
}

export async function run(options: RunOptions): Promise<RunSummary> {
  const lines: string[] = [];
  let warnings: string[] = [];
  let engine: NoteEngine | null = null;

  if (options.noteSetId != null) {
    const loaded = await loadEngine(
      resolve(options.dataDir ?? "data"),
      options.noteSetId,
      { leadAdjustS: options.leadAdjustS ?? 0 },
    );
    engine = loaded.engine;
    warnings = loaded.warnings;
  }

  const source = new ReplayAdapter(options.recordingPath, { speed: options.speed ?? 0 });
  await source.connect();

  let frames = 0;
  let crossings = 0;
  let played = 0;
  let dropped = 0;
  let lastPct = 0;

  try {
    for await (const frame of source) {
      frames++;
      // A crossing is a jump back across the line, not any backwards movement:
      // a car sitting still near start/finish jitters over it thousands of times
      // and would otherwise report thousands of laps. Half a lap is the same
      // threshold §6.2 re-arms on.
      if (lastPct - frame.lapDistPct > 0.5) crossings++;
      lastPct = frame.lapDistPct;

      if (engine === null) continue;

      for (const event of engine.tick(toTickInput(frame)).events) {
        if (event.kind === "play") played++;
        else dropped++;

        const line = formatEvent(event, frame.lap);
        lines.push(line);
        options.onLine?.(line);
      }
    }
  } finally {
    await source.close();
  }

  return { frames, crossings, played, dropped, lines, warnings };
}
