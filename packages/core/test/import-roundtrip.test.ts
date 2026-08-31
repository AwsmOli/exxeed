import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ImportProfileSchema, TrackMapSchema, resolveProfile } from "../src/index.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const MAP = "data/tracks/iracing/192/road_course/v1/map.json";

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
const present = [MAP].every((p) => existsSync(`${REPO_ROOT}${p}`));
const describeWithData = present ? describe : describe.skip;

/**
 * The resolver, against real data.
 *
 * `import.test.ts` checks the resolver's rules on synthetic maps. This checks the
 * thing that cannot be checked synthetically: that a turn number and a sentence —
 * all stage 3 emits — land on the moment the sentence is *about*.
 *
 * That moment is the corner, and the resolver says so by placing the note at the
 * corner's entry. It does not read the words and it does not consult a braking
 * point: a note is a point and a message, so there is nothing in it that says
 * whether it is about braking, an overtaking spot or which gear to hold. The
 * author moves it afterwards, and that is what `leadAdjustS` and the editor are
 * for.
 *
 * What is worth checking against real data, then, is that the corner numbers
 * line up — that turn four in a track guide is turn four in our map. That is the
 * prerequisite §10 warns about, it is per-track, and it fails silently.
 *
 * The comparison is in metres, because that is the unit the error matters in. A
 * quarter of a percent of Daytona is fourteen metres; the same number at a kart
 * track is nothing.
 */
describeWithData("import round-trip against the hand-authored Daytona set", () => {
  it("lands every named turn on that turn in the real map", async () => {
    const map = TrackMapSchema.parse(await readJson(MAP));

    // Stage 3's output: a turn number and a sentence. Nothing about position,
    // and nothing about what kind of note it is — two of these are not about
    // braking at all, and the resolver treats all five identically.
    const profile = ImportProfileSchema.parse({
      schema: 1,
      source: { type: "manual", title: "Samba Racing MX-5 guide" },
      carClass: "mx5",
      callouts: [
        { turn: 1, text: "Brake at the black seam, seventy percent, second gear", textShort: "Black seam" },
        { turn: 4, text: "Brake as the second to last lamp post disappears", textShort: "Lamp post" },
        { turn: 6, text: "Good place to have a look down the inside", textShort: "Look inside" },
        { turn: 7, text: "Brake at the end of the road on the right", textShort: "Right slip road" },
        { turn: 9, throughTurn: 11, text: "Chicane, stay in third through here", textShort: "Stay third" },
      ],
    });

    const resolved = resolveProfile(profile, map);

    expect(resolved.unresolved).toEqual([]);
    expect(resolved.warnings).toEqual([]);
    expect(resolved.notes).toHaveLength(5);

    for (const [i, turn] of [1, 4, 6, 7, 9].entries()) {
      const entry = map.corners.find((c) => c.index === turn)!.entryPct;
      const errorM = (resolved.notes[i]!.pct - entry) * map.lengthM;
      expect(Math.abs(errorM)).toBeLessThan(1);
    }
  });

  /**
   * The prerequisite that fails silently.
   *
   * Daytona's twelve corners are numbered the way a coach numbers them, because
   * corners.override.json was written to make that true (§5.2). If detection
   * ever emitted only the corners it happened to find, "turn four" would resolve
   * to whatever was fourth in the list and every import would be quietly wrong.
   */
  it("has a corner list numbered the way a track guide numbers it", async () => {
    const map = TrackMapSchema.parse(await readJson(MAP));

    expect(map.corners.map((c) => c.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

    // In lap order, so turn n is genuinely the nth corner encountered.
    const pcts = map.corners.map((c) => c.entryPct);
    expect(pcts).toEqual([...pcts].sort((a, b) => a - b));
  });

  it("keeps every imported note dirty, so nothing plays a placeholder duration", async () => {
    const map = TrackMapSchema.parse(await readJson(MAP));

    const resolved = resolveProfile(
      ImportProfileSchema.parse({
        schema: 1,
        source: { type: "manual" },
        carClass: "mx5",
        callouts: [{ turn: 1, text: "Turn one, brake at the black seam", textShort: "Black seam" }],
      }),
      map,
    );

    expect(resolved.notes.every((n) => n.dirty)).toBe(true);
  });
});
