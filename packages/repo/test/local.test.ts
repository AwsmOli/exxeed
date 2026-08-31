import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ReferenceLap, TrackMap } from "@exxeed/core";
import { trackKeyOf } from "@exxeed/core";
import { localRepositories, type Repositories } from "@exxeed/repo";

import { spaGt3Notes, spaLandmarks, spaMap } from "../../core/test/fixtures.js";

let root: string;
let repos: Repositories;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "exxeed-repo-"));
  repos = localRepositories(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const refLap = (carId: string): ReferenceLap => ({
  trackKey: trackKeyOf(spaMap.trackRef),
  carId,
  lapTimeS: 138.42,
  gridSize: 4,
  channels: {
    speedMps: [60, 30, 45, 70],
    throttle: [1, 0, 0.5, 1],
    brake: [0, 0.9, 0, 0],
    gear: [6, 3, 4, 6],
    steerRad: [0, 0.4, 0.2, 0],
    elapsedS: [0, 34.6, 69.2, 103.8],
  },
  derivedForMapVersion: 3,
  perCorner: { "1": { brakeOnsetPct: 0.99612, throttleOnPct: 0.01931, minSpeedMps: 17.2 } },
  brakeChannelInferred: false,
});

describe("round-tripping artefacts", () => {
  it("stores and reads a track map by TrackRef", async () => {
    await repos.trackMaps.put(spaMap);
    const read = await repos.trackMaps.get(spaMap.trackRef);
    expect(read?.trackName).toBe("Circuit de Spa-Francorchamps");
    expect(read?.corners).toHaveLength(2);
  });

  it("returns null for an absent artefact instead of throwing", async () => {
    expect(await repos.trackMaps.get(spaMap.trackRef)).toBeNull();
    expect(await repos.landmarks.get(spaMap.trackRef)).toBeNull();
    expect(await repos.noteSets.get("nope")).toBeNull();
    expect(await repos.referenceLaps.get(trackKeyOf(spaMap.trackRef), "ferrari296gt3")).toBeNull();
  });

  it("validates on read, so a corrupted file fails at the boundary not at 60 Hz", async () => {
    const broken = { ...spaMap, lengthM: -1 } as TrackMap;
    await expect(repos.trackMaps.put(broken)).rejects.toThrow();
  });

  it("stores and reads a landmark inventory, keeping the wrapped landmark intact", async () => {
    await repos.landmarks.put(spaLandmarks);
    const read = await repos.landmarks.get(spaMap.trackRef);
    expect(read?.landmarks.find((l) => l.id === "t1_board_100")?.pct).toBeCloseTo(0.99781, 6);
  });
});

describe("map versioning", () => {
  it("keys track maps by mapVersion, so two cuts coexist", async () => {
    const v4: TrackMap = { ...spaMap, trackRef: { ...spaMap.trackRef, mapVersion: 4 } };
    await repos.trackMaps.put(spaMap);
    await repos.trackMaps.put(v4);

    expect((await repos.trackMaps.get(spaMap.trackRef))?.trackRef.mapVersion).toBe(3);
    expect((await repos.trackMaps.get(v4.trackRef))?.trackRef.mapVersion).toBe(4);
    expect(await repos.trackMaps.latestVersion(trackKeyOf(spaMap.trackRef))).toBe(4);
  });

  it("keeps reference laps addressable after the map is re-cut", async () => {
    // SPEC.md §4.0: ReferenceLap is keyed by TrackKey, NOT TrackRef. Re-cutting
    // the map must not orphan laps you already drove.
    const key = trackKeyOf(spaMap.trackRef);
    await repos.referenceLaps.put(refLap("ferrari296gt3"));

    await repos.trackMaps.put({ ...spaMap, trackRef: { ...spaMap.trackRef, mapVersion: 9 } });

    const stillThere = await repos.referenceLaps.get(key, "ferrari296gt3");
    expect(stillThere?.lapTimeS).toBeCloseTo(138.42, 6);
    // The lap knows which numbering its perCorner was derived against, so callers
    // can tell it is stale and recompute rather than trusting it.
    expect(stillThere?.derivedForMapVersion).toBe(3);
  });

  it("separates reference laps by car", async () => {
    const key = trackKeyOf(spaMap.trackRef);
    await repos.referenceLaps.put(refLap("ferrari296gt3"));
    await repos.referenceLaps.put({ ...refLap("porsche992r"), lapTimeS: 155.1 });

    expect((await repos.referenceLaps.get(key, "ferrari296gt3"))?.lapTimeS).toBeCloseTo(138.42, 6);
    expect((await repos.referenceLaps.get(key, "porsche992r"))?.lapTimeS).toBeCloseTo(155.1, 6);
  });
});

describe("note set listing", () => {
  it("lists only sets for the requested track", async () => {
    await repos.noteSets.put(spaGt3Notes);
    await repos.noteSets.put({
      ...spaGt3Notes,
      id: "spa-other-track",
      trackKey: { sim: "iracing", trackId: 999, configId: "grand_prix" },
    });

    // Keyed by TrackKey, not TrackRef: a note set holds lap positions, so
    // re-cutting the map cannot orphan it (§4.0, §4.4).
    const current = await repos.noteSets.listForTrack(trackKeyOf(spaMap.trackRef));
    expect(current.map((s) => s.id)).toEqual(["spa-gt3-fixture"]);
  });

  it("filters by car class", async () => {
    await repos.noteSets.put(spaGt3Notes);
    await repos.noteSets.put({ ...spaGt3Notes, id: "spa-mx5", carClass: "mx5" });

    expect(await repos.noteSets.listForTrack(trackKeyOf(spaMap.trackRef), "gt3")).toHaveLength(1);
    expect(await repos.noteSets.listForTrack(trackKeyOf(spaMap.trackRef), "mx5")).toHaveLength(1);
    expect(await repos.noteSets.listForTrack(trackKeyOf(spaMap.trackRef))).toHaveLength(2);
  });

  it("summarises without loading notes into the listing", async () => {
    await repos.noteSets.put(spaGt3Notes);
    const [summary] = await repos.noteSets.listForTrack(trackKeyOf(spaMap.trackRef));
    expect(summary?.noteCount).toBe(2);
    expect(summary).not.toHaveProperty("notes");
  });
});
