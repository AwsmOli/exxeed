import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ImportProfileSchema,
  ReferenceLapSchema,
  TrackMapSchema,
  resolveProfile,
} from "../src/index.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const MAP = "data/tracks/iracing/192/road_course/v1/map.json";
const LAP = "data/reflaps/iracing/192/road_course/mx5-mx52016.json";

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
const present = [MAP, LAP].every((p) => existsSync(`${REPO_ROOT}${p}`));
const describeWithData = present ? describe : describe.skip;

/**
 * The resolver, against real data.
 *
 * `import.test.ts` checks the resolver's rules on synthetic maps. This checks the
 * thing that cannot be checked synthetically: that a turn number and a sentence —
 * all stage 3 emits — land on the moment the sentence is *about*.
 *
 * For "brake at the black seam" that moment is when braking starts, which the
 * reference lap measured. It is not corner entry: at Daytona those are 20 to 57
 * metres apart, and the trigger works backwards from the event so that speech
 * *finishes* there (§6.1). Anchor a braking callout at entry and it finishes
 * after the braking point has gone by, which is the one place it must not.
 *
 * The comparison is in metres, because that is the unit the error matters in. A
 * quarter of a percent of Daytona is fourteen metres, which is most of a braking
 * zone; the same number at a kart track is nothing.
 */
describeWithData("import round-trip against the hand-authored Daytona set", () => {
  it("puts a braking callout on the measured braking point", async () => {
    const map = TrackMapSchema.parse(await readJson(MAP));
    const lap = ReferenceLapSchema.parse(await readJson(LAP));

    // Stage 3's output: a turn number and a sentence. Nothing about position.
    const profile = ImportProfileSchema.parse({
      schema: 1,
      source: { type: "manual", title: "Samba Racing MX-5 guide" },
      carClass: "mx5",
      callouts: [
        { turn: 1, text: "Brake at the black seam, seventy percent, second gear", textShort: "Black seam" },
        { turn: 4, text: "Brake as the second to last lamp post disappears", textShort: "Lamp post" },
        { turn: 6, text: "Brake at the end of the road on the left", textShort: "Left slip road" },
        { turn: 7, text: "Brake at the end of the road on the right", textShort: "Right slip road" },
        { turn: 9, throughTurn: 11, text: "Chicane, brake at the one marker", textShort: "One marker" },
      ],
    });

    const resolved = resolveProfile(profile, map, lap);

    expect(resolved.unresolved).toEqual([]);
    expect(resolved.warnings).toEqual([]);
    expect(resolved.notes).toHaveLength(5);

    for (const [i, turn] of [1, 4, 6, 7, 9].entries()) {
      const onset = lap.perCorner[String(turn)]?.brakeOnsetPct;
      expect(onset).not.toBeUndefined();
      const errorM = (resolved.notes[i]!.pct - onset!) * map.lengthM;
      expect(Math.abs(errorM)).toBeLessThan(1);
    }
  });

  /**
   * The distinction the test above is really about, stated as a number.
   *
   * If these two ever coincide the resolver has stopped choosing and the first
   * test would pass for the wrong reason — so this asserts they are genuinely
   * far apart at this track, which is what makes anchoring a decision at all.
   */
  it("does not merely land on corner entry, which is tens of metres later", async () => {
    const map = TrackMapSchema.parse(await readJson(MAP));
    const lap = ReferenceLapSchema.parse(await readJson(LAP));

    for (const turn of [1, 4, 6, 7, 9]) {
      const onset = lap.perCorner[String(turn)]!.brakeOnsetPct!;
      const entry = map.corners.find((c) => c.index === turn)!.entryPct;
      const gapM = (entry - onset) * map.lengthM;
      expect(gapM).toBeGreaterThan(15);
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
