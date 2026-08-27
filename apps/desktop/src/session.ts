/**
 * Loading everything a session needs, once, up front.
 *
 * SPEC.md §4.5: "All files for the loaded track are read into memory at session
 * start. Never touch disk at trigger time." §8.1 says the same about artefacts:
 * fetch and pin everything for the loaded track at session start, so a blip
 * mid-stint cannot silently stop the callouts.
 */

import type { DriverProfile, NoteSet } from "@exxeed/core";
import { metres, NoteEngine } from "@exxeed/core";
import type { TrackMapView } from "@exxeed/overlays";

import { toMapView } from "./map-view.js";
import type { PreloadedAudio } from "@exxeed/repo";
import { localRepositories, preloadAudio } from "@exxeed/repo";

export interface SessionConfig {
  readonly dataDir: string;
  readonly noteSetId: string;
  readonly voiceId: string;
  readonly profile: DriverProfile;
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
  if (mapVersion !== null) {
    const map = await repos.trackMaps.get({ ...noteSet.trackKey, mapVersion });
    if (map !== null) mapView = toMapView(map, noteSet.notes);
  }
  if (mapView === null) {
    warnings.push("no track map for this note set — the window will not draw one");
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
    engine: new NoteEngine(noteSet.notes, metres(noteSet.lengthM), config.profile),
    noteSet,
    audio,
    mapView,
    warnings,
  };
}
