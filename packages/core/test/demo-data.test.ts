import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { NoteSetSchema, TrackMapSchema } from "../src/index.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(`${REPO_ROOT}${path}`, "utf8"));

/**
 * The committed demo artefacts, parsed as the app parses them.
 *
 * This exists because a schema change once passed every test and still broke the
 * app on launch: `baselineCarId` became a string, the in-code fixture in
 * fixtures.ts was updated with it, and `data/demo/.../map.json` was not. Nothing
 * read that file except the running app, so "could not list note sets" was the
 * first anyone heard of it.
 *
 * A fixture that mirrors the shipped data is not the shipped data. These are
 * checked in, they are what a fresh clone runs against, and they are small — so
 * the schemas get pointed at the actual bytes.
 */
describe("the committed demo artefacts still parse", () => {
  it("parses the Spa track map", async () => {
    const map = await readJson("data/demo/tracks/iracing/266/grand_prix/v3/map.json");
    expect(() => TrackMapSchema.parse(map)).not.toThrow();
  });

  it("parses the Spa note set", async () => {
    const noteSet = await readJson("data/demo/notesets/spa-gt3-fixture.json");
    expect(() => NoteSetSchema.parse(noteSet)).not.toThrow();
  });
});
