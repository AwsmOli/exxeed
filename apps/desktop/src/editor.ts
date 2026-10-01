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
  EditorAudio,
  EditorBraking,
  EditorCorner,
  EditorNote,
  EditorNotePatch,
  EditorPayload,
  EditorRenderProgress,
  RenderResultView,
  Settings,
} from "@exxeed/overlays";
import {
  EDITOR_AUDIO_CHANNEL,
  EDITOR_CORNER_NAME_CHANNEL,
  EDITOR_LOAD_CHANNEL,
  EDITOR_PREVIEW_CHANNEL,
  EDITOR_RENDER_CHANNEL,
  EDITOR_RENDER_PROGRESS_CHANNEL,
  EDITOR_RENDER_REQUEST_CHANNEL,
  EDITOR_SAVE_CHANNEL,
} from "@exxeed/overlays";
import { PiperEngine, renderNoteSet } from "@exxeed/tts";

import { resolveRenderSetup } from "./voices.js";
import { pullForTrack } from "./cloud-sync.js";
import { pushDraft } from "./publish.js";
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
    // The engine times callouts along this same reference lap (lead-model.ts),
    // so at reference pace it starts where the window does: no gap to draw and
    // no lead adjustment to suggest. `w.runtimeStartPct` is the old
    // constant-speed engine's start, which nothing uses any more.
    return {
      ...base,
      startPct: w.startPct,
      runtimeStartPct: w.startPct,
      leadS: w.leadS,
      windowM: w.lengthM,
      suggestedLeadAdjustS: 0,
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

/** Brake pressure that counts as braking: above trail-braking noise and a resting foot. */
const BRAKE_ON = 0.08;
/** Shorter gaps than this inside a zone are one stop, not two (a stab and re-apply). */
const BRAKE_GAP_M = 15;
/** Shorter zones than this are a dab, not a braking zone. */
const BRAKE_MIN_M = 8;

/**
 * Where the reference lap had the brake on, and where braking for each turn
 * starts. From the same lap and the same per-corner onsets the "snap to
 * braking point" button uses, so what is drawn is what a note snaps to.
 */
function buildBraking(reference: ReferenceLap, lengthM: number): EditorBraking {
  const { brake, speedMps } = reference.channels;
  const n = brake.length;
  const cellM = lengthM / n;
  const on = (i: number): boolean => (brake[((i % n) + n) % n] ?? 0) > BRAKE_ON;

  // Start the scan where the brake is off, so a zone across the line is not cut in two.
  let origin = 0;
  while (origin < n && on(origin)) origin++;

  const zones: { startPct: number; endPct: number }[] = [];
  let start: number | null = null;
  let gap = 0;
  for (let k = 1; k <= n; k++) {
    const i = origin + k;
    if (on(i)) {
      start ??= i;
      gap = 0;
    } else if (start !== null && ++gap * cellM > BRAKE_GAP_M) {
      const end = i - gap;
      if ((end - start + 1) * cellM >= BRAKE_MIN_M) {
        zones.push({ startPct: (start % n) / n, endPct: ((end + 1) % n) / n });
      }
      start = null;
      gap = 0;
    }
  }
  if (start !== null) zones.push({ startPct: (start % n) / n, endPct: ((origin + n - gap + 1) % n) / n });

  const points = Object.entries(reference.perCorner)
    .filter(([, c]) => c.brakeOnsetPct !== null)
    .map(([turn, c]) => ({
      turn: Number(turn),
      pct: c.brakeOnsetPct!,
      speedKph: (speedMps[Math.floor(c.brakeOnsetPct! * n) % n] ?? 0) * 3.6,
      minSpeedKph: c.minSpeedMps * 3.6,
    }))
    .sort((a, b) => a.pct - b.pct);

  return { zones, points, inferred: reference.brakeChannelInferred };
}

const editorCorners = (map: TrackMap): EditorCorner[] =>
  map.corners.map((c) => ({
    index: c.index,
    names: c.names,
    entryPct: c.entryPct,
    apexPct: c.apexPct,
    exitPct: c.exitPct,
  }));

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
    lapElapsedS: loaded.reference === null ? null : [...loaded.reference.channels.elapsedS],
    title:
      loaded.map?.trackName ??
      `track ${loaded.noteSet.trackKey.trackId} (${loaded.noteSet.trackKey.configId})`,
    lengthM: loaded.noteSet.lengthM,
    status: loaded.noteSet.status,
    x: view?.x ?? [],
    y: view?.y ?? [],
    corners: loaded.map === null ? [] : editorCorners(loaded.map),
    notes: buildNotes(loaded, leadAdjustS),
    hasReference: loaded.reference !== null,
    canRender,
    braking: loaded.reference === null ? null : buildBraking(loaded.reference, loaded.noteSet.lengthM),
    inputs:
      loaded.reference === null
        ? null
        : {
            throttle: [...loaded.reference.channels.throttle],
            brake: [...loaded.reference.channels.brake],
            speedKph: loaded.reference.channels.speedMps.map((v) => v * 3.6),
          },
  };
}

/**
 * The editor's patches applied to a note set: moved, reworded, added and
 * deleted notes. Shared by Save, which writes the result, and the preview,
 * which only times it — so what Play lap previews is what Save would keep.
 */
function applyPatches(noteSet: NoteSet, patches: readonly EditorNotePatch[]): Note[] {
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
  return notes.sort((a, b) => a.pct - b.pct);
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
  /**
   * The open set's clips, for Play lap. In the voice set in preferences —
   * the one a session would play — and only clips that exist: a note whose
   * text changed since rendering has none, and the editor says so.
   */
  ipcMain.handle(EDITOR_AUDIO_CHANNEL, async (): Promise<EditorAudio | null> => {
    const settings = getSettings();
    if (settings.noteSetId === null) return null;
    const repos = localRepositories(resolveDataDir(settings));
    const pack = await repos.audio.getPack(settings.noteSetId, settings.voiceId);
    if (pack === null) return null;
    const clips: Record<string, Uint8Array> = {};
    for (const key of Object.keys(pack.files)) {
      const bytes = await repos.audio.readFile(pack, key);
      if (bytes !== null) clips[key] = bytes;
    }
    return { voiceId: pack.voiceId, clips };
  });

  /**
   * Name a corner. The name goes first in the corner's `names` (other aliases
   * are kept) on the map on this machine; the geometry is untouched. Names
   * are what the list and map show, and what the YouTube importer matches a
   * spoken "into Riches" against. An empty name removes the first one.
   */
  ipcMain.handle(
    EDITOR_CORNER_NAME_CHANNEL,
    async (_event, request: { index: number; name: string }): Promise<EditorCorner[] | null> => {
      const settings = getSettings();
      if (settings.noteSetId === null) return null;
      const repos = localRepositories(resolveDataDir(settings));
      const noteSet = await repos.noteSets.get(settings.noteSetId);
      if (noteSet === null) return null;
      const version = await repos.trackMaps.latestVersion(noteSet.trackKey);
      if (version === null) return null;
      const map = await repos.trackMaps.get({ ...noteSet.trackKey, mapVersion: version });
      if (map === null) return null;

      const name = String(request.name).trim().slice(0, 60);
      const corners = map.corners.map((c) => {
        if (c.index !== request.index) return c;
        const rest = c.names.slice(1).filter((n) => n.toLowerCase() !== name.toLowerCase());
        return { ...c, names: name === "" ? rest : [name, ...rest] };
      });
      const next = { ...map, corners };
      await repos.trackMaps.put(next);
      return editorCorners(next);
    },
  );

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
  ipcMain.handle(EDITOR_RENDER_CHANNEL, async (event): Promise<RenderResultView> => {
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
        onProgress: ({ done, total, noteId, variant }) => {
          if (event.sender.isDestroyed()) return;
          const progress: EditorRenderProgress = { done, total, noteId, variant };
          event.sender.send(EDITOR_RENDER_PROGRESS_CHANNEL, progress);
        },
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

  /**
   * The speaking windows as they would be after a save, without saving: the
   * editor asks after every edit, so the lines on the map and Play lap's next
   * lap follow a moved callout or a new lead straight away.
   */
  ipcMain.handle(EDITOR_PREVIEW_CHANNEL, async (_event, patches: EditorNotePatch[]) => {
    const settings = getSettings();
    if (settings.noteSetId === null) return null;
    const loaded = await load(resolveDataDir(settings), settings.noteSetId);
    const noteSet = { ...loaded.noteSet, notes: applyPatches(loaded.noteSet, patches) };
    return buildNotes({ ...loaded, noteSet }, settings.leadAdjustS);
  });

  ipcMain.handle(EDITOR_SAVE_CHANNEL, async (_event, patches: EditorNotePatch[]) => {
    const settings = getSettings();
    if (settings.noteSetId === null) return null;

    const dataDir = resolveDataDir(settings);
    const repos = localRepositories(dataDir);
    const noteSet = await repos.noteSets.get(settings.noteSetId);
    if (noteSet === null) return null;

    const notes = applyPatches(noteSet, patches);

    await repos.noteSets.put({ ...noteSet, notes });
    // A published pack's working copy follows its owner to their other machines.
    void pushDraft(dataDir, noteSet.id);
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
    width: 1360,
    height: 880,
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
