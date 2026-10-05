/**
 * The importer and the tracer, as an assistant sees them.
 *
 * `AuthoringHost` (@exxeed/assistant) is what the authoring tools are written
 * against. This is the app's side of it, and it adds nothing of its own: every
 * method is a request the importer window already makes (`runImporter`), or a
 * call into the tracer window's page (`tracerCall`). A callout set made this
 * way went through the same parse, the same placing on the map and the same
 * render as one made by hand, because it is the same code.
 */

import type {
  AuthoringHost,
  AuthoringRaceWeek,
  AuthoringTarget,
  AuthoringTrack,
  AuthoringVideo,
  AuthoringVideoRef,
  Box,
  ImportOutcome,
  PacksHost,
  PackTarget,
  ToolImage,
  TracerHost,
  TracerStatus,
} from "@exxeed/assistant";
import type { DraftCallout, ParsedReply } from "@exxeed/importer";
import { localRepositories } from "@exxeed/repo";

import { sharedPacksFor, type ContentDeps } from "./content.js";
import { runImporter, type ImporterDeps, type TrackRequest, type VideoRequest } from "./importer.js";
import { installSharedPack } from "./library.js";
import { tracerCall, tracerVideo } from "./video-traces.js";

/** What the assistant needs of the app beyond what the importer already does. */
export interface AuthoringDeps extends ImporterDeps, ContentDeps {
  /**
   * A session is running against the sim. Then nothing may open on screen: a
   * window over the sim takes its focus, and the driver is mid-corner.
   */
  readonly sessionLive: () => boolean;
  /** The note set the running session loaded, or null. */
  readonly activeNoteSet: () => string | null;
  /** Select a note set — the session reloads with it — and open nothing. */
  readonly activate: (noteSetId: string) => void;
}

const trackRequest = (t: AuthoringTarget): TrackRequest => ({
  trackId: t.trackId,
  trackName: t.trackName,
  configName: t.configName,
  carName: t.carName,
  carId: t.carId,
});

const videoRequest = (v: AuthoringVideoRef): VideoRequest => ({ id: v.id, title: v.title, channel: v.channel });

/** "data:image/jpeg;base64,…" → what an MCP image is made of. */
function image(dataUrl: string): ToolImage {
  const match = /^data:(image\/(?:jpeg|png));base64,(.+)$/s.exec(dataUrl);
  if (match === null) throw new Error("the tracer did not return a picture");
  return { mimeType: match[1] as ToolImage["mimeType"], base64: match[2]! };
}

const CLOSED: TracerStatus = {
  video: null,
  ready: false,
  message: "The tracer is not open.",
  durationS: null,
  width: null,
  height: null,
  boxes: { pedals: null, line: null, speed: null, gear: null },
  reading: false,
  readAtS: null,
  readMessage: "",
  read: null,
  barsFound: { throttle: false, brake: false },
  crossings: [],
  lap: { startS: null, endS: null },
  speed: { shapes: 0, message: "" },
  gear: { shapes: 0, message: "" },
  built: null,
  buildMessage: "",
};

function tracerHost(deps: AuthoringDeps): TracerHost {
  return {
    open(video) {
      // Already on this video: leave it. Opening again reloads the page, and
      // with it the boxes and a read that took minutes.
      if (tracerVideo()?.id !== video.id) deps.openTracer(video, { hidden: deps.sessionLive() });
      return Promise.resolve();
    },
    async status() {
      if (tracerVideo() === null) return CLOSED;
      try {
        return await tracerCall<TracerStatus>("status");
      } catch (err) {
        // Between the window opening and its page running there is nothing to ask.
        return { ...CLOSED, video: tracerVideo(), message: err instanceof Error ? err.message : String(err) };
      }
    },
    async frame(timeS: number, crop: Box | null) {
      const f = await tracerCall<{ dataUrl: string; timeS: number }>("frame", timeS, crop);
      return { image: image(f.dataUrl), timeS: f.timeS };
    },
    setBoxes: (boxes, speedUnit) => tracerCall<TracerStatus>("setBoxes", boxes, speedUnit),
    read: (fromS, untilS) => tracerCall<void>("read", fromS, untilS),
    stopRead: () => tracerCall<void>("stopRead"),
    async shapes(kind) {
      const s = await tracerCall<{ dataUrl: string; counts: number[] }>("shapes", kind);
      return { image: image(s.dataUrl), counts: s.counts };
    },
    nameShapes: (kind, labels) => tracerCall<string>("nameShapes", kind, labels),
    setLap: (lap) => tracerCall<TracerStatus>("setLap", lap),
    build: (target) => tracerCall<{ summary: string; doubt: boolean }>("build", target),
    save: () => tracerCall<string>("save"),
  };
}

interface ImportResult {
  readonly ok: boolean;
  readonly placed: boolean;
  readonly message: string;
  readonly noteSetId?: string;
  readonly warnings?: readonly string[];
  readonly unresolved?: readonly string[];
}

function packsHost(deps: AuthoringDeps): PacksHost {
  const keyOf = (t: PackTarget) => ({ sim: "iracing" as const, trackId: t.trackId, configId: t.configId });

  return {
    async target() {
      const identity = deps.identity();
      if (identity?.trackKey == null) return null;
      const info = (await runImporter(deps, {
        op: "trackInfo",
        track: {
          trackId: identity.trackKey.trackId,
          trackName: identity.trackName,
          configName: identity.trackConfig,
          carName: identity.carName,
          carId: identity.carId,
        },
      })) as { carClass: string };
      return {
        trackId: identity.trackKey.trackId,
        configId: identity.trackKey.configId,
        trackName: identity.trackName,
        configName: identity.trackConfig,
        carName: identity.carName,
        carId: identity.carId,
        carClass: info.carClass,
        activeNoteSetId: deps.activeNoteSet(),
      };
    },

    async local(target) {
      const sets = await localRepositories(deps.resolveDataDir(deps.getSettings())).noteSets.listForTrack(keyOf(target));
      return [...sets]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((s) => ({ noteSetId: s.id, carClass: s.carClass, callouts: s.noteCount }));
    },

    async shared(target) {
      const rows = await sharedPacksFor(deps, keyOf(target), target.carClass);
      return rows
        // Your own pack that is not on this machine is fetched under Mine, not
        // installed like a stranger's; one that is here was found by `local`.
        .filter((r) => !r.isOwner && r.latestVersion !== null)
        .map((r) => ({
          itemId: r.id,
          title: r.title,
          author: r.authorName,
          stars: r.stars,
          downloads: r.downloads,
          updatedAt: r.updatedAt,
          installedAs: r.local?.noteSetId ?? null,
        }));
    },

    install: (itemId) => installSharedPack(itemId),

    activate(noteSetId) {
      deps.activate(noteSetId);
      return Promise.resolve();
    },
  };
}

export function createAuthoringHost(app: AuthoringDeps): AuthoringHost {
  // While a session runs, an import ends by selecting the new set and nothing
  // else. With none running it opens in the editor, as it does from the window.
  const deps: AuthoringDeps = {
    ...app,
    openImported: (noteSetId) => (app.sessionLive() ? app.activate(noteSetId) : app.openImported(noteSetId)),
  };
  const dataDir = (): string => deps.resolveDataDir(deps.getSettings());

  return {
    packs: packsHost(deps),

    async tracks() {
      const repos = localRepositories(dataDir());
      const tracks: AuthoringTrack[] = [];
      for (const t of await repos.trackMaps.listTracks()) {
        // A map that no longer reads (cut before a schema change) cannot place
        // anything; leaving it out is truer than listing it.
        const map = await repos.trackMaps.get({ ...t.key, mapVersion: t.mapVersion }).catch(() => null);
        if (map === null) continue;
        const referenceLaps = [];
        for (const carId of await repos.referenceLaps.listCars(t.key)) {
          const lap = await repos.referenceLaps.get(t.key, carId);
          if (lap !== null) referenceLaps.push({ carId, lapTimeS: lap.lapTimeS });
        }
        tracks.push({
          trackId: t.key.trackId,
          trackName: t.trackName,
          configName: t.configName,
          configId: t.key.configId,
          lengthM: map.lengthM,
          corners: t.cornerCount,
          referenceLaps,
          noteSets: (await repos.noteSets.listForTrack(t.key)).map((s) => s.id),
        });
      }
      tracks.sort((a, b) => `${a.trackName} ${a.configName}`.localeCompare(`${b.trackName} ${b.configName}`));

      const identity = deps.identity();
      return {
        session:
          identity?.trackKey == null
            ? null
            : {
                trackId: identity.trackKey.trackId,
                trackName: identity.trackName,
                configName: identity.trackConfig,
                carName: identity.carName,
                carId: identity.carId,
              },
        tracks,
      };
    },

    async raceWeek() {
      const week = (await runImporter(deps, { op: "raceWeek", refresh: false })) as {
        entries: readonly AuthoringRaceWeek[];
      };
      return week.entries;
    },

    async searchVideos(query) {
      return (await runImporter(deps, { op: "search", query })) as AuthoringVideo[];
    },

    async calloutBrief(target, video) {
      return (await runImporter(deps, {
        op: "prompt",
        track: trackRequest(target),
        video: videoRequest(video),
      })) as string;
    },

    async importCallouts(target, video, carClass, reply): Promise<ImportOutcome> {
      const track = trackRequest(target);
      const parsed = (await runImporter(deps, { op: "parse", track, reply })) as ParsedReply;
      if (parsed.callouts.length === 0) {
        return {
          ok: false,
          placed: false,
          message: "No callouts could be read from that reply — nothing was imported.",
          noteSetId: null,
          problems: parsed.problems,
        };
      }

      const info = (await runImporter(deps, { op: "trackInfo", track })) as { carClass: string };
      const callouts: readonly DraftCallout[] = parsed.callouts;
      const result = (await runImporter(deps, {
        op: "import",
        request: {
          track,
          video: videoRequest(video),
          carClass: carClass ?? info.carClass,
          callouts,
          layoutWarning: parsed.layoutWarning,
        },
      })) as ImportResult;

      return {
        ok: result.ok,
        placed: result.placed,
        message: result.message,
        noteSetId: result.noteSetId ?? null,
        problems: [
          ...(parsed.layoutWarning === null ? [] : [`This guide may be for another layout: ${parsed.layoutWarning}`]),
          ...parsed.problems,
          ...(result.warnings ?? []),
          ...(result.unresolved ?? []),
        ],
      };
    },

    tracer: tracerHost(deps),
  };
}
