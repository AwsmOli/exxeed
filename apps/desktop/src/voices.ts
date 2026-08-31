/**
 * Where rendering gets its Piper and its voice.
 *
 * §10 stage 6 renders offline, once per note set, and the runtime plays the WAVs
 * that came out — so none of this is on the driving path. It is authoring setup,
 * and it used to be two absolute paths typed into text boxes. Now it is a folder
 * and a picker, the same shape as recordings.
 */

import { fileURLToPath } from "node:url";

import type { Settings } from "@exxeed/overlays";
import { listInstalledVoices, resolvePiper, PIPER_MANUAL_HINT } from "@exxeed/tts";

export const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url)).replace(/[\\/]+$/, "");

export const VOICES_DIR = `${REPO_ROOT}/data/voices`;
export const PIPER_DIR = `${REPO_ROOT}/data/piper`;

export interface RenderSetup {
  readonly binary: string;
  readonly model: string;
}

/**
 * Everything rendering needs, or the one sentence explaining what is missing.
 *
 * Both halves are resolved together because either one missing has the same
 * consequence — the render button does nothing — and an author wants to be told
 * which, once, rather than discovering the second after fixing the first.
 */
export async function resolveRenderSetup(
  settings: Settings,
): Promise<{ setup: RenderSetup; problem: null } | { setup: null; problem: string }> {
  const piper = await resolvePiper({
    setting: settings.piperBinary,
    bundledDir: PIPER_DIR,
    repoRoot: REPO_ROOT,
  });

  const voices = await listInstalledVoices(VOICES_DIR);
  const chosen =
    settings.renderVoiceId === null
      ? voices[0]
      : voices.find((v) => v.id === settings.renderVoiceId);

  if (piper === null && chosen === undefined) {
    return {
      setup: null,
      problem:
        process.platform === "darwin"
          ? `No Piper and no voice yet. Download a voice in preferences; for Piper, ${PIPER_MANUAL_HINT}`
          : "No Piper and no voice yet — install both from preferences.",
    };
  }
  if (piper === null) {
    return {
      setup: null,
      problem:
        process.platform === "darwin"
          ? `Piper is not installed. ${PIPER_MANUAL_HINT}`
          : "Piper is not installed — install it from preferences.",
    };
  }
  if (chosen === undefined) {
    return {
      setup: null,
      problem:
        settings.renderVoiceId === null
          ? "No voice installed — download one in preferences."
          : `Voice "${settings.renderVoiceId}" is not in ${VOICES_DIR} any more — pick another in preferences.`,
    };
  }

  return { setup: { binary: piper.binary, model: chosen.model }, problem: null };
}
