/**
 * Audio preloading — SPEC.md §4.5.
 *
 * "All files for the loaded track are read into memory at session start. Never
 * touch disk at trigger time."
 *
 * The reason is latency, and it is the same reason §3 mandates WAV over MP3: at
 * the instant a callout fires the car is doing 69 m/s, and a disk seek or a
 * decode is metres of track. Everything is resolved up front so the trigger path
 * is a lookup in a Map.
 */

import type { AudioPack, AudioVariantName, Note, NoteSet } from "@exxeed/core";
import { wavDurationMs } from "@exxeed/core";

import type { AudioRepository } from "./interfaces.js";

/** Key convention from §4.5's example: "t1_brake" and "t1_brake_short". */
export const audioKey = (noteId: string, variant: AudioVariantName): string =>
  variant === "full" ? noteId : `${noteId}_short`;

export interface PreloadedAudio {
  readonly clips: ReadonlyMap<string, Uint8Array>;
  /** Durations measured from the files themselves, not from the pack metadata. */
  readonly measuredMs: ReadonlyMap<string, number>;
  readonly totalBytes: number;
  /** Keys named by a note but absent from the pack or unreadable on disk. */
  readonly missing: readonly string[];
  /**
   * Notes whose pack metadata disagrees with the file by more than a tick.
   *
   * Worth failing loudly over: `durationMs` is an input to the trigger (§6.1), so
   * a pack that says 900 ms over a 1400 ms file does not merely sound wrong, it
   * places every one of that note's callouts half a second late.
   */
  readonly mismatched: readonly DurationMismatch[];
}

export interface DurationMismatch {
  readonly key: string;
  readonly declaredMs: number;
  readonly measuredMs: number;
}

/** Milliseconds of disagreement tolerated before a note is flagged. */
export const DURATION_TOLERANCE_MS = 20;

const variantsOf = (note: Note): readonly [AudioVariantName, { durationMs: number }][] => [
  ["full", note.audio],
  ["short", note.audioShort],
];

/**
 * Read every clip a note set needs into memory, and check the pack's declared
 * durations against the files.
 */
export async function preloadAudio(
  audio: AudioRepository,
  noteSet: NoteSet,
  pack: AudioPack,
): Promise<PreloadedAudio> {
  const clips = new Map<string, Uint8Array>();
  const measuredMs = new Map<string, number>();
  const missing: string[] = [];
  const mismatched: DurationMismatch[] = [];
  let totalBytes = 0;

  for (const note of noteSet.notes) {
    for (const [variant, declared] of variantsOf(note)) {
      const key = audioKey(note.id, variant);
      const bytes = await audio.readFile(pack, key);

      if (bytes === null) {
        missing.push(key);
        continue;
      }

      clips.set(key, bytes);
      totalBytes += bytes.byteLength;

      const measured = wavDurationMs(bytes);
      measuredMs.set(key, measured);

      if (Math.abs(measured - declared.durationMs) > DURATION_TOLERANCE_MS) {
        mismatched.push({ key, declaredMs: declared.durationMs, measuredMs: measured });
      }
    }
  }

  return { clips, measuredMs, totalBytes, missing, mismatched };
}
