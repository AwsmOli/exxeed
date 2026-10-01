/**
 * Import a lap file as a map and reference lap — Garage 61 lap exports (CSV).
 *
 * A Garage 61 export carries real positions (garage61.ts), so it makes a
 * better map than a live recording can: drawn, not integrated. It carries no
 * iRacing ids, though, so the driver confirms which layout and car it is. The
 * file name usually says ("Garage 61 - driver - car - track (layout) - time -
 * id.csv"), and the dialog comes pre-filled from it.
 *
 * The rules are the auto-mapper's (auto-map.ts): an existing map is never
 * re-cut — corner numbers are what callouts are anchored to — so a lap for a
 * mapped track only replaces the reference lap, and only when faster.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { BrowserWindow, dialog, ipcMain, type WebContents } from "electron";

import type { TrackKey } from "@exxeed/core";
import {
  garage61Cars,
  garage61LapCsv,
  garage61Laps,
  garage61Me,
  garage61Tracks,
  type Garage61Car,
  type Garage61Lap,
  type Garage61Track,
} from "@exxeed/importer";
import {
  LAP_IMPORT_CHANNEL,
  type Garage61Catalog,
  type Garage61LapRow,
  type Garage61Status,
  type LapImportDraft,
  type LapImportRequest,
  type Settings,
} from "@exxeed/overlays";
import { listCatalogCars, listLayouts, localRepositories } from "@exxeed/repo";
import {
  buildTrackMap,
  garage61FileInfo,
  parseGarage61Csv,
  slug,
  type SessionIdentity,
  type TelemetryFrame,
} from "@exxeed/telemetry";

import { accountView, cloudClient } from "./account.js";
import { readOverrides } from "./auto-map.js";
import { shareTrack } from "./cloud-sync.js";
import { readSecrets, writeSecrets } from "./importer-secrets.js";

interface LapImportDeps {
  readonly getSettings: () => Settings;
  readonly resolveDataDir: (settings: Settings) => string;
  /** Maps and reference laps changed on disk; redraw what shows them. */
  readonly changed: () => void;
  /** The session being driven, to start a Garage 61 search on its track. */
  readonly identity: () => SessionIdentity | null;
}

/**
 * The lap waiting for confirmation. One at a time: a new pick replaces it.
 * `extraLayouts` holds a layout only the lap knows about — a Garage 61 track
 * not yet in the catalog — so `import` can find it again.
 */
let pending: { token: string; frames: TelemetryFrame[]; fileName: string; extraLayouts: Layout[] } | null = null;

const normalise = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const sameKey = (a: TrackKey, b: TrackKey): boolean =>
  a.sim === b.sim && a.trackId === b.trackId && a.configId === b.configId;

interface Layout {
  readonly trackKey: TrackKey;
  readonly label: string;
  readonly trackName: string;
  readonly configName: string;
  readonly lengthM: number | null;
  readonly hasMap: boolean;
}

/** Every layout the app knows: those mapped here, and the shared catalog's. */
async function knownLayouts(dataDir: string): Promise<Layout[]> {
  const local = await localRepositories(dataDir).trackMaps.listTracks();
  const catalog = await listLayouts(cloudClient()).catch(() => []);
  const all: Layout[] = local.map((t) => ({
    trackKey: t.key,
    label: t.configName === "" ? t.trackName : `${t.trackName} — ${t.configName}`,
    trackName: t.trackName,
    configName: t.configName,
    lengthM: null,
    hasMap: true,
  }));
  for (const c of catalog) {
    if (all.some((l) => sameKey(l.trackKey, c.trackKey))) continue;
    all.push({
      trackKey: c.trackKey,
      label: c.label,
      trackName: c.trackName ?? c.label,
      configName: c.configName ?? "",
      lengthM: c.lengthM ?? null,
      hasMap: false,
    });
  }
  return all.sort((a, b) => a.label.localeCompare(b.label));
}

/** How well a layout matches the names in the file: 0 none, 2 track, 3 track and layout. */
function layoutScore(l: Layout, track: string | null, layout: string | null): number {
  if (track === null) return 0;
  const t = normalise(track);
  const name = normalise(l.trackName);
  if (!(name === t || name.includes(t) || t.includes(name))) return 0;
  if (layout === null) return 2;
  const want = normalise(layout);
  const config = normalise(l.configName);
  return config === want || config.includes(want) || want.includes(config) ? 3 : 2;
}

async function knownCars(dataDir: string): Promise<{ carId: string; name: string }[]> {
  const catalog = await listCatalogCars(cloudClient()).catch(() => []);
  const registry = await localRepositories(dataDir).cars.get("iracing").catch(() => null);
  const cars = catalog.map((c) => ({ carId: c.carId, name: c.name }));
  for (const [carId, entry] of Object.entries(registry?.cars ?? {})) {
    if (!cars.some((c) => c.carId === carId)) cars.push({ carId, name: entry.name });
  }
  return cars.sort((a, b) => a.name.localeCompare(b.name));
}

interface LapInfo {
  readonly fileName: string;
  readonly driver: string | null;
  readonly car: string | null;
  readonly track: string | null;
  readonly layout: string | null;
  /** iRacing's TrackID, when the source knows it (Garage 61 does; a file name does not). */
  readonly iracingTrackId: number | null;
}

/**
 * A lap waiting for the driver to confirm track and car, with both pre-chosen
 * as well as the source allows. A track id is decisive — iRacing gives each
 * layout its own — so a Garage 61 lap lands on the right layout whatever it is
 * called; a file name is matched by name.
 */
async function draftFrom(deps: LapImportDeps, frames: TelemetryFrame[], info: LapInfo): Promise<LapImportDraft> {
  const dataDir = deps.resolveDataDir(deps.getSettings());
  const layouts = await knownLayouts(dataDir);
  const extraLayouts: Layout[] = [];

  let suggested: TrackKey | null = null;
  if (info.iracingTrackId !== null) {
    const byId = layouts.find((l) => l.trackKey.sim === "iracing" && l.trackKey.trackId === info.iracingTrackId);
    if (byId !== undefined) {
      suggested = byId.trackKey;
    } else {
      // Not driven or catalogued yet: a new layout under the track id. Its
      // layout id is slugged from this name; later sessions resolve to it by
      // track id (canonicalTrackKey), whatever the sim calls the layout.
      const name = info.track ?? `Track ${info.iracingTrackId}`;
      const layout: Layout = {
        trackKey: { sim: "iracing", trackId: info.iracingTrackId, configId: slug(info.layout || name) || "default" },
        label: `${name}${info.layout ? ` — ${info.layout}` : ""} (new)`,
        trackName: name,
        configName: info.layout ?? "",
        lengthM: null,
        hasMap: false,
      };
      extraLayouts.push(layout);
      suggested = layout.trackKey;
    }
  }

  const all = [...extraLayouts, ...layouts];
  const ranked =
    suggested !== null
      ? [...all].sort((a, b) => Number(sameKey(b.trackKey, suggested!)) - Number(sameKey(a.trackKey, suggested!)))
      : [...all].sort((a, b) => layoutScore(b, info.track, info.layout) - layoutScore(a, info.track, info.layout));
  if (suggested === null) {
    const best = ranked[0];
    if (best !== undefined && layoutScore(best, info.track, info.layout) === 3) suggested = best.trackKey;
  }

  const cars = await knownCars(dataDir);
  const want = info.car === null ? null : normalise(info.car);
  const car =
    want === null
      ? undefined
      : cars.find((c) => normalise(c.name) === want) ??
        cars.find((c) => want.includes(normalise(c.name)) || normalise(c.name).includes(want));

  const token = randomUUID();
  pending = { token, frames, fileName: info.fileName, extraLayouts };
  const last = frames[frames.length - 1]!;
  return {
    token,
    fileName: info.fileName,
    driver: info.driver,
    carName: info.car,
    trackName: info.track,
    layoutName: info.layout,
    lapTimeS: last.tMs / 1000,
    samples: frames.length,
    layouts: ranked.map((l) => ({ trackKey: l.trackKey as LapImportDraft["layouts"][number]["trackKey"], label: l.label, hasMap: l.hasMap })),
    suggestedLayout: suggested as LapImportDraft["suggestedLayout"],
    cars,
    suggestedCarId: car?.carId ?? null,
  };
}

async function pick(deps: LapImportDeps, sender: WebContents): Promise<LapImportDraft | null> {
  const window = BrowserWindow.fromWebContents(sender);
  const options = {
    title: "Import a lap",
    properties: ["openFile" as const],
    filters: [{ name: "Garage 61 lap export", extensions: ["csv"] }],
  };
  const picked = window === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(window, options);
  const path = picked.filePaths[0];
  if (picked.canceled || path === undefined) return null;

  const named = garage61FileInfo(path);
  return draftFrom(deps, parseGarage61Csv(await readFile(path, "utf8")), {
    fileName: basename(path),
    driver: named.driver,
    car: named.car,
    track: named.track,
    layout: named.layout,
    iracingTrackId: null,
  });
}

// ---------------------------------------------------------------------------
// Garage 61, straight from the API
// ---------------------------------------------------------------------------

const g61Token = (): string => {
  const token = readSecrets().garage61Token;
  if (token === undefined) throw new Error("connect Garage 61 first");
  return token;
};

let g61User: string | null = null;
let g61CatalogCache: { tracks: Garage61Track[]; cars: Garage61Car[] } | null = null;
/** The last search's laps, so a pick has the lap's details without asking again. */
const g61Laps = new Map<string, Garage61Lap>();

async function g61Status(): Promise<Garage61Status> {
  const token = readSecrets().garage61Token;
  if (token === undefined) return { connected: false, user: null };
  if (g61User === null) g61User = (await garage61Me(token).catch(() => null))?.name ?? null;
  return { connected: true, user: g61User };
}

async function g61Connect(token: string): Promise<Garage61Status> {
  const trimmed = token.trim();
  if (trimmed === "") throw new Error("paste a Garage 61 personal access token");
  // Checked before it is kept: a token Garage 61 refuses is not worth storing.
  const me = await garage61Me(trimmed);
  writeSecrets({ ...readSecrets(), garage61Token: trimmed });
  g61User = me.name;
  g61CatalogCache = null;
  return { connected: true, user: me.name };
}

function g61Disconnect(): Garage61Status {
  const { garage61Token: _dropped, ...rest } = readSecrets();
  writeSecrets(rest);
  g61User = null;
  g61CatalogCache = null;
  g61Laps.clear();
  return { connected: false, user: null };
}

async function g61Catalog(deps: LapImportDeps): Promise<Garage61Catalog> {
  const token = g61Token();
  g61CatalogCache ??= { tracks: await garage61Tracks(token), cars: await garage61Cars(token) };
  const driving = deps.identity()?.trackKey?.trackId ?? null;
  return {
    tracks: g61CatalogCache.tracks.map((t) => ({
      id: t.id,
      label: t.variant === "" ? t.name : `${t.name} — ${t.variant}`,
      iracingTrackId: t.iracingTrackId,
    })),
    cars: g61CatalogCache.cars.map((c) => ({ id: c.id, name: c.name })),
    suggestedTrackId: g61CatalogCache.tracks.find((t) => t.iracingTrackId !== null && t.iracingTrackId === driving)?.id ?? null,
  };
}

async function g61Search(trackId: number, carId: number | null, mineOnly: boolean): Promise<Garage61LapRow[]> {
  const laps = await garage61Laps(g61Token(), trackId, carId, { mineOnly });
  g61Laps.clear();
  for (const lap of laps) g61Laps.set(lap.id, lap);
  return laps.map((l) => ({
    id: l.id,
    driver: l.driver,
    car: l.car.name,
    lapTimeS: l.lapTimeS,
    startTime: l.startTime,
    clean: l.clean,
    trackTempC: l.trackTempC,
  }));
}

async function g61Pick(deps: LapImportDeps, lapId: string): Promise<LapImportDraft> {
  const lap = g61Laps.get(lapId);
  if (lap === undefined) throw new Error("search again — that lap is no longer in the list");
  const frames = parseGarage61Csv(await garage61LapCsv(g61Token(), lapId));
  return draftFrom(deps, frames, {
    fileName: `Garage 61 lap ${lapId}`,
    driver: lap.driver,
    car: lap.car.name,
    track: lap.track.name,
    layout: lap.track.variant === "" ? null : lap.track.variant,
    iracingTrackId: lap.track.iracingTrackId,
  });
}

const fmtLap = (s: number): string => {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(3).padStart(6, "0")}`;
};

async function importLap(deps: LapImportDeps, token: string, key: TrackKey, carId: string): Promise<string> {
  if (pending === null || pending.token !== token) throw new Error("that lap is no longer loaded — choose the file again");
  const { frames } = pending;
  const dataDir = deps.resolveDataDir(deps.getSettings());
  const repos = localRepositories(dataDir);
  const layout = [...pending.extraLayouts, ...(await knownLayouts(dataDir))].find((l) => sameKey(l.trackKey, key));
  if (layout === undefined) throw new Error("unknown layout");

  const version = await repos.trackMaps.latestVersion(key);
  const existing = version === null ? null : await repos.trackMaps.get({ ...key, mapVersion: version });

  let message: string;
  if (existing === null) {
    const overrides = await readOverrides(dataDir, key);
    const built = buildTrackMap(frames, {
      trackRef: { ...key, mapVersion: 1 },
      trackName: layout.trackName,
      configName: layout.configName,
      carId,
      // The sim's own length where the catalog has it; otherwise measured
      // from the lap's positions.
      ...(layout.lengthM !== null ? { lengthM: layout.lengthM } : {}),
      ...(overrides !== undefined ? { overrides } : {}),
    });
    await repos.trackMaps.put(built.map);
    await repos.referenceLaps.put(built.referenceLap);
    message =
      `Mapped ${layout.label}: ${built.corners.length} corners, ${built.map.lengthM.toFixed(0)} m, ` +
      `and a ${fmtLap(built.referenceLap.lapTimeS)} reference lap.`;
  } else {
    // Measured against the corners the map already has, never re-cut.
    const built = buildTrackMap(frames, {
      trackRef: existing.trackRef,
      trackName: existing.trackName,
      configName: existing.configName,
      carId,
      lengthM: existing.lengthM,
      corners: existing.corners,
    });
    const current = await repos.referenceLaps.get(key, carId);
    if (current !== null && current.lapTimeS <= built.referenceLap.lapTimeS) {
      return (
        `${layout.label} is already mapped, and your reference lap (${fmtLap(current.lapTimeS)}) is at least as fast ` +
        `as this one (${fmtLap(built.referenceLap.lapTimeS)}), so nothing changed.`
      );
    }
    await repos.referenceLaps.put(built.referenceLap);
    message = `${layout.label} was already mapped; the ${fmtLap(built.referenceLap.lapTimeS)} lap is now the reference.`;
  }

  pending = null;
  deps.changed();

  if (accountView().signedIn) {
    try {
      await shareTrack(dataDir, key);
      message += " Shared.";
    } catch (err) {
      message += ` Not shared: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return message;
}

export function installLapImport(deps: LapImportDeps): void {
  ipcMain.handle(LAP_IMPORT_CHANNEL, async (event, request: LapImportRequest) => {
    try {
      switch (request.op) {
        case "pick":
          return { ok: true, value: await pick(deps, event.sender) };
        case "import":
          return { ok: true, value: await importLap(deps, request.token, request.trackKey as TrackKey, request.carId) };
        case "g61Status":
          return { ok: true, value: await g61Status() };
        case "g61Connect":
          return { ok: true, value: await g61Connect(request.token) };
        case "g61Disconnect":
          return { ok: true, value: g61Disconnect() };
        case "g61Catalog":
          return { ok: true, value: await g61Catalog(deps) };
        case "g61Laps":
          return { ok: true, value: await g61Search(request.trackId, request.carId, request.mineOnly) };
        case "g61Pick":
          return { ok: true, value: await g61Pick(deps, request.lapId) };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
