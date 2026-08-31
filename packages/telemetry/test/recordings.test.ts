import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  describeRecording,
  importRecording,
  inspectRecording,
  listRecordings,
  parseMeta,
} from "../src/recordings.js";

const META = {
  kind: "meta",
  startedAt: "2026-08-27T20:43:48.649Z",
  source: "iracing",
  trackId: "daytona-2011-road",
  trackName: "Daytona International Speedway",
  trackConfig: "Road Course",
  carId: "mx5-mx52016",
  carName: "Mazda MX-5 Cup",
  lapTimeS: 135.392,
};

const frame = (tMs: number, lapDistPct: number, speedMps = 40): string =>
  JSON.stringify({
    tMs,
    sessionTimeS: tMs / 1000,
    lap: 1,
    lapDistPct,
    speedMps,
    throttle: 1,
    brake: 0,
    gear: 4,
    steerRad: 0,
    lat: 0,
    lon: 0,
    isOnTrack: true,
    onPitRoad: false,
    isInGarage: false,
    playerTrackSurface: 3,
    playerCarTowTime: 0,
    enterExitReset: 0,
  });

const recording = (count = 4): string[] => [
  JSON.stringify(META),
  ...Array.from({ length: count }, (_, i) => frame(i * 16, i * 0.001)),
];

describe("parseMeta", () => {
  it("reads the recorder's header", () => {
    expect(parseMeta(JSON.stringify(META))?.carName).toBe("Mazda MX-5 Cup");
  });

  it("returns null for a frame, a blank line, and unparseable text", () => {
    expect(parseMeta(frame(0, 0))).toBeNull();
    expect(parseMeta("")).toBeNull();
    expect(parseMeta(undefined)).toBeNull();
    expect(parseMeta("not json at all")).toBeNull();
  });
});

describe("inspectRecording", () => {
  it("accepts a recording the replay adapter can read", () => {
    const check = inspectRecording(recording());
    expect(check.ok).toBe(true);
    expect(check.problems).toEqual([]);
    expect(check.framesSampled).toBe(4);
    expect(check.meta?.trackId).toBe("daytona-2011-road");
  });

  it("accepts one with no meta header — that is an older lap, not a broken file", () => {
    const check = inspectRecording(recording().slice(1));
    expect(check.ok).toBe(true);
    expect(check.meta).toBeNull();
  });

  it("rejects a file with no frames in it", () => {
    const check = inspectRecording(["not a recording", "{}"]);
    expect(check.ok).toBe(false);
    expect(check.problems.join(" ")).toMatch(/not an Exxeed recording|readable/);
  });

  it("rejects a single frame, which has nothing to replay", () => {
    const check = inspectRecording([JSON.stringify(META), frame(0, 0.1)]);
    expect(check.ok).toBe(false);
    expect(check.problems.join(" ")).toContain("nothing to replay");
  });

  /**
   * The case the import button exists for. Every line here is a valid frame, so
   * anything checking only that the file parses passes it — and it replays as a
   * session where the car never moves, which looks exactly like a dead engine.
   */
  it("rejects a recording made with the car parked", () => {
    const parked = [
      JSON.stringify(META),
      ...Array.from({ length: 30 }, (_, i) => frame(i * 16, 0.4213, 0)),
    ];
    const check = inspectRecording(parked);
    expect(check.ok).toBe(false);
    expect(check.problems.join(" ")).toContain("never moves");
  });

  it("rejects lapDistPct recorded as a percentage rather than a fraction", () => {
    const percent = [JSON.stringify(META), frame(0, 12.5), frame(16, 12.9)];
    const check = inspectRecording(percent);
    expect(check.ok).toBe(false);
    expect(check.problems.join(" ")).toContain("0..1");
  });

  it("reports a bad frame among good ones rather than passing on the good ones", () => {
    const mixed = [...recording(), JSON.stringify({ tMs: "later", lapDistPct: 0.5 })];
    const check = inspectRecording(mixed);
    expect(check.ok).toBe(false);
    expect(check.problems.join(" ")).toContain("not readable");
  });
});

describe("describeRecording", () => {
  it("leads with track and car, because the stamp alone is unreadable", () => {
    const label = describeRecording({
      path: "daytona-2011-road/mx5-mx52016/2026-08-27T20-43-48-649Z.ndjson",
      meta: META,
      modifiedAt: "2026-08-27T20:43:48.649Z",
    });
    expect(label).toContain("Daytona International Speedway");
    expect(label).toContain("Road Course");
    expect(label).toContain("Mazda MX-5 Cup");
    expect(label).toContain("2:15.392");
  });

  it("falls back to the path when the file does not say what it is", () => {
    const label = describeRecording({
      path: "unknown/x.ndjson",
      meta: null,
      modifiedAt: "2026-08-27T20:43:48.649Z",
    });
    expect(label).toContain("unknown/x.ndjson");
  });
});

describe("the recordings folder", () => {
  let dir: string;
  let recordings: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "exxeed-rec-"));
    recordings = join(dir, "recordings");
    await mkdir(recordings, { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lists nothing, rather than throwing, when the folder does not exist", async () => {
    expect(await listRecordings(join(dir, "nope"))).toEqual([]);
  });

  it("walks the track/car grouping the recorder writes", async () => {
    const nested = join(recordings, "daytona-2011-road", "mx5-mx52016");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "a.ndjson"), recording().join("\n"));
    await writeFile(join(recordings, "loose.ndjson"), recording().join("\n"));
    await writeFile(join(recordings, "notes.txt"), "ignored");

    const listed = await listRecordings(recordings);
    expect(listed.map((r) => r.path).sort()).toEqual([
      "daytona-2011-road/mx5-mx52016/a.ndjson",
      "loose.ndjson",
    ]);
    expect(listed.find((r) => r.path.endsWith("a.ndjson"))?.meta?.carName).toBe("Mazda MX-5 Cup");
  });

  it("imports a good file into the recorder's own grouping", async () => {
    const source = join(dir, "downloaded.ndjson");
    await writeFile(source, recording().join("\n"));

    const result = await importRecording(source, recordings);
    expect(result.ok).toBe(true);
    expect(result.path).toBe("daytona-2011-road/mx5-mx52016/downloaded.ndjson");
    expect((await listRecordings(recordings)).map((r) => r.path)).toEqual([result.path]);
  });

  it("leaves the source where it was", async () => {
    const source = join(dir, "downloaded.ndjson");
    await writeFile(source, recording().join("\n"));
    await importRecording(source, recordings);
    // Copied, not moved: emptying a folder someone pointed at is not an import.
    expect(await listRecordings(dir)).toHaveLength(2);
  });

  it("puts a file with no identity somewhere findable rather than refusing it", async () => {
    const source = join(dir, "mystery.ndjson");
    await writeFile(source, recording().slice(1).join("\n"));

    const result = await importRecording(source, recordings);
    expect(result.ok).toBe(true);
    expect(result.path).toBe("imported/mystery.ndjson");
  });

  it("never overwrites a lap already in the folder", async () => {
    const source = join(dir, "lap.ndjson");
    await writeFile(source, recording().join("\n"));

    const first = await importRecording(source, recordings);
    const second = await importRecording(source, recordings);
    expect(first.path).toBe("daytona-2011-road/mx5-mx52016/lap.ndjson");
    expect(second.path).toBe("daytona-2011-road/mx5-mx52016/lap-2.ndjson");
    expect(await listRecordings(recordings)).toHaveLength(2);
  });

  it("copies nothing when the file will not replay", async () => {
    const source = join(dir, "parked.ndjson");
    await writeFile(
      source,
      [JSON.stringify(META), frame(0, 0.5, 0), frame(16, 0.5, 0)].join("\n"),
    );

    const result = await importRecording(source, recordings);
    expect(result.ok).toBe(false);
    expect(result.path).toBeUndefined();
    expect(await listRecordings(recordings)).toEqual([]);
  });
});
