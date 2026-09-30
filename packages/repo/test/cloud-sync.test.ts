/**
 * Map and reference-lap sync against the local Supabase stack (M8 step 2).
 *
 * Integration, not unit: it runs the real RPCs and RLS. Skipped when the local
 * stack is not running (`pnpm db:start`), like the other tests that need
 * something outside the repo.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ReferenceLap, TrackMap } from "@exxeed/core";
import { trackKeyOf } from "@exxeed/core";
import { localRepositories, pullTrack, pushMap, shareLocalTracks, type CloudClient } from "@exxeed/repo";

import { spaMap } from "../../core/test/fixtures.js";
import { anonClient as client, driver, removeDriver, serviceDelete, stackUp } from "./local-stack.js";

describe.skipIf(!stackUp)("cloud sync of maps and reference laps", () => {
  // A layout no real track uses, fresh per run, so first-map-wins from an
  // earlier run cannot decide this one.
  const trackId = 900000 + Math.floor(Math.random() * 99999);
  const map: TrackMap = {
    ...spaMap,
    trackRef: { sim: "iracing", trackId, configId: "test-layout", mapVersion: 1 },
    trackName: "Sync Test Circuit",
    configName: "Test",
  };
  const key = trackKeyOf(map.trackRef);
  const lap = (lapTimeS: number): ReferenceLap => ({
    trackKey: key,
    carId: "sync-test-car",
    lapTimeS,
    gridSize: 4,
    channels: {
      speedMps: [60, 30, 45, 70],
      throttle: [1, 0, 0.5, 1],
      brake: [0, 0.9, 0, 0],
      gear: [6, 3, 4, 6],
      steerRad: [0, 0.4, 0.2, 0],
      elapsedS: [0, 34.6, 69.2, lapTimeS * 0.75],
    },
    derivedForMapVersion: 1,
    perCorner: {},
    brakeChannelInferred: false,
  });

  const dirs: string[] = [];
  const drivers: string[] = [];
  const dir = async (): Promise<string> => {
    const d = await mkdtemp(join(tmpdir(), "exxeed-sync-"));
    dirs.push(d);
    return d;
  };

  let alice: CloudClient;
  let bob: CloudClient;

  beforeAll(async () => {
    const stamp = Date.now();
    const a = await driver(`alice-${stamp}@example.test`);
    const b = await driver(`bob-${stamp}@example.test`);
    drivers.push(a.id, b.id);
    alice = a.client;
    bob = b.client;
  });

  afterAll(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    await Promise.all(drivers.map(removeDriver));
    // Leave the local catalog as it was: children first, for the foreign keys.
    for (const table of ["reference_laps", "track_maps", "track_layouts"]) {
      await serviceDelete(table, `track_id=eq.${trackId}`);
    }
    await serviceDelete("cars", "car_id=eq.sync-test-car");
  });

  it("shares a map cut on one machine, and keeps the first one for the layout", async () => {
    const aliceRepos = localRepositories(await dir());
    await aliceRepos.trackMaps.put(map);
    await aliceRepos.referenceLaps.put(lap(140));

    const first = await shareLocalTracks(alice, aliceRepos, () => "Sync Test Car");
    expect(first).toEqual({ maps: 1, referenceLaps: 1, skipped: [] });

    // Bob cut his own map of the same layout, with different corners, and drove
    // it faster.
    const bobRepos = localRepositories(await dir());
    await bobRepos.trackMaps.put({ ...map, corners: map.corners.slice(0, 1) });
    await bobRepos.referenceLaps.put(lap(138));

    const second = await shareLocalTracks(bob, bobRepos, () => "Sync Test Car");
    expect(second.maps).toBe(0);
    expect(second.referenceLaps).toBe(1);
  });

  it("fills in a machine that has never driven the track, signed out", async () => {
    const repos = localRepositories(await dir());
    const pulled = await pullTrack(client(), repos, key);
    expect(pulled).toEqual({ map: true, referenceLaps: 1 });

    // Alice's map, because it was first — not Bob's one-corner cut.
    const got = await repos.trackMaps.get(map.trackRef);
    expect(got?.corners).toHaveLength(map.corners.length);
    // Bob's lap, because it was faster.
    expect((await repos.referenceLaps.get(key, "sync-test-car"))?.lapTimeS).toBe(138);

    // Nothing left to fetch the second time.
    expect(await pullTrack(client(), repos, key)).toEqual({ map: false, referenceLaps: 0 });
  });

  it("never replaces a map this machine already has", async () => {
    const repos = localRepositories(await dir());
    const mine = { ...map, corners: map.corners.slice(0, 1) };
    await repos.trackMaps.put(mine);
    await pullTrack(client(), repos, key);
    expect((await repos.trackMaps.get(map.trackRef))?.corners).toHaveLength(1);
  });

  it("refuses to take a map from someone who is not signed in", async () => {
    // Refused before the function body runs: anon has no execute grant at all.
    await expect(pushMap(client(), map)).rejects.toThrow(/permission denied/);
  });

  it("skips a map that was cut before tracks had names", async () => {
    const repos = localRepositories(await dir());
    await repos.trackMaps.put({ ...map, trackName: `track ${trackId}` });
    const result = await shareLocalTracks(alice, repos, () => "Sync Test Car");
    expect(result.maps).toBe(0);
    expect(result.skipped).toHaveLength(1);
  });
});
