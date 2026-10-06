/**
 * How fast callouts are spoken — a driver's preference, applied at playback.
 *
 * The audio is rendered once, at the voice's own pace (§10). Playing it back
 * faster needs no re-render, but it is not only a playback matter: a clip's
 * length is an input to the trigger (§6.1), and to how long the scheduler
 * holds the channel busy (§6.3). A callout spoken in three seconds instead of
 * four has to START a second later to end at the same place, so the rate has
 * to reach the engine as well as the speaker — as shorter durations, which is
 * the only thing about the audio the engine has ever known.
 *
 * So the rate is applied to the notes before the engine sees them, here, and
 * the same number is handed to whatever plays the clip. One function, so the
 * two cannot disagree.
 */

import type { Note } from "./schema.js";

export const SPEECH_RATE_MIN = 0.5;
/** Past double speed, time-stretched speech stops being words. */
export const SPEECH_RATE_MAX = 2;
export const SPEECH_RATE_DEFAULT = 1;

/** A stored or typed rate, made safe: in range, and 1 for anything that is not a number. */
export function clampSpeechRate(rate: unknown): number {
  if (typeof rate !== "number" || !Number.isFinite(rate)) return SPEECH_RATE_DEFAULT;
  return Math.min(SPEECH_RATE_MAX, Math.max(SPEECH_RATE_MIN, rate));
}

/** The notes as they will be HEARD at `rate`: the same clips, lasting 1/rate as long. */
export function atSpeechRate(notes: readonly Note[], rate: number): Note[] {
  const r = clampSpeechRate(rate);
  if (r === 1) return [...notes];
  return notes.map((note) => ({
    ...note,
    audio: { ...note.audio, durationMs: note.audio.durationMs / r },
    audioShort: { ...note.audioShort, durationMs: note.audioShort.durationMs / r },
  }));
}
