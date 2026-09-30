/**
 * The note editor's data — SPEC.md §7.4.
 *
 * A normal window, not an overlay, and SVG rather than Canvas: this view is
 * interactive, changes at human speed, and needs hit-testing on every element.
 * None of §7.0's hot-path rules apply.
 *
 * §7.4's argument for building it: the trigger windows turn three otherwise
 * invisible problems into things you can see — two callouts overlapping, a
 * callout reaching back past the previous corner, and the cost of a longer
 * sentence. Everything here exists to draw those.
 */

import { fileURLToPath } from "node:url";

import { BrowserWindow, ipcMain } from "electron";

import type {
  EditorNote,
  EditorNotePatch,
  EditorPayload,
  RenderResultView,
  Settings,
} from "@exxeed/overlays";
import {
  EDITOR_LOAD_CHANNEL,
  EDITOR_RENDER_CHANNEL,
  EDITOR_RENDER_REQUEST_CHANNEL,
  EDITOR_SAVE_CHANNEL,
} from "@exxeed/overlays";
import { PiperEngine, renderNoteSet } from "@exxeed/tts";

import { resolveRenderSetup } from "./voices.js";
import { pullForTrack } from "./cloud-sync.js";
import type { Note, NoteSet, ReferenceLap, TrackKey, TrackMap } from "@exxeed/core";
import {
  aheadM,
  classOf,
  metres,
  nearestBrakeOnset,
  NOTE_ID_PATTERN,
  pct,
  placeholderMs,
  triggerWindow,
} from "@exxeed/core";
import { localRepositories } from "@exxeed/repo";
import { slug } from "@exxeed/telemetry";

import { toMapView } from "./map-view.js";

const PAGE = fileURLToPath(new URL("../static/editor.html", import.meta.url));

interface Loaded {
  readonly noteSet: NoteSet;
  readonly map: TrackMap | null;
  readonly reference: ReferenceLap | null;
}

async function load(dataDir: string, noteSetId: string): Promise<Loaded> {
  const repos = localRepositories(dataDir);

  const noteSet = await repos.noteSets.get(noteSetId);
  if (noteSet === null) throw new Error(`no note set "${noteSetId}" under ${dataDir}`);

  // A note set can arrive without its map — maps are per machine, and this one
  // may never have driven the track. Someone may have shared it (M8 step 2).
  if ((await repos.trackMaps.latestVersion(noteSet.trackKey)) === null) {
    await pullForTrack(dataDir, noteSet.trackKey, (line) => process.stdout.write(line));
  }

  const mapVersion = await repos.trackMaps.latestVersion(noteSet.trackKey);
  const map =
    mapVersion === null ? null : await repos.trackMaps.get({ ...noteSet.trackKey, mapVersion });

  const cars = await repos.referenceLaps.listCars(noteSet.trackKey);
  const carId = cars[0];
  const reference =
    carId === undefined ? null : await repos.referenceLaps.get(noteSet.trackKey, carId);

  return { noteSet, map, reference };
}

function buildNotes(loaded: Loaded, leadAdjustS: number): EditorNote[] {
  const { noteSet, reference } = loaded;
  const lengthM = metres(noteSet.lengthM);
  const profile = { leadAdjustS };

  const notes: EditorNote[] = noteSet.notes.map((note) => {
    const base = {
      id: note.id,
      pct: note.pct,
      text: note.text,
      textShort: note.textShort,
      priority: note.priority,
      leadAdjustS: note.leadAdjustS,
      dirty: note.dirty,
      durationMs: note.audio.durationMs,
      shortDurationMs: note.audioShort.durationMs,
      overlaps: [] as string[],
    };

    if (reference === null) {
      return {
        ...base,
        startPct: note.pct,
        runtimeStartPct: note.pct,
        leadS: 0,
        windowM: 0,
        suggestedLeadAdjustS: 0,
        nearestOnsetPct: null,
      };
    }

    const w = triggerWindow(note, reference, lengthM, profile);
    return {
      ...base,
      startPct: w.startPct,
      runtimeStartPct: w.runtimeStartPct,
      leadS: w.leadS,
      windowM: w.lengthM,
      suggestedLeadAdjustS: w.suggestedLeadAdjustS,
      nearestOnsetPct: nearestBrakeOnset(pct(note.pct), reference, lengthM),
    };
  });

  // Which windows collide. §6.3 resolves this at runtime by dropping a note; the
  // point of showing it here is that the author fixes it before it happens.
  return notes.map((note) => ({
    ...note,
    overlaps: notes
      .filter((other) => other.id !== note.id && overlapping(note, other, noteSet.lengthM))
      .map((other) => other.id),
  }));
}

/** Do two speaking windows share any track? Wrap-safe, so S/F is not special. */
function overlapping(a: EditorNote, b: EditorNote, lengthM: number): boolean {
  if (a.windowM === 0 || b.windowM === 0) return false;
  const L = metres(lengthM);
  // Walk a's window forward and ask whether b's start falls inside it.
  const aSpan = aheadM(pct(a.startPct), pct(a.pct), L);
  const bFromA = aheadM(pct(a.startPct), pct(b.startPct), L);
  return bFromA < aSpan;
}

async function buildPayload(
  dataDir: string,
  noteSetId: string,
  leadAdjustS: number,
  canRender: boolean,
): Promise<EditorPayload> {
  const loaded = await load(dataDir, noteSetId);
  const view = loaded.map === null ? null : toMapView(loaded.map, loaded.noteSet.notes);

  return {
    noteSetId: loaded.noteSet.id,
    title:
      loaded.map?.trackName ??
      `track ${loaded.noteSet.trackKey.trackId} (${loaded.noteSet.trackKey.configId})`,
    lengthM: loaded.noteSet.lengthM,
    status: loaded.noteSet.status,
    x: view?.x ?? [],
    y: view?.y ?? [],
    corners: loaded.map?.corners.map((c) => ({
      index: c.index,
      entryPct: c.entryPct,
      apexPct: c.apexPct,
      exitPct: c.exitPct,
    })) ?? [],
    notes: buildNotes(loaded, leadAdjustS),
    hasReference: loaded.reference !== null,
    canRender,
  };
}

/**
 * Whether the render button can do anything. Async because it is a question
 * about the filesystem — is Piper there, is a voice there — not about the
 * settings object, which is the whole point of the change: an author no longer
 * declares where those are, so the app has to look.
 */
const canRender = async (settings: Settings): Promise<boolean> =>
  (await resolveRenderSetup(settings)).problem === null;

export function installEditorIpc(
  getSettings: () => Settings,
  resolveDataDir: (settings: Settings) => string,
): void {
  ipcMain.handle(EDITOR_LOAD_CHANNEL, async () => {
    const settings = getSettings();
    if (settings.noteSetId === null) return null;
    return buildPayload(
      resolveDataDir(settings),
      settings.noteSetId,
      settings.leadAdjustS,
      await canRender(settings),
    );
  });

  /**
   * Stage 6, from the editor.
   *
   * §7.4 wants the author to hear what they just wrote and judge its length, and
   * the length is not a detail — `durationMs` sets lead distance, so a note whose
   * text has changed is mistimed until it is re-rendered, not merely mispronounced.
   * Dropping to a CLI and reopening the window to find that out is exactly the
   * friction that stops anyone doing it.
   */
  ipcMain.handle(EDITOR_RENDER_CHANNEL, async (): Promise<RenderResultView> => {
    const settings = getSettings();
    if (settings.noteSetId === null) {
      return { ok: false, message: "no note set selected", payload: null };
    }
    const resolved = await resolveRenderSetup(settings);
    if (resolved.problem !== null) {
      return { ok: false, message: resolved.problem, payload: null };
    }

    const dataDir = resolveDataDir(settings);
    const repos = localRepositories(dataDir);
    const noteSet = await repos.noteSets.get(settings.noteSetId);
    if (noteSet === null) {
      return { ok: false, message: `no note set "${settings.noteSetId}"`, payload: null };
    }

    const engine = new PiperEngine({
      binary: resolved.setup.binary,
      model: resolved.setup.model,
      voiceId: settings.voiceId,
    });

    try {
      const result = await renderNoteSet({
        noteSet,
        engine,
        audio: repos.audio,
        noteSets: repos.noteSets,
      });
      return {
        ok: true,
        message: `rendered ${result.clips.length} clips`,
        payload: await buildPayload(
          dataDir,
          settings.noteSetId,
          settings.leadAdjustS,
          await canRender(settings),
        ),
      };
    } catch (err) {
      // Piper missing, a bad model path, a voice that will not load — all of it
      // belongs in front of the author rather than in a terminal they are not
      // looking at.
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        payload: null,
      };
    }
  });

  ipcMain.handle(EDITOR_SAVE_CHANNEL, async (_event, patches: EditorNotePatch[]) => {
    const settings = getSettings();
    if (settings.noteSetId === null) return null;

    const dataDir = resolveDataDir(settings);
    const repos = localRepositories(dataDir);
    const noteSet = await repos.noteSets.get(settings.noteSetId);
    if (noteSet === null) return null;

    const byId = new Map(patches.map((p) => [p.id, p]));
    const existing = new Set(noteSet.notes.map((n) => n.id));

    // New notes: ids the set does not have yet. Stale by definition — nothing
    // has been spoken — with a placeholder duration until the render measures
    // one, the same as an import (core/import.ts).
    const added: Note[] = patches
      .filter((p) => !existing.has(p.id) && p.deleted !== true && NOTE_ID_PATTERN.test(p.id))
      .map((p) => ({
        id: p.id,
        pct: p.pct,
        text: p.text.trim() || "New callout",
        textShort: p.textShort.trim() || p.text.trim() || "New callout",
        priority: 1,
        leadAdjustS: p.leadAdjustS,
        audio: { file: `manual/${p.id}.wav`, durationMs: placeholderMs(p.text) },
        audioShort: { file: `manual/${p.id}_short.wav`, durationMs: placeholderMs(p.textShort) },
        dirty: true,
      }));

    const kept = noteSet.notes.filter((note) => byId.get(note.id)?.deleted !== true);
    const notes: Note[] = kept.map((note) => {
      const patch = byId.get(note.id);
      if (patch === undefined) return note;

      // Changing the text makes the rendered audio stale, and its duration is an
      // input to the trigger — so a stale note is not merely mispronounced, it is
      // mistimed (§7.4). Moving a note does not have that effect.
      const textChanged = patch.text !== note.text || patch.textShort !== note.textShort;

      return {
        ...note,
        pct: patch.pct,
        text: patch.text,
        textShort: patch.textShort,
        leadAdjustS: patch.leadAdjustS,
        dirty: note.dirty || textChanged,
      };
    });

    notes.push(...added);
    // Keep the file in track order, which is the order it is read and heard in.
    notes.sort((a, b) => a.pct - b.pct);

    await repos.noteSets.put({ ...noteSet, notes });
    return buildPayload(
      dataDir,
      settings.noteSetId,
      settings.leadAdjustS,
      await canRender(settings),
    );
  });
}

/**
 * An empty, hand-authored note set for a mapped track — what "write manually"
 * starts from. The map supplies the length; the car class comes from whichever
 * car drove the reference lap, since that is the car the notes will be timed
 * against. Returns the new set's id.
 */
export async function createManualNoteSet(dataDir: string, key: TrackKey): Promise<string> {
  const repos = localRepositories(dataDir);
  const version = await repos.trackMaps.latestVersion(key);
  const map = version === null ? null : await repos.trackMaps.get({ ...key, mapVersion: version });
  if (map === null) throw new Error(`no track map for track ${key.trackId}/${key.configId}`);

  const carId = (await repos.referenceLaps.listCars(key))[0];
  const registry = await repos.cars.get(key.sim);
  const carClass = (carId === undefined ? null : classOf(registry, carId)) ?? (carId ? slug(carId) : "unknown");

  // Unique among what is on disk: a second "write manually" for the same track
  // is a second set, never an overwrite of the first.
  const taken = new Set((await repos.noteSets.listAll()).map((s) => s.id));
  const base = slug(`${map.trackName}-${key.configId}-${carClass}-manual`);
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;

  await repos.noteSets.put({
    id,
    trackKey: key,
    lengthM: map.lengthM,
    carClass,
    source: { type: "manual" },
    status: "draft",
    createdAt: new Date().toISOString(),
    notes: [],
  });
  return id;
}

let editor: BrowserWindow | null = null;

/**
 * Ask the editor to render, from the menu.
 *
 * Routed through the window rather than run here so there is one path: the same
 * save-first, redraw-after sequence the button follows. Two ways to start a
 * render that behaved differently would be worse than one.
 */
export function requestRender(preload: string): void {
  const window = openEditor(preload);
  if (window.webContents.isLoading()) {
    window.webContents.once("did-finish-load", () =>
      window.webContents.send(EDITOR_RENDER_REQUEST_CHANNEL),
    );
  } else {
    window.webContents.send(EDITOR_RENDER_REQUEST_CHANNEL);
  }
}

/**
 * `reload` when the note set being edited has just changed: the window loads its
 * set once, so an open editor would otherwise go on showing the previous one.
 */
export function openEditor(preload: string, options: { readonly reload?: boolean } = {}): BrowserWindow {
  if (editor !== null && !editor.isDestroyed()) {
    if (options.reload === true) editor.webContents.reload();
    editor.show();
    editor.focus();
    return editor;
  }

  editor = new BrowserWindow({
    width: 1180,
    height: 860,
    title: "Exxeed — Notes",
    backgroundColor: "#101215",
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: false },
  });

  void editor.loadFile(PAGE);
  editor.once("closed", () => {
    editor = null;
  });
  return editor;
}
