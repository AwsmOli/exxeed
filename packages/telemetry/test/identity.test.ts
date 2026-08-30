import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { metres, mps, pct, radians, seconds } from "@exxeed/core";
import {
  NdjsonRecorder,
  ReplayAdapter,
  slug,
  TRK_LOC,
  type TelemetryFrame,
} from "@exxeed/telemetry";

const FIXTURE = fileURLToPath(new URL("./fixtures/synthetic-3laps.ndjson", import.meta.url));

const dir = mkdtempSync(join(tmpdir(), "exxeed-identity-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const IDENTITY = {
  // §4.0's key, which is what a note set or a track map is actually filed under.
  // Without it a recording says which track in words but not in the form
  // anything can look up.
  trackKey: { sim: "iracing" as const, trackId: 192, configId: "road-course" },
  trackId: "daytona-2011-road",
  trackName: "Daytona International Speedway",
  trackConfig: "Road Course",
  carId: "mx5-mx52016",
  carName: "Mazda MX-5 Cup",
};

const frame = (tMs: number): TelemetryFrame => ({
  tMs,
  sessionTimeS: seconds(tMs / 1000),
  lap: 1,
  lapDistPct: pct(0.5),
  speedMps: mps(40),
  throttle: 1,
  brake: 0,
  gear: 4,
  steerRad: radians(0),
  lat: 0,
  lon: 0,
  velocityXMps: mps(40),
  velocityYMps: mps(0),
  yawNorthRad: radians(1.2),
  lapDistM: metres(2000),
  isOnTrack: true,
  onPitRoad: false,
  isInGarage: false,
  playerTrackSurface: TRK_LOC.OnTrack,
  playerCarTowTime: 0,
  enterExitReset: 0,
});

describe("slug", () => {
  it("makes the sim's own ids safe to use as directory names", () => {
    expect(slug("daytona 2011 road")).toBe("daytona-2011-road");
    expect(slug("mx5 mx52016")).toBe("mx5-mx52016");
  });

  it("collapses runs of punctuation and trims the ends", () => {
    expect(slug("  Okayama -- Full  ")).toBe("okayama-full");
    expect(slug("Nürburgring/GP")).toBe("n-rburgring-gp");
  });
});

describe("recording identity", () => {
  it("round-trips track and car through the header", async () => {
    const path = join(dir, "labelled.ndjson");
    const recorder = new NdjsonRecorder(path, {
      startedAt: "2026-08-27T20:36:36.215Z",
      source: "iracing",
      ...IDENTITY,
    });
    recorder.write(frame(0));
    recorder.write(frame(16));
    await recorder.close();

    const adapter = new ReplayAdapter(path, { speed: 0 });
    await adapter.connect();
    expect(adapter.identity).toEqual(IDENTITY);
    await adapter.close();
  });

  it("still replays the frames it labelled", async () => {
    const path = join(dir, "frames.ndjson");
    const recorder = new NdjsonRecorder(path, {
      startedAt: "2026-08-27T20:36:36.215Z",
      source: "iracing",
      ...IDENTITY,
    });
    recorder.write(frame(0));
    recorder.write(frame(16));
    await recorder.close();

    // The header must not be emitted as a frame just because it now carries more.
    const adapter = new ReplayAdapter(path, { speed: 0 });
    await adapter.connect();
    const frames = [];
    for await (const f of adapter) frames.push(f);
    await adapter.close();

    expect(frames.map((f) => f.tMs)).toEqual([0, 16]);
  });

  it("creates the directory the recording is grouped into", async () => {
    const path = join(dir, IDENTITY.trackId, IDENTITY.carId, "nested.ndjson");
    const recorder = new NdjsonRecorder(path, {
      startedAt: "2026-08-27T20:36:36.215Z",
      source: "iracing",
      ...IDENTITY,
    });
    await recorder.close();

    const header: unknown = JSON.parse(readFileSync(path, "utf8").split("\n")[0]!);
    expect(header).toMatchObject({ kind: "meta", ...IDENTITY });
  });

  it("reports null rather than guessing for a recording written before labelling", async () => {
    // The committed fixture has a header with no track or car in it.
    const adapter = new ReplayAdapter(FIXTURE, { speed: 0 });
    await adapter.connect();
    expect(adapter.identity).toBeNull();
    await adapter.close();
  });
});
