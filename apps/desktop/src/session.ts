/**
 * Loading everything a session needs, once, up front.
 *
 * SPEC.md §4.5: "All files for the loaded track are read into memory at session
 * start. Never touch disk at trigger time." §8.1 says the same about artefacts:
 * fetch and pin everything for the loaded track at session start, so a blip
 * mid-stint cannot silently stop the callouts.
 */

import type { DriverProfile, NoteSet, TrackMap } from "@exxeed/core";
import {
  indexLandmarks,
  metres,
  NoteEngine,
  resolveNotes,
  type LandmarkIndex,
} from "@exxeed/core";
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
  readonly map: TrackMap;
  readonly audio: PreloadedAudio | null;
  readonly warnings: readonly string[];
}

export async function loadSession(config: SessionConfig): Promise<LoadedSession> {
  const repos = localRepositories(config.dataDir);
  const warnings: string[] = [];

  const noteSet = await repos.noteSets.get(config.noteSetId);
  if (noteSet === null) {
    throw new Error(`no note set "${config.noteSetId}" under ${config.dataDir}`);
  }

  const map = await repos.trackMaps.get(noteSet.trackRef);
  if (map === null) {
    throw new Error(`no track map for ${JSON.stringify(noteSet.trackRef)}`);
  }

  // A landmark inventory is optional. A note set anchored entirely to corners
  // (§4.7) never touches it, and refusing to load one because the track has no
  // inventory yet blocks exactly the hand-authored sets M2 asks for. When it is
  // missing, landmark anchors simply fail to resolve — which is already reported
  // per note below, and says which notes are affected rather than none of them.
  const inventory = await repos.landmarks.get(noteSet.trackRef);
  const landmarks: LandmarkIndex = inventory === null ? new Map() : indexLandmarks(inventory);

  const { resolved, unresolved } = resolveNotes(noteSet.notes, map, landmarks);
  for (const note of unresolved) {
    warnings.push(`note "${note.id}" has an unresolvable anchor, skipping`);
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
    engine: new NoteEngine(resolved, metres(map.lengthM), config.profile),
    noteSet,
    map,
    audio,
    warnings,
  };
}
