import { describe, expect, it } from "vitest";

import { InvalidWavError, readWavInfo, wavDurationMs } from "@exxeed/core";
import { makeToneWav } from "@exxeed/repo";

// Lives in packages/repo rather than packages/core because it exercises both:
// core parses WAV headers, repo writes the files. Core may not import repo — the
// lint rule enforcing §8's boundary catches it, as it did when this test was
// first written in the wrong place.

describe("readWavInfo", () => {
  it("reads format and duration from a real file", () => {
    const info = readWavInfo(makeToneWav(1240));

    expect(info.sampleRate).toBe(22_050);
    expect(info.channels).toBe(1);
    expect(info.bitsPerSample).toBe(16);
    expect(info.durationMs).toBeCloseTo(1240, 0);
  });

  it("measures duration exactly, not by estimating from text length", () => {
    // SPEC.md §12: never estimate audio duration. durationMs is an input to the
    // trigger, so a wrong one is a mistimed callout rather than a cosmetic bug.
    for (const ms of [120, 720, 900, 1240, 2000]) {
      expect(wavDurationMs(makeToneWav(ms))).toBe(ms);
    }
  });

  it("walks the chunk list instead of assuming fixed offsets", () => {
    // Encoders routinely insert LIST or fact chunks before the audio. A
    // fixed-offset reader gives a confident wrong answer on those files.
    const original = makeToneWav(500);
    const listChunk = new Uint8Array(8 + 4);
    listChunk.set([0x4c, 0x49, 0x53, 0x54], 0); // "LIST"
    new DataView(listChunk.buffer).setUint32(4, 4, true);

    const withList = new Uint8Array(original.length + listChunk.length);
    withList.set(original.subarray(0, 12), 0);
    withList.set(listChunk, 12);
    withList.set(original.subarray(12), 12 + listChunk.length);

    expect(wavDurationMs(withList)).toBe(500);
  });

  it("reports the audio actually present in a truncated file", () => {
    const full = makeToneWav(1000);
    const truncated = full.subarray(0, 44 + Math.floor((full.length - 44) / 2));

    // The header still claims 1000 ms; the file only holds half of it.
    expect(wavDurationMs(truncated)).toBeCloseTo(500, -1);
  });

  it("rejects things that are not WAV files rather than inventing a duration", () => {
    expect(() => readWavInfo(new Uint8Array(4))).toThrow(InvalidWavError);
    expect(() => readWavInfo(new Uint8Array(64))).toThrow(/RIFF/);

    const mp3ish = new Uint8Array(64);
    mp3ish.set([0x49, 0x44, 0x33], 0); // "ID3"
    expect(() => readWavInfo(mp3ish)).toThrow(InvalidWavError);
  });

  it("rejects a WAVE file with no data chunk", () => {
    const header = makeToneWav(100).subarray(0, 36);
    const noData = new Uint8Array(header);
    expect(() => readWavInfo(noData)).toThrow(/data chunk/);
  });
});
