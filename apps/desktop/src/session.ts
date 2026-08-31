/**
 * Loading everything a session needs, once, up front.
 *
 * SPEC.md §4.5: "All files for the loaded track are read into memory at session
 * start. Never touch disk at trigger time." §8.1 says the same about artefacts:
 * fetch and pin everything for the loaded track at session start, so a blip
 * mid-stint cannot silently stop the callouts.
 */

import type { DriverProfile, NoteSet } from "@exxeed/core";
import { carEntry, matchesClass, metres, NoteEngine } from "@exxeed/core";
import type { SessionIdentity } from "@exxeed/telemetry";
import type { ReferenceView, TrackMapView } from "@exxeed/overlays";

import { toMapView } from "./map-view.js";
import { toReferenceView } from "./reference-view.js";
import type { PreloadedAudio } from "@exxeed/repo";
import { localRepositories, preloadAudio } from "@exxeed/repo";

export interface SessionConfig {
  readonly dataDir: string;
  readonly noteSetId: string;
  readonly voiceId: string;
  readonly profile: DriverProfile;
  /**
   * Skip §6.4's out-lap gate. Only ever set for a replay — main refuses to pass
   * it for a live source, because on track the gate is not friction, it is the
   * rule.
   */
  readonly assumeLapComplete?: boolean;
  /** Which car's reference lap to draw against, as the sim's slug. Defaults to
   *  the car being driven, then to the only lap recorded for this track. */
  readonly carId?: string;
}

export interface LoadedSession {
  readonly engine: NoteEngine;
  readonly noteSet: NoteSet;
  readonly audio: PreloadedAudio | null;
  /**
   * For the window to draw. Null when no map has been cut for this track — the
   * engine does not need one (§4.4), so a missing map costs a picture and
   * nothing else.
   */
  readonly mapView: TrackMapView | null;
  /** For the input trace and the delta bar (§7.1, §7.2). Null when no lap has
   *  been recorded for this track and car — both overlays simply have no ghost. */
  readonly reference: ReferenceView | null;
  readonly warnings: readonly string[];
}

export async function loadSession(config: SessionConfig): Promise<LoadedSession> {
  const repos = localRepositories(config.dataDir);
  const warnings: string[] = [];

  const noteSet = await repos.noteSets.get(config.noteSetId);
  if (noteSet === null) {
    throw new Error(`no note set "${config.noteSetId}" under ${config.dataDir}`);
  }

  // The ENGINE needs no TrackMap: a note is a point and a message (§4.4). This
  // is purely so the window can draw the circuit and put the car on it, which is
  // the fastest way to see that the map and the telemetry agree.
  let mapView: TrackMapView | null = null;
  const mapVersion = await repos.trackMaps.latestVersion(noteSet.trackKey);
  const map =
    mapVersion === null
      ? null
      : await repos.trackMaps.get({ ...noteSet.trackKey, mapVersion });
  if (map !== null) mapView = toMapView(map, noteSet.notes);
  if (mapView === null) {
    warnings.push("no track map for this note set — the window will not draw one");
  }

  // The reference lap the traces and the delta bar draw against (§7.1, §7.2). A
  // note set names a car CLASS, not a car id (§4.4), so without an explicit
  // choice take the only recorded lap — and say so when there is more than one
  // rather than picking silently.
  let reference: ReferenceView | null = null;
  const cars = await repos.referenceLaps.listCars(noteSet.trackKey);
  const carId = config.carId ?? cars[0];

  if (carId === undefined) {
    warnings.push("no reference lap for this track — no ghost trace or delta bar");
  } else {
    if (config.carId === undefined && cars.length > 1) {
      warnings.push(
        `${cars.length} reference laps for this track (${cars.join(", ")}); using ${carId}`,
      );
    }
    const lap = await repos.referenceLaps.get(noteSet.trackKey, carId);
    if (lap === null) warnings.push(`no reference lap for car ${carId}`);
    else reference = toReferenceView(lap, map);
  }

  // A missing audio pack is survivable — the engine still runs and the dev
  // overlay still shows what it would have said. A WRONG one is not, so
  // mismatched durations are surfaced rather than swallowed: durationMs is an
  // input to the trigger (§6.1), so a stale pack mistimes every callout it names.
  const pack = await repos.audio.getPack(noteSet.id, config.voiceId);
  let audio: PreloadedAudio | null = null;

  if (pack === null) {
    warnings.push(
      `no audio pack for "${noteSet.id}" voice "${config.voiceId}" — running silent`,
    );
  } else {
    audio = await preloadAudio(repos.audio, noteSet, pack);
    for (const key of audio.missing) {
      warnings.push(`audio clip "${key}" is missing from the pack`);
    }
    for (const m of audio.mismatched) {
      warnings.push(
        `audio "${m.key}" is ${m.measuredMs}ms but the pack declares ${m.declaredMs}ms — ` +
          `callouts for this note will be mistimed`,
      );
    }
  }

  return {
    engine: new NoteEngine(noteSet.notes, metres(noteSet.lengthM), config.profile, {
      assumeLapComplete: config.assumeLapComplete ?? false,
    }),
    noteSet,
    audio,
    mapView,
    reference,
    warnings,
  };
}

/**
 * What the car actually being driven says about the session that was loaded.
 *
 * Separate from `loadSession` because of an ordering constraint, not taste: the
 * session is pinned up front (§4.5, §8.1) but the sim only hands over the track
 * and car on connect, so at load time there is nothing to check against. Hence a
 * second pass, run once the identity is known.
 *
 * Both checks warn rather than refuse. §1 is blunt about the stakes — "a GT3
 * brakes at the 100 board where an LMP2 brakes at the 50 and an MX-5 at the 150"
 * — so a class mismatch is wrong braking points, not a cosmetic complaint. It
 * still runs, because driving a GT3 set in an MX-5 deliberately, to hear how far
 * off it is, is a reasonable thing to want, and because refusing would also
 * refuse every car nobody has added to the registry yet.
 */
export async function carWarnings(
  dataDir: string,
  noteSet: NoteSet,
  reference: ReferenceView | null,
  identity: SessionIdentity | null,
): Promise<string[]> {
  if (identity === null) return [];

  const repos = localRepositories(dataDir);
  const registry = await repos.cars.get(noteSet.trackKey.sim);
  const warnings: string[] = [];

  const match = matchesClass(registry, identity.carId, noteSet.carClass);
  if (match.kind === "mismatch") {
    warnings.push(
      `note set "${noteSet.id}" is for "${match.expected}" but you are driving ` +
        `${identity.carName} ("${match.carClass}") — its braking points are for ` +
        `another car`,
    );
  } else if (match.kind === "unknown" && carEntry(registry, identity.carId) === null) {
    // Not an error, and said once: a new car simply has no class yet. Naming the
    // slug makes adding it a copy-paste rather than a hunt.
    warnings.push(
      `"${identity.carId}" is not in data/cars/${noteSet.trackKey.sim}.json, so the ` +
        `note set's class could not be checked`,
    );
  }

  // The ghost trace and the delta bar are drawn against this lap. A lap from a
  // different car is not a smaller version of the same thing — it brakes
  // elsewhere — so comparing against one silently is the failure worth catching.
  if (reference !== null && reference.carId !== identity.carId) {
    warnings.push(
      `the reference lap is ${reference.carId} but you are driving ${identity.carId} — ` +
        `the ghost trace and delta bar compare against a different car`,
    );
  }

  return warnings;
}
