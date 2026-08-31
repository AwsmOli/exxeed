import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ImportProfileSchema,
  NoteSetSchema,
  ReferenceLapSchema,
  TrackMapSchema,
  resolveProfile,
} from "../src/index.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const MAP = "data/tracks/iracing/192/road_course/v1/map.json";
const LAP = "data/reflaps/iracing/192/road_course/mx5-mx52016.json";
const AUTHORED = "data/notesets/daytona-mx5-draft.json";

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(`${REPO_ROOT}${path}`, "utf8"));

/**
 * The map and the reference lap are generated artefacts, and .gitignore says so:
 * they fall out of `data/reference/daytona-2011-road-mx5-lap.ndjson`, which *is*
 * committed, plus the committed corners.override.json. So a clean checkout does
 * not have them until the pipeline has been run once, and this suite skips rather
 * than fails there — the alternative is committing 250 KB of derived data to
 * contradict a deliberate policy, or hand-writing a fake reference lap, which
 * would delete the only thing this test is for.
 *
 * Regenerate with:
 *   pnpm --filter @exxeed/trackmap exec exxeed-trackmap \
 *     data/reference/daytona-2011-road-mx5-lap.ndjson --track-id 192 --config road_course
 */
const present = [MAP, LAP, AUTHORED].every((p) => existsSync(`${REPO_ROOT}${p}`));
const describeWithData = present ? describe : describe.skip;

/**
 * The resolver, against real data.
 *
 * `import.test.ts` checks the resolver's rules on synthetic maps. This checks the
 * one thing that cannot be checked synthetically: whether turn numbers alone put a
 * callout where a person would have put it. The hand-authored Daytona MX-5 set was
 * written by reading a track guide and placing five notes by eye; the profile below
 * is those same five callouts stripped back to what stage 3 actually emits — a turn
 * number and a sentence. If the resolver reproduces the hand-placed positions from
 * that much, the import path works. If it does not, the failure is the interesting
 * result, not the test.
 *
 * The comparison is in metres, because that is the unit the error matters in. A
 * quarter of a percent of Daytona is fourteen metres, which is most of a braking
 * zone; the same number at a kart track is nothing.
 */
describeWithData("import round-trip against the hand-authored Daytona set", () => {
  it("places imported callouts within a few metres of where a person placed them", async () => {
    const map = TrackMapSchema.parse(
      await readJson(MAP),
    );
    const lap = ReferenceLapSchema.parse(
      await readJson(LAP),
    );
    const authored = NoteSetSchema.parse(await readJson(AUTHORED));

    // Stage 3's output for this video, had it existed: the sentences a person
    // wrote, and the turn each one is about. No positions.
    const profile = ImportProfileSchema.parse({
      schema: 1,
      source: authored.source,
      carClass: "mx5",
      callouts: [
        {
          turn: 1,
          text: authored.notes[0]!.text,
          textShort: authored.notes[0]!.textShort,
        },
        { turn: 4, text: authored.notes[1]!.text, textShort: authored.notes[1]!.textShort },
        { turn: 6, text: authored.notes[2]!.text, textShort: authored.notes[2]!.textShort },
        { turn: 7, text: authored.notes[3]!.text, textShort: authored.notes[3]!.textShort },
        // The bus stop is one callout over three corners, so it exercises the
        // range path — and the three share a braking zone, so anchoring at the
        // first is what makes that correct rather than merely tidy.
        {
          turn: 9,
          throughTurn: 11,
          text: authored.notes[4]!.text,
          textShort: authored.notes[4]!.textShort,
        },
      ],
    });

    const resolved = resolveProfile(profile, map, lap);

    expect(resolved.unresolved).toEqual([]);
    expect(resolved.notes).toHaveLength(5);
    // Every short form was supplied, and every turn had a measured onset, so
    // there is nothing for the resolver to guess about and nothing to warn about.
    expect(resolved.warnings).toEqual([]);

    const errorsM = resolved.notes.map((note, i) => {
      const authoredPct = authored.notes[i]!.pct;
      return (note.pct - authoredPct) * map.lengthM;
    });

    for (const error of errorsM) {
      // Within a car length and a half of the hand-placed point.
      expect(Math.abs(error)).toBeLessThan(5);
      // And consistently *later*: a person placing a note by eye leaves themselves
      // a margin before the measured onset, which the resolver does not. That is a
      // real difference in intent, not noise — the sign is the evidence for it, so
      // if it ever flips, the resolver has started doing something else.
      expect(error).toBeGreaterThan(0);
    }
  });

  it("keeps every imported note dirty, so nothing plays a placeholder duration", async () => {
    const map = TrackMapSchema.parse(
      await readJson(MAP),
    );
    const lap = ReferenceLapSchema.parse(
      await readJson(LAP),
    );

    const resolved = resolveProfile(
      ImportProfileSchema.parse({
        schema: 1,
        source: { type: "manual" },
        carClass: "mx5",
        callouts: [{ turn: 1, text: "Turn one, brake at the black seam", textShort: "Black seam" }],
      }),
      map,
      lap,
    );

    expect(resolved.notes.every((n) => n.dirty)).toBe(true);
  });
});
