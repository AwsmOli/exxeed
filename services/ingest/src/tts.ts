/**
 * Text to speech — SPEC.md §10, stage 6.
 *
 * "Render offline, once per note set, for BOTH text variants. Measure each file
 * for its real duration and store it. Never estimate duration, never call a TTS
 * API at runtime."
 *
 * The engine is an interface because §13's open question 4 calls the provider
 * swappable, and it should stay that way: the only thing the rest of the system
 * knows about a voice is that it turns a string into a WAV.
 */

import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TtsEngine {
  /** Recorded as the AudioPack's voiceId, so a pack says what made it. */
  readonly voiceId: string;
  synthesise(text: string): Promise<Uint8Array>;
}

export interface PiperOptions {
  /** Path to the piper executable. */
  readonly binary: string;
  /** Path to the .onnx voice model. Its .onnx.json must sit beside it. */
  readonly model: string;
  /** Speaking rate. Below 1 is faster — shorter callouts need less lead (§6.1). */
  readonly lengthScale?: number;
  readonly voiceId?: string;
}

/**
 * Piper — local, offline, free, native 16-bit WAV.
 *
 * ## Determinism is not the default, and it matters here
 *
 * Piper samples noise during inference, so the same sentence rendered twice
 * gives audio of *different length* — measured at ~240 ms of drift on a four
 * word callout. That is not a cosmetic problem: `durationMs` is an input to the
 * trigger (§6.1), so a re-render would silently retime every callout in the set
 * and the golden timeline (§9) would move for no reason anyone could see.
 *
 * Zeroing both noise scales fixes it — verified byte-identical across repeated
 * renders. They are passed on every invocation rather than left to a config file
 * or a README, because the failure mode of forgetting them is invisible.
 */
export class PiperEngine implements TtsEngine {
  readonly voiceId: string;
  readonly #binary: string;
  readonly #model: string;
  readonly #lengthScale: number;

  constructor(options: PiperOptions) {
    this.#binary = options.binary;
    this.#model = options.model;
    this.#lengthScale = options.lengthScale ?? 1;
    this.voiceId =
      options.voiceId ??
      (this.#model.split(/[/\\]/).pop() ?? "piper").replace(/\.onnx$/, "");
  }

  async synthesise(text: string): Promise<Uint8Array> {
    const out = join(tmpdir(), `exxeed-tts-${process.pid}-${Math.random().toString(36).slice(2)}.wav`);

    try {
      await this.#run(text, out);
      return await readFile(out);
    } finally {
      await rm(out, { force: true });
    }
  }

  #run(text: string, outPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        this.#binary,
        [
          "-m", this.#model,
          "-f", outPath,
          "--length-scale", String(this.#lengthScale),
          // See the class comment. Without these, duration drifts between runs.
          "--noise-scale", "0",
          "--noise-w-scale", "0",
        ],
        { stdio: ["pipe", "ignore", "pipe"] },
      );

      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", (err) =>
        reject(new Error(`could not run piper at "${this.#binary}": ${err.message}`)),
      );
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`piper exited ${String(code)}\n${stderr.trim()}`));
      });

      child.stdin.end(`${text}\n`);
    });
  }
}
