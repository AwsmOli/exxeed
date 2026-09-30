/**
 * Cutting a track map from the first clean lap, while the session is running.
 *
 * Recording has always been on for an unmapped track (§9) — but a recording
 * was as far as it went. Turning a lap into a map meant finding a clean one,
 * cutting it out of the session by hand and running `exxeed-trackmap`, and
 * until then the map overlay had nothing to draw. Eleven laps at a new track
 * and no map is the result, and nothing on screen said why.
 *
 * So: every completed lap at a track with no map is checked (laps.ts), and the
 * first clean one becomes the map and the reference lap, through the same
 * builder the command uses. A faster clean lap later in the *same* session
 * replaces the reference lap, measured against the corners the map already has
 * — never re-cutting the map, because its corner numbers are what note sets and
 * imports hang off (§4.0). A map from an earlier session is left alone, as is
 * one cut by hand: this only ever fills a gap.
 *
 * Off the hot path by construction: a lap is handed over when it ends, the
 * build takes tens of milliseconds, and it runs after the frame that ended the
 * lap has already been sent on.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  CornerOverridesSchema,
  type CornerOverrides,
  type ReferenceLap,
  type TrackKey,
  type TrackMap,
} from "@exxeed/core";
import { localRepositories } from "@exxeed/repo";
import {
  buildTrackMap,
  LapCollector,
  type CompletedLap,
  type SessionIdentity,
  type TelemetryFrame,
} from "@exxeed/telemetry";

export interface AutoMapEvent {
  readonly kind: "mapped" | "reference";
  readonly map: TrackMap;
  readonly reference: ReferenceLap;
  readonly lap: CompletedLap;
}

const fmtLap = (s: number): string => {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(3).padStart(6, "0")}`;
};

/**
 * Per-track corner fixes, if someone has written them (§5.2). Read from the
 * same folder the repository files the map under, so an override written for a
 * hand cut applies to an automatic one too.
 */
export async function readOverrides(dataDir: string, key: TrackKey): Promise<CornerOverrides | undefined> {
  const path = join(dataDir, "tracks", key.sim, String(key.trackId), key.configId, "corners.override.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  return CornerOverridesSchema.parse(JSON.parse(text.trimStart()));
}

export class AutoMapper {
  readonly #dataDir: string;
  readonly #identity: SessionIdentity & { readonly trackKey: TrackKey };
  readonly #onEvent: (event: AutoMapEvent) => void;
  readonly #log: (line: string) => void;
  readonly #laps = new LapCollector();

  /** Set once this session has cut the map; null while the track is unmapped. */
  #map: TrackMap | null = null;
  #bestS = Number.POSITIVE_INFINITY;
  /** One build at a time, in lap order. */
  #queue: Promise<void> = Promise.resolve();

  private constructor(
    dataDir: string,
    identity: SessionIdentity & { readonly trackKey: TrackKey },
    onEvent: (event: AutoMapEvent) => void,
    log: (line: string) => void,
  ) {
    this.#dataDir = dataDir;
    this.#identity = identity;
    this.#onEvent = onEvent;
    this.#log = log;
  }

  /**
   * An auto-mapper for this session, or null when there is nothing for one to
   * do: the sim did not say which track this is, or the track is already mapped.
   */
  static async forSession(
    dataDir: string,
    identity: SessionIdentity | null,
    onEvent: (event: AutoMapEvent) => void,
    log: (line: string) => void,
  ): Promise<AutoMapper | null> {
    if (identity?.trackKey == null) return null;
    const key = identity.trackKey;
    if ((await localRepositories(dataDir).trackMaps.latestVersion(key)) !== null) return null;
    log(`no map for ${identity.trackName} yet — one will be cut from your first clean lap\n`);
    return new AutoMapper(dataDir, { ...identity, trackKey: key }, onEvent, log);
  }

  push(frame: TelemetryFrame): void {
    const lap = this.#laps.push(frame);
    if (lap === null) return;
    this.#queue = this.#queue.then(() => this.#handle(lap)).catch((err: unknown) => {
      this.#log(`could not cut a map from lap ${lap.lap}: ${err instanceof Error ? err.message : String(err)}\n`);
    });
  }

  /** Wait for any build in progress — so a session ending mid-build still writes it. */
  settled(): Promise<void> {
    return this.#queue;
  }

  async #handle(lap: CompletedLap): Promise<void> {
    if (lap.dirty !== null) {
      // Said only while it explains a missing map; once there is one, a dirty
      // lap is just a lap.
      if (this.#map === null) this.#log(`lap ${lap.lap} (${fmtLap(lap.lapTimeS)}) not used for the map: ${lap.dirty}\n`);
      return;
    }
    if (this.#map !== null && lap.lapTimeS >= this.#bestS) return;

    const repos = localRepositories(this.#dataDir);
    const id = this.#identity;

    if (this.#map === null) {
      const overrides = await readOverrides(this.#dataDir, id.trackKey);
      const built = buildTrackMap(lap.frames, {
        trackRef: { ...id.trackKey, mapVersion: 1 },
        trackName: id.trackName,
        configName: id.trackConfig,
        carId: id.carId,
        ...(overrides === undefined ? {} : { overrides }),
      });
      await repos.trackMaps.put(built.map);
      await repos.referenceLaps.put(built.referenceLap);
      this.#map = built.map;
      this.#bestS = lap.lapTimeS;
      this.#log(
        `mapped ${id.trackName} from lap ${lap.lap} (${fmtLap(lap.lapTimeS)}): ` +
          `${built.corners.length} corners, ${built.diagnostics.lengthM.toFixed(0)}m` +
          (overrides === undefined ? " — corner numbers are as detected; add corners.override.json to match the official ones" : "") +
          "\n",
      );
      this.#onEvent({ kind: "mapped", map: built.map, reference: built.referenceLap, lap });
      return;
    }

    const rebuilt = buildTrackMap(lap.frames, {
      trackRef: this.#map.trackRef,
      trackName: this.#map.trackName,
      configName: this.#map.configName,
      carId: id.carId,
      lengthM: this.#map.lengthM,
      corners: this.#map.corners,
    });
    await repos.referenceLaps.put(rebuilt.referenceLap);
    this.#log(`reference lap for ${id.trackName} is now lap ${lap.lap} (${fmtLap(lap.lapTimeS)}, was ${fmtLap(this.#bestS)})\n`);
    this.#bestS = lap.lapTimeS;
    this.#onEvent({ kind: "reference", map: this.#map, reference: rebuilt.referenceLap, lap });
  }
}
