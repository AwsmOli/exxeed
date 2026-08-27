import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AudioPack } from "@exxeed/core";
import { audioKey, localRepositories, makeToneWav, preloadAudio, type Repositories } from "@exxeed/repo";

import { spaGt3Notes } from "../../core/test/fixtures.js";

let root: string;
let repos: Repositories;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "exxeed-audio-"));
  repos = localRepositories(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Write the four clips the fixture note set needs, at their declared lengths. */
async function writePack(overrides: Record<string, number> = {}): Promise<AudioPack> {
  const files: AudioPack["files"] = {};
  let totalBytes = 0;

  for (const note of spaGt3Notes.notes) {
    for (const [variant, declared] of [
      ["full", note.audio] as const,
      ["short", note.audioShort] as const,
    ]) {
      const key = audioKey(note.id, variant);
      const actualMs = overrides[key] ?? declared.durationMs;
      const bytes = makeToneWav(actualMs);

      const relative = `${spaGt3Notes.id}/en_test/${key}.wav`;
      const absolute = join(root, "audio", relative);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, bytes);

      files[key] = { path: relative, durationMs: declared.durationMs, bytes: bytes.byteLength };
      totalBytes += bytes.byteLength;
    }
  }

  return {
    noteSetId: spaGt3Notes.id,
    voiceId: "en_test",
    format: "wav/pcm_s16le/22050",
    files,
    totalBytes,
  };
}

describe("preloadAudio", () => {
  it("loads every clip a note set needs into memory", async () => {
    const pack = await writePack();
    const loaded = await preloadAudio(repos.audio, spaGt3Notes, pack);

    // Two notes, full and short each.
    expect(loaded.clips.size).toBe(4);
    expect([...loaded.clips.keys()].sort()).toEqual([
      "t1_brake",
      "t1_brake_short",
      "t1_throttle",
      "t1_throttle_short",
    ]);
    expect(loaded.totalBytes).toBeGreaterThan(0);
    expect(loaded.missing).toEqual([]);
  });

  it("measures durations from the files rather than trusting the pack", async () => {
    const pack = await writePack();
    const loaded = await preloadAudio(repos.audio, spaGt3Notes, pack);

    expect(loaded.measuredMs.get("t1_brake")).toBe(1240);
    expect(loaded.measuredMs.get("t1_brake_short")).toBe(720);
    expect(loaded.mismatched).toEqual([]);
  });

  it("flags a pack whose declared duration disagrees with the file", async () => {
    // The failure this catches is not "sounds wrong" — durationMs is an input to
    // the trigger (§6.1), so a pack claiming 1240 ms over a 1900 ms file places
    // every one of that note's callouts two thirds of a second late.
    const pack = await writePack({ t1_brake: 1900 });
    const loaded = await preloadAudio(repos.audio, spaGt3Notes, pack);

    expect(loaded.mismatched).toHaveLength(1);
    expect(loaded.mismatched[0]).toMatchObject({
      key: "t1_brake",
      declaredMs: 1240,
      measuredMs: 1900,
    });
  });

  it("tolerates rounding, not drift", async () => {
    const pack = await writePack({ t1_brake: 1245 });
    const loaded = await preloadAudio(repos.audio, spaGt3Notes, pack);
    expect(loaded.mismatched).toEqual([]);
  });

  it("reports missing clips instead of failing silently", async () => {
    const pack = await writePack();
    // A note set that names a clip the pack never rendered.
    const withExtra = {
      ...spaGt3Notes,
      notes: [
        ...spaGt3Notes.notes,
        { ...spaGt3Notes.notes[0]!, id: "t2_brake" },
      ],
    };

    const loaded = await preloadAudio(repos.audio, withExtra, pack);
    expect(loaded.missing).toEqual(["t2_brake", "t2_brake_short"]);
    expect(loaded.clips.size).toBe(4);
  });

  it("returns clips as bytes ready to hand to an audio device", async () => {
    const pack = await writePack();
    const loaded = await preloadAudio(repos.audio, spaGt3Notes, pack);

    const clip = loaded.clips.get("t1_brake");
    expect(clip).toBeInstanceOf(Uint8Array);
    expect(String.fromCharCode(...clip!.subarray(0, 4))).toBe("RIFF");
  });
});
