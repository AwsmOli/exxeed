/**
 * Rendering a note set's audio without anyone setting rendering up first.
 *
 * An imported set is silent until it is rendered (§10 stage 6), and rendering
 * needs Piper and a voice. Both used to be a trip to Preferences before the
 * first import could be heard. Now the import does it: whatever is missing is
 * installed — the same downloads Preferences offers, from the same places — and
 * then the set is rendered. A voice already chosen or installed is used as is.
 */

import {
  downloadVoice,
  installPiper,
  listInstalledVoices,
  PiperEngine,
  renderNoteSet,
  resolvePiper,
  VOICE_CATALOGUE,
} from "@exxeed/tts";
import type { Settings } from "@exxeed/overlays";
import { localRepositories } from "@exxeed/repo";

import { PIPER_DIR, REPO_ROOT, resolveRenderSetup, VOICES_DIR } from "./voices.js";

export type RenderProgress = (stage: "piper" | "voice" | "render", received: number, total: number) => void;

/** Install Piper and a voice if either is missing. Returns a reason when that cannot be done here. */
async function ensureRenderTools(settings: Settings, progress: RenderProgress): Promise<string | null> {
  const piper = await resolvePiper({ setting: settings.piperBinary, bundledDir: PIPER_DIR, repoRoot: REPO_ROOT });
  if (piper === null) {
    const installed = await installPiper(PIPER_DIR, (r, t) => progress("piper", r, t));
    if (!installed.ok) return installed.message;
  }

  if ((await listInstalledVoices(VOICES_DIR)).length === 0) {
    // The first in the catalogue: the one whose dataset and model licences carry
    // no conditions at all, so nothing about using it needs a decision.
    const voice = VOICE_CATALOGUE[0];
    if (voice === undefined) return "no voice to download";
    await downloadVoice(voice, VOICES_DIR, (r, t) => progress("voice", r, t));
  }
  return null;
}

export async function renderImported(
  settings: Settings,
  dataDir: string,
  noteSetId: string,
  progress: RenderProgress,
): Promise<{ ok: true; clips: number } | { ok: false; message: string }> {
  try {
    const missing = await ensureRenderTools(settings, progress);
    if (missing !== null) return { ok: false, message: missing };

    const resolved = await resolveRenderSetup(settings);
    if (resolved.problem !== null) return { ok: false, message: resolved.problem };

    const repos = localRepositories(dataDir);
    const noteSet = await repos.noteSets.get(noteSetId);
    if (noteSet === null) return { ok: false, message: `no note set "${noteSetId}"` };

    const total = noteSet.notes.length * 2;
    let done = 0;
    const result = await renderNoteSet({
      noteSet,
      engine: new PiperEngine({ binary: resolved.setup.binary, model: resolved.setup.model, voiceId: settings.voiceId }),
      audio: repos.audio,
      noteSets: repos.noteSets,
      onClip: () => progress("render", ++done, total),
    });
    return { ok: true, clips: result.clips.length };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
