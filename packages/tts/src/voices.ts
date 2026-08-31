/**
 * Finding, listing and fetching voices — and Piper itself.
 *
 * ## Why this exists
 *
 * Rendering used to need two absolute paths typed into text boxes: where Piper
 * is, and where a .onnx model is. That is setup, and setup is the thing people
 * bounce off. It is also setup that **only an author needs** — §10 stage 6
 * renders offline, once per note set, and the runtime plays the WAVs that came
 * out. Someone who downloads a note set and drives never needs any of this.
 *
 * So the shape is: a voices folder that works like the recordings folder, a
 * short catalogue of voices that can actually be redistributed, and a Piper
 * that installs itself where it can.
 *
 * ## The licence problem, which is not hypothetical
 *
 * Most Piper voices cannot be used in a product. `en_US-lessac-medium` — the
 * obvious default, and what this project rendered with first — is trained on the
 * Blizzard 2013 Lessac corpus, whose licence forbids "the development,
 * marketing, commercialisation, sale or licencing of voice synthesis products",
 * and that reaches the synthesised audio, not just the model. `hfc_male` is
 * CC BY-NC-SA. Both are fine to experiment with and impossible to ship.
 *
 * The catalogue below is therefore not "the popular voices". It is the ones
 * whose model *and dataset* licences were read and permit redistribution of what
 * comes out of them. Adding to it means reading a MODEL_CARD, not guessing from
 * the repository licence — rhasspy/piper-voices is MIT as a repository while
 * containing voices nobody may ship.
 */

import { createWriteStream } from "node:fs";
import { chmod, mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface CatalogueVoice {
  /** Piper's own name for it, and the file's basename. */
  readonly id: string;
  readonly label: string;
  /** What the licence actually permits, in a sentence someone can act on. */
  readonly licence: string;
  /** Required credit, or null when none is. */
  readonly attribution: string | null;
  readonly bytes: number;
  /** Path within rhasspy/piper-voices. */
  readonly repoPath: string;
}

/**
 * Voices whose model and dataset licences both permit shipping the audio.
 *
 * Short on purpose. A longer list nobody checked would be worse than useless —
 * it would look like clearance.
 */
export const VOICE_CATALOGUE: readonly CatalogueVoice[] = [
  {
    id: "en_US-ljspeech-medium",
    label: "LJSpeech — US English, female, clear",
    licence: "public-domain dataset, MIT model — no restrictions",
    attribution: null,
    bytes: 63531379,
    repoPath: "en/en_US/ljspeech/medium",
  },
  {
    id: "en_US-ljspeech-high",
    label: "LJSpeech (high) — same voice, larger model",
    licence: "public-domain dataset, MIT model — no restrictions",
    attribution: null,
    bytes: 114199011,
    repoPath: "en/en_US/ljspeech/high",
  },
  {
    id: "en_US-libritts_r-medium",
    label: "LibriTTS-R — US English, multi-speaker",
    licence: "CC BY 4.0 dataset, MIT model — commercial use with credit",
    attribution: "LibriTTS-R (CC BY 4.0)",
    bytes: 78580914,
    repoPath: "en/en_US/libritts_r/medium",
  },
];

const VOICE_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main";

export const voiceFileUrl = (voice: CatalogueVoice, suffix: ".onnx" | ".onnx.json"): string =>
  `${VOICE_BASE}/${voice.repoPath}/${voice.id}${suffix}`;

export interface InstalledVoice {
  readonly id: string;
  /** Absolute path to the .onnx. */
  readonly model: string;
  readonly bytes: number;
  /** The catalogue entry, when this is one we know the licence of. */
  readonly catalogue: CatalogueVoice | null;
}

/**
 * What is in the voices folder.
 *
 * A voice is a `.onnx` with its `.onnx.json` beside it — Piper needs both, and a
 * model whose config went missing fails at synthesis time with a message about
 * phoneme maps, so it is checked here instead.
 */
export async function listInstalledVoices(voicesDir: string): Promise<InstalledVoice[]> {
  let names: string[];
  try {
    names = await readdir(voicesDir);
  } catch {
    return [];
  }

  const voices: InstalledVoice[] = [];
  for (const name of names) {
    if (!name.endsWith(".onnx")) continue;
    if (!names.includes(`${name}.json`)) continue;
    const model = join(voicesDir, name);
    const id = name.replace(/\.onnx$/, "");
    voices.push({
      id,
      model,
      bytes: (await stat(model)).size,
      catalogue: VOICE_CATALOGUE.find((v) => v.id === id) ?? null,
    });
  }
  return voices.sort((a, b) => a.id.localeCompare(b.id));
}

export type Progress = (received: number, total: number) => void;

async function download(url: string, target: string, onProgress?: Progress): Promise<void> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || response.body === null) {
    throw new Error(`${url} — HTTP ${String(response.status)}`);
  }

  const total = Number(response.headers.get("content-length") ?? 0);
  let received = 0;

  const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  if (onProgress !== undefined) {
    body.on("data", (chunk: Buffer) => {
      received += chunk.length;
      onProgress(received, total);
    });
  }

  // Written to a partial name and renamed, so an interrupted download cannot
  // leave behind something that lists as an installed voice.
  const partial = `${target}.partial`;
  await pipeline(body, createWriteStream(partial));
  const { rename } = await import("node:fs/promises");
  await rename(partial, target);
}

/** Fetch a voice into the voices folder. Returns the .onnx path. */
export async function downloadVoice(
  voice: CatalogueVoice,
  voicesDir: string,
  onProgress?: Progress,
): Promise<string> {
  await mkdir(voicesDir, { recursive: true });
  const model = join(voicesDir, `${voice.id}.onnx`);

  // The config is small and useless alone, so it goes first: if the big download
  // fails, there is no orphaned .onnx sitting there looking installed.
  await download(voiceFileUrl(voice, ".onnx.json"), `${model}.json`);
  await download(voiceFileUrl(voice, ".onnx"), model, onProgress);
  return model;
}

export interface PiperLocation {
  readonly binary: string;
  /** How it was found, so the window can say whether anything needs doing. */
  readonly from: "setting" | "bundled" | "path" | "venv";
}

const isFile = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

/**
 * Where Piper is, in the order worth trying.
 *
 * An explicit setting wins — someone who built it themselves has a reason. Then
 * the copy this app installed, then whatever is on PATH, then the repo's Python
 * venv, which is how this project has always rendered and should keep working.
 */
export async function resolvePiper(options: {
  readonly setting?: string | null;
  readonly bundledDir: string;
  readonly repoRoot?: string;
  readonly platform?: NodeJS.Platform;
  readonly pathDirs?: readonly string[];
}): Promise<PiperLocation | null> {
  const platform = options.platform ?? process.platform;
  const exe = platform === "win32" ? "piper.exe" : "piper";

  if (options.setting != null && options.setting !== "" && (await isFile(options.setting))) {
    return { binary: options.setting, from: "setting" };
  }

  const bundled = join(options.bundledDir, "piper", exe);
  if (await isFile(bundled)) return { binary: bundled, from: "bundled" };

  const dirs = options.pathDirs ?? (process.env["PATH"] ?? "").split(platform === "win32" ? ";" : ":");
  for (const dir of dirs) {
    if (dir === "") continue;
    const candidate = join(dir, exe);
    if (await isFile(candidate)) return { binary: candidate, from: "path" };
  }

  if (options.repoRoot !== undefined) {
    const venv = join(options.repoRoot, ".venv", "bin", "piper");
    if (await isFile(venv)) return { binary: venv, from: "venv" };
  }

  return null;
}

/**
 * The standalone Piper build, per platform.
 *
 * 2023.11.14-2 is the last release with standalone binaries; everything since is
 * a Python wheel, which is not something an app can install for someone. The
 * archive is self-contained — onnxruntime, espeak-ng and its data — and the
 * model format has not changed, so it renders current voices.
 *
 * macOS is deliberately absent. That release's macOS tarball ships
 * `libonnxruntime.dylib.dSYM` — the debug symbols — without the `.dylib` itself,
 * so the binary cannot load and no amount of unpacking fixes it. Rendering on a
 * Mac goes through a pip-installed Piper instead, which is what the venv is.
 */
export const PIPER_DOWNLOADS: Partial<Record<NodeJS.Platform, { url: string; bytes: number }>> = {
  win32: {
    url: "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip",
    bytes: 22477236,
  },
  linux: {
    url: "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz",
    bytes: 26460462,
  },
};

/** What to tell someone whose platform has no self-installing build. */
export const PIPER_MANUAL_HINT =
  "No standalone Piper build works on macOS, so rendering here uses a " +
  "pip-installed one:  python3 -m venv .venv && .venv/bin/pip install piper-tts";

export interface PiperInstall {
  readonly ok: boolean;
  readonly message: string;
  readonly binary: string | null;
}

/**
 * Fetch and unpack Piper into `dir`, returning where the binary landed.
 *
 * Unpacking shells out to the platform's own extractor rather than adding an
 * archive dependency: `tar` is present on both, and Windows has had `tar.exe`
 * since 2018. The archive is a release asset from a known URL, not something a
 * user pointed at.
 */
export async function installPiper(
  dir: string,
  onProgress?: Progress,
  platform: NodeJS.Platform = process.platform,
): Promise<PiperInstall> {
  const source = PIPER_DOWNLOADS[platform];
  if (source === undefined) {
    return { ok: false, message: PIPER_MANUAL_HINT, binary: null };
  }

  await mkdir(dir, { recursive: true });
  const archive = join(dir, platform === "win32" ? "piper.zip" : "piper.tar.gz");

  try {
    await download(source.url, archive, onProgress);

    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("tar", ["-xf", archive, "-C", dir]);

    const binary = join(dir, "piper", platform === "win32" ? "piper.exe" : "piper");
    if (!(await isFile(binary))) {
      return { ok: false, message: `unpacked, but no ${binary}`, binary: null };
    }
    if (platform !== "win32") await chmod(binary, 0o755);

    const { rm } = await import("node:fs/promises");
    await rm(archive, { force: true });
    return { ok: true, message: `Piper installed in ${dir}`, binary };
  } catch (error) {
    return {
      ok: false,
      message: `Could not install Piper — ${error instanceof Error ? error.message : String(error)}`,
      binary: null,
    };
  }
}
