/**
 * Minimal PCM WAV writer.
 *
 * Exists so the audio path can be built and tested before a TTS provider is
 * chosen (§13, open question 4). It generates tone bursts of an exact requested
 * length, which is all the engine cares about — `durationMs` is what sets lead
 * distance (§6.1), and a 900 ms placeholder times identically to a 900 ms voice.
 *
 * Not a shipping feature. Real audio comes from stage 6 of the ingest pipeline.
 */

const SAMPLE_RATE = 22_050;
const BITS_PER_SAMPLE = 16;
const CHANNELS = 1;

/**
 * A mono 16-bit PCM WAV of exactly `durationMs`, containing a quiet sine tone.
 *
 * Audible on purpose: silence would make it impossible to tell "the callout
 * played" from "the callout was dropped" when listening to a replay.
 */
export function makeToneWav(durationMs: number, frequencyHz = 440): Uint8Array {
  const frames = Math.round((durationMs / 1000) * SAMPLE_RATE);
  const dataBytes = frames * CHANNELS * (BITS_PER_SAMPLE / 8);
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  const byteRate = SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8);

  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, CHANNELS * (BITS_PER_SAMPLE / 8), true); // block align
  view.setUint16(34, BITS_PER_SAMPLE, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);

  // Short fades at both ends, so a burst does not click.
  const fadeFrames = Math.min(220, Math.floor(frames / 8));
  for (let i = 0; i < frames; i++) {
    const envelope =
      i < fadeFrames
        ? i / fadeFrames
        : i > frames - fadeFrames
          ? (frames - i) / fadeFrames
          : 1;
    const sample = Math.sin((2 * Math.PI * frequencyHz * i) / SAMPLE_RATE) * 0.25 * envelope;
    view.setInt16(44 + i * 2, Math.round(sample * 32_767), true);
  }

  return new Uint8Array(buffer);
}
