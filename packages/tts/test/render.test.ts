import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Note, NoteSet } from "@exxeed/core";
import { localRepositories, makeToneWav, type Repositories } from "@exxeed/repo";
import { renderNoteSet, type TtsEngine } from "@exxeed/tts";

import { spaGt3Notes } from "../../core/test/fixtures.js";

/** Says each text as a tone whose length depends on the words, and counts calls. */
class CountingEngine implements TtsEngine {
  readonly voiceId = "test-voice";
  calls: string[] = [];
  async synthesise(text: string): Promise<Uint8Array> {
    this.calls.push(text);
    return makeToneWav(200 + text.length * 10);
  }
}

let root: string;
let repos: Repositories;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "exxeed-render-"));
  repos = localRepositories(root);
  await repos.noteSets.put(spaGt3Notes);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const render = (noteSet: NoteSet, engine: CountingEngine, reuse: boolean) =>
  renderNoteSet({ noteSet, engine, audio: repos.audio, noteSets: repos.noteSets, reuse });

describe("renderNoteSet", () => {
  it("renders both variants of every note, measures them, and clears dirty", async () => {
    const engine = new CountingEngine();
    const result = await render({ ...spaGt3Notes, notes: spaGt3Notes.notes.map((n) => ({ ...n, dirty: true })) }, engine, false);
    expect(engine.calls).toHaveLength(4);
    expect(result.reused).toBe(0);
    expect(result.noteSet.notes.every((n) => !n.dirty)).toBe(true);
    expect(result.pack.files["t1_brake"]?.text).toBe("Brake at the hundred board");
  });

  it("with reuse, renders only the clips whose words changed", async () => {
    const first = new CountingEngine();
    const v1 = (await render(spaGt3Notes, first, true)).noteSet;

    // v2 rewords one note's full text and moves the other. Moving does not
    // change what is said, so only one clip needs redoing.
    const [brake, throttle] = v1.notes as [Note, Note];
    const v2: NoteSet = { ...v1, notes: [{ ...brake, text: "Brake at the marker board" }, { ...throttle, pct: 0.02 }] };

    const second = new CountingEngine();
    const result = await render(v2, second, true);
    expect(second.calls).toEqual(["Brake at the marker board"]);
    expect(result.reused).toBe(3);
    expect(result.noteSet.notes[1]?.audio.durationMs).toBe(v1.notes[1]?.audio.durationMs);
  });

  it("without reuse, renders everything again", async () => {
    await render(spaGt3Notes, new CountingEngine(), true);
    const again = new CountingEngine();
    await render(spaGt3Notes, again, false);
    expect(again.calls).toHaveLength(4);
  });

  it("re-renders a clip whose file has gone, even when the words match", async () => {
    await render(spaGt3Notes, new CountingEngine(), true);
    await rm(join(root, "audio", spaGt3Notes.id, "test-voice", "t1_brake.wav"));
    const again = new CountingEngine();
    await render(spaGt3Notes, again, true);
    expect(again.calls).toEqual(["Brake at the hundred board"]);
  });
});
