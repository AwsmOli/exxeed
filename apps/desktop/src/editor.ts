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
import type { Note, NoteSet, ReferenceLap, TrackMap } from "@exxeed/core";
import { aheadM, metres, nearestBrakeOnset, pct, triggerWindow } from "@exxeed/core";
import { localRepositories } from "@exxeed/repo";

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
    title: loaded.map?.trackName ?? loaded.noteSet.trackKey.configId,
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

const canRender = (settings: Settings): boolean =>
  settings.piperModel !== null && settings.piperModel !== "";

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
      canRender(settings),
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
    if (settings.piperModel === null || settings.piperModel === "") {
      return {
        ok: false,
        message: "no voice model set — add one in preferences",
        payload: null,
      };
    }

    const dataDir = resolveDataDir(settings);
    const repos = localRepositories(dataDir);
    const noteSet = await repos.noteSets.get(settings.noteSetId);
    if (noteSet === null) {
      return { ok: false, message: `no note set "${settings.noteSetId}"`, payload: null };
    }

    const engine = new PiperEngine({
      binary: settings.piperBinary ?? "piper",
      model: settings.piperModel,
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
          canRender(settings),
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
    const notes: Note[] = noteSet.notes.map((note) => {
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

    // Keep the file in track order, which is the order it is read and heard in.
    notes.sort((a, b) => a.pct - b.pct);

    await repos.noteSets.put({ ...noteSet, notes });
    return buildPayload(
      dataDir,
      settings.noteSetId,
      settings.leadAdjustS,
      canRender(settings),
    );
  });
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

export function openEditor(preload: string): BrowserWindow {
  if (editor !== null && !editor.isDestroyed()) {
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
