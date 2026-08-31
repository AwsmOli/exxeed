import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  listInstalledVoices,
  PIPER_DOWNLOADS,
  resolvePiper,
  VOICE_CATALOGUE,
  voiceFileUrl,
} from "../src/voices.js";

describe("the voice catalogue", () => {
  /**
   * The catalogue is a licence claim, not a convenience list. Every entry says
   * what it permits, and anything needing credit says what credit — because the
   * failure mode is shipping audio nobody may ship, discovered late.
   */
  it("states a licence for every voice", () => {
    for (const voice of VOICE_CATALOGUE) {
      expect(voice.licence).not.toBe("");
      expect(voice.bytes).toBeGreaterThan(0);
    }
  });

  it("names the credit for voices that require one", () => {
    const libritts = VOICE_CATALOGUE.find((v) => v.id.includes("libritts"));
    expect(libritts?.attribution).toContain("CC BY 4.0");
  });

  /** The two voices that made this necessary. Neither may ever be listed. */
  it("excludes the non-commercial voices", () => {
    const ids = VOICE_CATALOGUE.map((v) => v.id).join(" ");
    expect(ids).not.toContain("lessac");
    expect(ids).not.toContain("hfc");
  });

  it("builds both file URLs a voice needs", () => {
    const voice = VOICE_CATALOGUE[0]!;
    expect(voiceFileUrl(voice, ".onnx")).toBe(
      `https://huggingface.co/rhasspy/piper-voices/resolve/main/${voice.repoPath}/${voice.id}.onnx`,
    );
    expect(voiceFileUrl(voice, ".onnx.json")).toMatch(/\.onnx\.json$/);
  });
});

describe("installed voices", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "exxeed-voices-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lists nothing rather than throwing when the folder is absent", async () => {
    expect(await listInstalledVoices(join(dir, "nope"))).toEqual([]);
  });

  it("ignores a model whose config is missing", async () => {
    await writeFile(join(dir, "en_US-ljspeech-medium.onnx"), "x");
    expect(await listInstalledVoices(dir)).toEqual([]);

    await writeFile(join(dir, "en_US-ljspeech-medium.onnx.json"), "{}");
    const listed = await listInstalledVoices(dir);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.catalogue?.licence).toContain("public-domain");
  });

  it("ignores a half-finished download", async () => {
    await writeFile(join(dir, "en_US-ljspeech-medium.onnx.partial"), "x");
    await writeFile(join(dir, "en_US-ljspeech-medium.onnx.json"), "{}");
    expect(await listInstalledVoices(dir)).toEqual([]);
  });

  it("lists a voice it does not know the licence of, but says so", async () => {
    await writeFile(join(dir, "some-custom-voice.onnx"), "x");
    await writeFile(join(dir, "some-custom-voice.onnx.json"), "{}");
    const listed = await listInstalledVoices(dir);
    expect(listed[0]!.catalogue).toBeNull();
  });
});

describe("finding piper", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "exxeed-piper-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("finds nothing when there is nothing", async () => {
    expect(await resolvePiper({ bundledDir: dir, pathDirs: [], platform: "linux" })).toBeNull();
  });

  it("prefers an explicit setting over everything else", async () => {
    const mine = join(dir, "my-piper");
    await writeFile(mine, "#!/bin/sh");
    await mkdir(join(dir, "piper"), { recursive: true });
    await writeFile(join(dir, "piper", "piper"), "#!/bin/sh");

    const found = await resolvePiper({
      setting: mine,
      bundledDir: dir,
      pathDirs: [],
      platform: "linux",
    });
    expect(found).toEqual({ binary: mine, from: "setting" });
  });

  it("ignores a setting pointing at a file that is gone", async () => {
    await mkdir(join(dir, "piper"), { recursive: true });
    await writeFile(join(dir, "piper", "piper"), "#!/bin/sh");

    const found = await resolvePiper({
      setting: join(dir, "deleted"),
      bundledDir: dir,
      pathDirs: [],
      platform: "linux",
    });
    expect(found?.from).toBe("bundled");
  });

  it("falls back to PATH, then to the repo venv", async () => {
    const onPath = join(dir, "bin");
    await mkdir(onPath, { recursive: true });
    await writeFile(join(onPath, "piper"), "#!/bin/sh");
    expect(
      (await resolvePiper({ bundledDir: dir, pathDirs: [onPath], platform: "linux" }))?.from,
    ).toBe("path");

    const repo = join(dir, "repo");
    await mkdir(join(repo, ".venv", "bin"), { recursive: true });
    await writeFile(join(repo, ".venv", "bin", "piper"), "#!/bin/sh");
    expect(
      (
        await resolvePiper({
          bundledDir: dir,
          pathDirs: [],
          repoRoot: repo,
          platform: "linux",
        })
      )?.from,
    ).toBe("venv");
  });

  it("looks for piper.exe on Windows", async () => {
    await mkdir(join(dir, "piper"), { recursive: true });
    await writeFile(join(dir, "piper", "piper.exe"), "MZ");
    const found = await resolvePiper({ bundledDir: dir, pathDirs: [], platform: "win32" });
    expect(found?.binary).toMatch(/piper\.exe$/);
  });
});

describe("the standalone piper downloads", () => {
  /**
   * macOS is absent on purpose: that release's tarball ships the onnxruntime
   * .dSYM without the .dylib, so the binary cannot load. Listing it would offer
   * a button that always fails.
   */
  it("offers Windows and Linux, and not macOS", () => {
    expect(PIPER_DOWNLOADS.win32?.url).toContain("piper_windows_amd64.zip");
    expect(PIPER_DOWNLOADS.linux?.url).toContain("piper_linux_x86_64");
    expect(PIPER_DOWNLOADS.darwin).toBeUndefined();
  });
});
