/**
 * WAV header parsing — SPEC.md §4.5, §10, §12.
 *
 * "Never render TTS at runtime, and never estimate audio duration — ffprobe it."
 *
 * The rule behind that is what matters: a note's `durationMs` is an INPUT to the
 * trigger (§6.1), so a wrong duration is not a cosmetic error, it is a mistimed
 * callout. Duration must be measured from the file, never guessed from the text.
 *
 * For WAV specifically the measurement needs no external tool. The header states
 * the byte rate and the data chunk states its own length, so the duration is
 * exact arithmetic rather than an estimate — which is the property the rule is
 * actually asking for. `ffprobe` stays in the M5 render step, where the TTS
 * provider's output format is not yet known to be WAV.
 *
 * Byte parsing only. No I/O, so this belongs in core.
 */

export interface WavInfo {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
  readonly dataBytes: number;
  readonly durationMs: number;
}

const ascii = (bytes: Uint8Array, offset: number): string =>
  String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);

export class InvalidWavError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWavError";
  }
}

/**
 * Read format and duration out of a RIFF/WAVE file.
 *
 * Walks the chunk list rather than assuming `fmt ` and `data` sit at fixed
 * offsets — plenty of encoders insert `LIST` or `fact` chunks ahead of the audio,
 * and a fixed-offset reader would report a confident wrong answer.
 */
export function readWavInfo(bytes: Uint8Array): WavInfo {
  if (bytes.length < 12) throw new InvalidWavError("too short to be a WAV file");
  if (ascii(bytes, 0) !== "RIFF") throw new InvalidWavError("missing RIFF header");
  if (ascii(bytes, 8) !== "WAVE") throw new InvalidWavError("not a WAVE file");

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let sampleRate: number | null = null;
  let channels: number | null = null;
  let bitsPerSample: number | null = null;
  let byteRate: number | null = null;
  let dataBytes: number | null = null;

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;

    if (id === "fmt ") {
      if (body + 16 > bytes.length) throw new InvalidWavError("truncated fmt chunk");
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      byteRate = view.getUint32(body + 8, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === "data") {
      // Trust the smaller of the declared size and what is actually present, so a
      // truncated file reports the audio it really has rather than what it claims.
      dataBytes = Math.min(size, bytes.length - body);
    }

    // Chunks are word-aligned: an odd size is followed by a pad byte.
    offset = body + size + (size % 2);
  }

  if (sampleRate === null || channels === null || bitsPerSample === null || byteRate === null) {
    throw new InvalidWavError("no fmt chunk");
  }
  if (dataBytes === null) throw new InvalidWavError("no data chunk");
  if (byteRate <= 0) throw new InvalidWavError("fmt chunk declares a zero byte rate");

  return {
    sampleRate,
    channels,
    bitsPerSample,
    dataBytes,
    durationMs: (dataBytes / byteRate) * 1000,
  };
}

/** Measured duration in whole milliseconds, for writing into an AudioPack. */
export const wavDurationMs = (bytes: Uint8Array): number =>
  Math.round(readWavInfo(bytes).durationMs);
