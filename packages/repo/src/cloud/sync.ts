/**
 * Track maps and reference laps between this machine and the cloud — TODO.md
 * M8 step 2, SPEC §8.1.
 *
 * Local files stay the runtime's source of truth. This module only moves
 * artefacts into and out of them: pull what is missing before a session or an
 * editor needs it, push what was cut here so the next machine has it. Nothing
 * here runs on the telemetry path, and every call has a timeout, because a
 * session must start on time with the network gone.
 *
 * Pulled artefacts go through the local repositories' `put`, which validates
 * them with the §4 schemas — a row from the server is checked exactly like a
 * file from disk.
 */

import {
  ReferenceLapSchema,
  TrackMapSchema,
  type ReferenceLap,
  type TrackKey,
  type TrackMap,
} from "@exxeed/core";

import type { Repositories } from "../interfaces.js";
import type { CloudClient } from "./client.js";
import type { Json } from "./db.generated.js";

/** Long enough for a slow connection, short enough not to hold up a session. */
const TIMEOUT_MS = 5000;

const timeout = (): AbortSignal => AbortSignal.timeout(TIMEOUT_MS);

/** What the sim reported on connect, as the catalog wants it. */
export interface ReportedSession {
  readonly trackKey: TrackKey;
  readonly trackName: string;
  readonly configName: string;
  readonly lengthM: number | null;
  readonly carId: string | null;
  readonly carName: string | null;
}

/**
 * Add the track layout and car to the catalog if they are not there. Signed-in
 * only (the RPC refuses otherwise). First report wins, so this never renames
 * anything.
 */
export async function reportSession(client: CloudClient, session: ReportedSession): Promise<void> {
  const { error } = await client
    .rpc("report_session", {
      p_sim: session.trackKey.sim,
      p_track_id: session.trackKey.trackId,
      p_config_id: session.trackKey.configId,
      p_track_name: session.trackName,
      p_config_name: session.configName,
      // The generated types say `number`, but the column is nullable and the
      // function passes it straight through.
      p_length_m: session.lengthM as number,
      p_car_id: session.carId as string,
      p_car_name: session.carName as string,
    })
    .abortSignal(timeout());
  if (error !== null) throw new Error(`report_session: ${error.message}`);
}

export interface PullResult {
  readonly map: boolean;
  readonly referenceLaps: number;
}

/**
 * Fetch the map and reference laps for a layout if this machine has none.
 *
 * Only fills gaps — a local map is never replaced. Reading is public, so this
 * works signed out.
 */
export async function pullTrack(client: CloudClient, repos: Repositories, key: TrackKey): Promise<PullResult> {
  let map = false;
  if ((await repos.trackMaps.latestVersion(key)) === null) {
    const { data, error } = await client
      .from("track_maps")
      .select("data")
      .eq("sim", key.sim)
      .eq("track_id", key.trackId)
      .eq("config_id", key.configId)
      .order("map_version", { ascending: false })
      .limit(1)
      .abortSignal(timeout());
    if (error !== null) throw new Error(`track_maps: ${error.message}`);
    const row = data[0];
    if (row !== undefined) {
      await repos.trackMaps.put(TrackMapSchema.parse(row.data));
      map = true;
    }
  }

  let referenceLaps = 0;
  const haveCars = new Set(await repos.referenceLaps.listCars(key));
  const { data: laps, error } = await client
    .from("reference_laps")
    .select("car_id, data")
    .eq("sim", key.sim)
    .eq("track_id", key.trackId)
    .eq("config_id", key.configId)
    .abortSignal(timeout());
  if (error !== null) throw new Error(`reference_laps: ${error.message}`);
  for (const lap of laps) {
    if (haveCars.has(lap.car_id)) continue;
    await repos.referenceLaps.put(ReferenceLapSchema.parse(lap.data));
    referenceLaps++;
  }

  return { map, referenceLaps };
}

export interface PushMapResult {
  /** The map version that stands for the layout. */
  readonly mapVersion: number;
  /** False when someone else's map got there first and this one was not stored. */
  readonly accepted: boolean;
}

/** Offer a map cut on this machine. The first map per layout wins. */
export async function pushMap(client: CloudClient, map: TrackMap): Promise<PushMapResult> {
  const { data, error } = await client
    .rpc("submit_map", {
      p_sim: map.trackRef.sim,
      p_track_id: map.trackRef.trackId,
      p_config_id: map.trackRef.configId,
      p_data: map as unknown as Json,
    })
    .abortSignal(timeout());
  if (error !== null) throw new Error(`submit_map: ${error.message}`);
  const row = data[0];
  if (row === undefined) throw new Error("submit_map returned nothing");
  return { mapVersion: row.map_version, accepted: row.accepted };
}

/** Offer a reference lap. True when it was taken: none existed, or it is faster. */
export async function pushReferenceLap(client: CloudClient, lap: ReferenceLap): Promise<boolean> {
  const { data, error } = await client
    .rpc("submit_reference_lap", {
      p_sim: lap.trackKey.sim,
      p_track_id: lap.trackKey.trackId,
      p_config_id: lap.trackKey.configId,
      p_car_id: lap.carId,
      p_lap_time_s: lap.lapTimeS,
      p_data: lap as unknown as Json,
    })
    .abortSignal(timeout());
  if (error !== null) throw new Error(`submit_reference_lap: ${error.message}`);
  return data;
}

/** A map cut before tracks were named, whose catalog row would say "track 192". */
const placeholderName = (map: TrackMap): boolean => /^track \d+$/.test(map.trackName);

export interface ShareResult {
  readonly maps: number;
  readonly referenceLaps: number;
  readonly skipped: readonly string[];
}

/**
 * Offer every map and reference lap on this machine. For the ones cut before
 * sync existed — Snetterton's map lives only on the rig that drove it. Safe to
 * repeat: the server keeps the first map per layout and the fastest lap per
 * car, so a second sweep changes nothing.
 */
export async function shareLocalTracks(
  client: CloudClient,
  repos: Repositories,
  carName: (carId: string) => string,
): Promise<ShareResult> {
  let maps = 0;
  let referenceLaps = 0;
  const skipped: string[] = [];

  for (const track of await repos.trackMaps.listTracks()) {
    const map = await repos.trackMaps.get({ ...track.key, mapVersion: track.mapVersion });
    if (map === null) continue;
    if (placeholderName(map)) {
      skipped.push(`${track.key.trackId}/${track.key.configId}: map has no track name — re-cut it`);
      continue;
    }

    const cars = await repos.referenceLaps.listCars(track.key);
    // The catalog rows the map and laps hang off: the layout, and each car.
    await reportSession(client, {
      trackKey: track.key,
      trackName: map.trackName,
      configName: map.configName,
      lengthM: map.lengthM,
      carId: null,
      carName: null,
    });
    for (const carId of cars) {
      await reportSession(client, {
        trackKey: track.key,
        trackName: map.trackName,
        configName: map.configName,
        lengthM: map.lengthM,
        carId,
        carName: carName(carId),
      });
    }

    if ((await pushMap(client, map)).accepted) maps++;
    for (const carId of cars) {
      const lap = await repos.referenceLaps.get(track.key, carId);
      if (lap !== null && (await pushReferenceLap(client, lap))) referenceLaps++;
    }
  }

  return { maps, referenceLaps, skipped };
}
