import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { run } from "../src/run.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const RECORDING = `${REPO_ROOT}packages/telemetry/test/fixtures/synthetic-3laps.ndjson`;
const DATA = `${REPO_ROOT}data/demo`;
const GOLDEN = fileURLToPath(new URL("./golden/spa-gt3-synthetic.txt", import.meta.url));

/**
 * SPEC.md §9: "Golden-file tests assert exact fire points for a checked-in
 * recording. Any change to the trigger math that moves a fire point shows up as a
 * diff."
 *
 * The recording here is the synthetic 3-lap loop, not a real lap — so this freezes
 * the ENGINE's behaviour, not whether the callouts are any good. It will be
 * rebaselined against a real Okayama lap once M0b produces one, and at that point
 * it starts saying something about the driving too.
 *
 * Regenerate deliberately with UPDATE_GOLDEN=1, never by reflex: a changed line
 * means a callout moved, which is the thing this test exists to make you look at.
 */
describe("replay timeline golden file", () => {
  it("matches the checked-in timeline exactly", async () => {
    const summary = await run({
      recordingPath: RECORDING,
      speed: 0,
      noteSetId: "spa-gt3-fixture",
      dataDir: DATA,
    });

    const actual = `${summary.lines.join("\n")}\n`;

    if (process.env["UPDATE_GOLDEN"] === "1") {
      await writeFile(GOLDEN, actual, "utf8");
    }

    expect(actual).toBe(await readFile(GOLDEN, "utf8"));
  });

  it("is deterministic across runs", async () => {
    const once = await run({ recordingPath: RECORDING, noteSetId: "spa-gt3-fixture", dataDir: DATA });
    const twice = await run({ recordingPath: RECORDING, noteSetId: "spa-gt3-fixture", dataDir: DATA });

    expect(once.lines).toEqual(twice.lines);
  });

  it("reads every frame of the recording", async () => {
    const summary = await run({ recordingPath: RECORDING, noteSetId: "spa-gt3-fixture", dataDir: DATA });

    expect(summary.frames).toBe(900);
    expect(summary.crossings).toBe(2);
  });

  it("runs with no note set, emitting no timeline", async () => {
    const summary = await run({ recordingPath: RECORDING });

    expect(summary.frames).toBe(900);
    expect(summary.lines).toEqual([]);
  });
});
