/**
 * Stage 6 — render a note set's audio and measure it. SPEC.md §10.
 *
 * Two rules from §12 shape this, and both are about the same thing:
 *
 *  - **Never estimate audio duration.** `durationMs` is an input to the trigger
 *    (§6.1), so a wrong one is a mistimed callout, not a cosmetic error. Every
 *    duration written here is read back off the file that was just produced.
 *  - **Never render TTS at runtime.** This runs offline, once per note set.
 *
 * The measured duration goes into the note as well as the pack, so the two can
 * never disagree — which is the mismatch `preloadAudio` warns about at load time.
 */

import type { AudioPack, Note, NoteSet } from "@exxeed/core";
import { wavDurationMs } from "@exxeed/core";
import type { AudioRepository, NoteSetRepository } from "@exxeed/repo";
import { audioKey } from "@exxeed/repo";

import type { TtsEngine } from "./engine.js";

export interface RenderedClip {
  readonly key: string;
  readonly text: string;
  readonly durationMs: number;
  readonly bytes: number;
}

export interface RenderResult {
  readonly noteSet: NoteSet;
  readonly pack: AudioPack;
  /** Only the clips synthesised this time. */
  readonly clips: readonly RenderedClip[];
  /** Clips kept from the previous pack (`reuse`). */
  readonly reused: number;
}

export interface RenderOptions {
  readonly noteSet: NoteSet;
  readonly engine: TtsEngine;
  readonly audio: AudioRepository;
  readonly noteSets: NoteSetRepository;
  /** Report progress; rendering a full set takes a while. */
  readonly onClip?: (clip: RenderedClip) => void;
  /**
   * Keep a clip from the existing pack when its words are unchanged and its
   * file is still there — so installing v4 over v3 renders only what v4
   * changed (M8). Off for the editor's explicit Render, which is the way to
   * redo everything after swapping the voice model under the same voice id.
   */
  readonly reuse?: boolean;
}

export async function renderNoteSet(options: RenderOptions): Promise<RenderResult> {
  const { noteSet, engine, audio, noteSets } = options;
  const voiceId = engine.voiceId;

  const files: Record<string, { path: string; durationMs: number; bytes: number; text: string }> = {};
  const clips: RenderedClip[] = [];
  const notes: Note[] = [];
  let totalBytes = 0;
  let reused = 0;

  const previous = options.reuse === true ? await audio.getPack(noteSet.id, voiceId) : null;

  for (const note of noteSet.notes) {
    const rendered: Partial<Record<"full" | "short", { file: string; durationMs: number }>> = {};

    for (const variant of ["full", "short"] as const) {
      const text = variant === "full" ? note.text : note.textShort;
      const key = audioKey(note.id, variant);

      // Same words, same voice, file still on disk: the measured duration
      // still holds, so there is nothing to redo.
      const kept = previous?.files[key];
      if (kept !== undefined && kept.text === text && previous !== null && (await audio.readFile(previous, key)) !== null) {
        files[key] = { path: kept.path, durationMs: kept.durationMs, bytes: kept.bytes, text };
        rendered[variant] = { file: kept.path, durationMs: kept.durationMs };
        totalBytes += kept.bytes;
        reused++;
        continue;
      }

      const wav = await engine.synthesise(text);
      const path = await audio.putClip(noteSet.id, voiceId, key, wav);

      // Measured, not predicted. This is the whole point of the stage.
      const durationMs = wavDurationMs(wav);

      files[key] = { path, durationMs, bytes: wav.byteLength, text };
      rendered[variant] = { file: path, durationMs };
      totalBytes += wav.byteLength;

      const clip = { key, text, durationMs, bytes: wav.byteLength };
      clips.push(clip);
      options.onClip?.(clip);
    }

    notes.push({
      ...note,
      audio: rendered.full!,
      audioShort: rendered.short!,
      // Text and audio now agree, so the note is no longer stale. §7.4 forbids
      // publishing a set containing a dirty note; this is what clears them.
      dirty: false,
    });
  }

  const pack: AudioPack = {
    noteSetId: noteSet.id,
    voiceId,
    format: "wav/pcm_s16le/22050",
    files,
    totalBytes,
  };

  const updated: NoteSet = { ...noteSet, notes };

  await audio.putPack(pack);
  await noteSets.put(updated);

  return { noteSet: updated, pack, clips, reused };
}
