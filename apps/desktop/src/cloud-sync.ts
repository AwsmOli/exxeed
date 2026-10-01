/**
 * When the app talks to the cloud about tracks — TODO.md M8 step 2.
 *
 * The mechanics are in @exxeed/repo (cloud/sync.ts); this decides when:
 *  - **before a session**: report the layout and car to the catalog, and pull
 *    the map and reference laps if this machine has none — so a track someone
 *    else has driven is mapped here before the first lap, and the auto-mapper
 *    does not cut a competing one;
 *  - **after the auto-mapper cuts** a map or a faster reference lap: share it;
 *  - **on sign-in**: offer every map already on this machine, once per launch
 *    — the maps cut before sync existed;
 *  - **when the editor opens a set with no map**: pull it.
 *
 * Every failure is logged and swallowed. The cloud is an addition: offline, the
 * app does exactly what it did before M8.
 */

import {
  layoutForTrackId,
  localRepositories,
  pullTrack,
  pushMap,
  pushReferenceLap,
  reportSession,
  shareLocalTracks,
} from "@exxeed/repo";
import type { SessionIdentity } from "@exxeed/telemetry";
import type { TrackKey } from "@exxeed/core";

import { accountView, cloudClient } from "./account.js";
import type { AutoMapEvent } from "./auto-map.js";

type Log = (line: string) => void;

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The key this app files a layout under, for a key the sim reported.
 *
 * iRacing gives every layout its own track id, but our key also carries a
 * layout id slugged from a *name*, and names differ by source: the sim says
 * "300 Circuit", Garage 61 says "300". A map imported from Garage 61 is filed
 * under the second; without this, the sim's key would find no map and the
 * auto-mapper would cut a second one. So a track id already known here, or in
 * the catalog, keeps the layout id it was first given.
 */
export async function canonicalTrackKey(dataDir: string, key: TrackKey): Promise<TrackKey> {
  const local = (await localRepositories(dataDir).trackMaps.listTracks()).find(
    (t) => t.key.sim === key.sim && t.key.trackId === key.trackId,
  );
  if (local !== undefined) return local.key;
  const known = await layoutForTrackId(cloudClient(), key.sim, key.trackId).catch(() => null);
  return known === null ? key : { ...key, configId: known };
}

/**
 * Before the session loads its note set. Awaited, but bounded by the sync
 * module's timeouts, so a dead network costs seconds, not the session.
 */
export async function syncBeforeSession(dataDir: string, identity: SessionIdentity | null, log: Log): Promise<void> {
  const key = identity?.trackKey;
  if (identity === null || key == null) return;

  if (accountView().signedIn) {
    try {
      await reportSession(cloudClient(), {
        trackKey: key,
        trackName: identity.trackName,
        configName: identity.trackConfig,
        lengthM: null,
        carId: identity.carId,
        carName: identity.carName,
      });
    } catch (err) {
      log(`could not report this session to the catalog: ${message(err)}\n`);
    }
  }

  await pullForTrack(dataDir, key, log);
}

/** Fill in a missing map and reference laps for a layout. Works signed out. */
export async function pullForTrack(dataDir: string, key: TrackKey, log: Log): Promise<boolean> {
  try {
    const pulled = await pullTrack(cloudClient(), localRepositories(dataDir), key);
    if (pulled.map) log(`fetched the map for track ${key.trackId}/${key.configId} from Exxeed\n`);
    if (pulled.referenceLaps > 0) {
      log(`fetched ${pulled.referenceLaps} reference lap${pulled.referenceLaps === 1 ? "" : "s"} for track ${key.trackId}/${key.configId}\n`);
    }
    return pulled.map || pulled.referenceLaps > 0;
  } catch (err) {
    log(`could not check Exxeed for a map of track ${key.trackId}/${key.configId}: ${message(err)}\n`);
    return false;
  }
}

/** The auto-mapper cut a map, or found a faster reference lap. */
export async function shareCut(event: AutoMapEvent, log: Log): Promise<void> {
  if (!accountView().signedIn) return;
  const client = cloudClient();
  try {
    if (event.kind === "mapped") {
      const result = await pushMap(client, event.map);
      log(
        result.accepted
          ? `shared the map of ${event.map.trackName} — the next driver there gets it automatically\n`
          : `someone already shared a map of ${event.map.trackName}; keeping yours locally\n`,
      );
    }
    if (await pushReferenceLap(client, event.reference)) {
      log(`shared your ${event.reference.lapTimeS.toFixed(3)}s lap as the reference for ${event.map.trackName}\n`);
    }
  } catch (err) {
    log(`could not share the map of ${event.map.trackName}: ${message(err)}\n`);
  }
}

/**
 * Make sure a layout's catalog row, map and reference laps are shared before a
 * pack for it is published, so an installer has the map to draw it on. Throws
 * when there is neither a local map nor a catalog row: a pack cannot be filed
 * under a track the catalog has never heard of.
 */
export async function shareTrack(dataDir: string, key: TrackKey): Promise<void> {
  const client = cloudClient();
  const repos = localRepositories(dataDir);
  const version = await repos.trackMaps.latestVersion(key);
  const map = version === null ? null : await repos.trackMaps.get({ ...key, mapVersion: version });
  if (map === null) return;

  const registry = await repos.cars.get(key.sim).catch(() => null);
  const cars = await repos.referenceLaps.listCars(key);
  for (const carId of [null, ...cars]) {
    await reportSession(client, {
      trackKey: key,
      trackName: map.trackName,
      configName: map.configName,
      lengthM: map.lengthM,
      carId,
      carName: carId === null ? null : (registry?.cars[carId]?.name ?? carId),
    });
  }
  await pushMap(client, map);
  for (const carId of cars) {
    const lap = await repos.referenceLaps.get(key, carId);
    if (lap !== null) await pushReferenceLap(client, lap);
  }
}

let sweptFor: string | null = null;

/**
 * Offer everything on this machine, once per sign-in per launch. The server
 * keeps the first map per layout and the fastest lap per car, so repeating it
 * is harmless — once is just enough.
 */
export async function shareOnSignIn(dataDir: string, log: Log): Promise<void> {
  const view = accountView();
  if (!view.signedIn || view.userId === null || sweptFor === view.userId) return;
  sweptFor = view.userId;

  const repos = localRepositories(dataDir);
  const registry = await repos.cars.get("iracing").catch(() => null);
  try {
    const result = await shareLocalTracks(cloudClient(), repos, (carId) => registry?.cars[carId]?.name ?? carId);
    if (result.maps > 0 || result.referenceLaps > 0) {
      log(`shared ${result.maps} map${result.maps === 1 ? "" : "s"} and ${result.referenceLaps} reference lap${result.referenceLaps === 1 ? "" : "s"} from this machine\n`);
    }
    for (const line of result.skipped) log(`not shared: ${line}\n`);
  } catch (err) {
    // Try again on the next sign-in or launch.
    sweptFor = null;
    log(`could not share this machine's maps: ${message(err)}\n`);
  }
}
