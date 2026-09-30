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
  LAP_IMPORT_CHANNEL,
  type LapImportDraft,
  type LapImportRequest,
  type Settings,
} from "@exxeed/overlays";
import { listCatalogCars, listLayouts, localRepositories } from "@exxeed/repo";
import { buildTrackMap, garage61FileInfo, parseGarage61Csv, type TelemetryFrame } from "@exxeed/telemetry";

import { accountView, cloudClient } from "./account.js";
import { readOverrides } from "./auto-map.js";
import { shareTrack } from "./cloud-sync.js";

interface LapImportDeps {
  readonly getSettings: () => Settings;
  readonly resolveDataDir: (settings: Settings) => string;
  /** Maps and reference laps changed on disk; redraw what shows them. */
  readonly changed: () => void;
}

/** The lap waiting for confirmation. One at a time: a new pick replaces it. */
let pending: { token: string; frames: TelemetryFrame[]; fileName: string } | null = null;

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

  const frames = parseGarage61Csv(await readFile(path, "utf8"));
  const token = randomUUID();
  pending = { token, frames, fileName: basename(path) };

  const dataDir = deps.resolveDataDir(deps.getSettings());
  const named = garage61FileInfo(path);
  const layouts = await knownLayouts(dataDir);
  const ranked = [...layouts].sort(
    (a, b) => layoutScore(b, named.track, named.layout) - layoutScore(a, named.track, named.layout),
  );
  const best = ranked[0];
  const suggested =
    best !== undefined && layoutScore(best, named.track, named.layout) === 3 ? best.trackKey : null;

  const cars = await knownCars(dataDir);
  const want = named.car === null ? null : normalise(named.car);
  const car =
    want === null
      ? undefined
      : cars.find((c) => normalise(c.name) === want) ??
        cars.find((c) => want.includes(normalise(c.name)) || normalise(c.name).includes(want));

  const last = frames[frames.length - 1]!;
  return {
    token,
    fileName: basename(path),
    driver: named.driver,
    carName: named.car,
    trackName: named.track,
    layoutName: named.layout,
    lapTimeS: last.tMs / 1000,
    samples: frames.length,
    layouts: ranked.map((l) => ({ trackKey: l.trackKey as LapImportDraft["layouts"][number]["trackKey"], label: l.label, hasMap: l.hasMap })),
    suggestedLayout: suggested as LapImportDraft["suggestedLayout"],
    cars,
    suggestedCarId: car?.carId ?? null,
  };
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
  const layout = (await knownLayouts(dataDir)).find((l) => sameKey(l.trackKey, key));
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
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
