/**
 * The replay run loop — SPEC.md §9.
 *
 * Separated from the CLI so golden-file tests can drive it directly. "Golden-file
 * tests assert exact fire points for a checked-in recording. Any change to the
 * trigger math that moves a fire point shows up as a diff."
 */

import { resolve } from "node:path";

import type { DriverProfile, NoteSet } from "@exxeed/core";
import { metres, NoteEngine } from "@exxeed/core";
import { localRepositories } from "@exxeed/repo";
import { ReplayAdapter, toTickInput } from "@exxeed/telemetry";

import { formatEvent } from "./timeline.js";

export interface RunOptions {
  readonly recordingPath: string;
  readonly speed?: number;
  readonly noteSetId?: string | null;
  readonly dataDir?: string;
  readonly leadAdjustS?: number;
  /**
   * Speak from the first frame instead of waiting out an out-lap.
   *
   * A recording of one extracted lap starts mid-session, so §6.4's out-lap gate
   * suppresses the whole thing and the replay prints "0 spoken" — correct, and
   * indistinguishable from a broken engine. This is what makes a single-lap
   * reference recording usable as a test case at all.
   */
  readonly skipOutLap?: boolean;
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
  skipOutLap = false,
): Promise<{ engine: NoteEngine; warnings: string[]; labels: Map<string, string> }> {
  const repos = localRepositories(dataDir);

  const noteSet: NoteSet | null = await repos.noteSets.get(noteSetId);
  if (noteSet === null) throw new Error(`no note set "${noteSetId}" under ${dataDir}`);

  // No TrackMap, no LandmarkInventory: a note is a point and a message (§4.4),
  // and the note set carries the one bit of geometry the engine needs.
  return {
    engine: new NoteEngine(noteSet.notes, metres(noteSet.lengthM), profile, {
      assumeLapComplete: skipOutLap,
    }),
    warnings: [],
    // For the timeline: an opaque id is the right thing to store and the wrong
    // thing to read. The short form is what the column is for.
    labels: new Map(noteSet.notes.map((n) => [n.id, n.textShort])),
  };
}

export async function run(options: RunOptions): Promise<RunSummary> {
  const lines: string[] = [];
  let warnings: string[] = [];
  let engine: NoteEngine | null = null;
  let labels = new Map<string, string>();

  if (options.noteSetId != null) {
    const loaded = await loadEngine(
      resolve(options.dataDir ?? "data"),
      options.noteSetId,
      { leadAdjustS: options.leadAdjustS ?? 0 },
      options.skipOutLap ?? false,
    );
    engine = loaded.engine;
    warnings = loaded.warnings;
    labels = loaded.labels;
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

        const line = formatEvent(event, frame.lap, (id) => labels.get(id) ?? id);
        lines.push(line);
        options.onLine?.(line);
      }
    }
  } finally {
    await source.close();
  }

  return { frames, crossings, played, dropped, lines, warnings };
}
