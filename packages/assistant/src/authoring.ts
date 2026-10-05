/**
 * Authoring: an assistant doing what a person does in the importer and the
 * tracer.
 *
 * The importer turns a track guide into callouts: find a video, read its
 * transcript, have a model write `{ corner, text }` drafts, place them on the
 * map. The tracer reads the throttle, brake, speed and gear off the same
 * video's overlay and makes a reference lap of them. Both were built for a
 * person at a window, and both have a step only a mind can do — writing the
 * callouts, seeing where the pedal bars are, telling an 8 from a 9.
 *
 * These tools hand those steps to the assistant that is connected, and keep
 * every other step where it already is: `AuthoringHost` is the app's own
 * importer and tracer, not a second copy of them. What comes out is what a
 * person would have got — a draft note set open in the editor, a lap to look
 * at before saving — and is a starting point in the same way.
 *
 * Separate from the questions in tools.ts and switched on separately, because
 * these write: a note set, and with `tracer_save` a reference lap.
 */

import { z } from "zod";

import type { Tool, ToolImage, ToolReply } from "./tools.js";

// ---------------------------------------------------------------------------
// What the app has to offer — implemented in apps/desktop
// ---------------------------------------------------------------------------

export interface AuthoringTrack {
  readonly trackId: number;
  readonly trackName: string;
  readonly configName: string;
  /** Layout id, as the app files it. With `trackId` it names the track for `tracer_build`. */
  readonly configId: string;
  readonly lengthM: number;
  readonly corners: number;
  /** Cars with a reference lap here: what the tracer can build on. */
  readonly referenceLaps: readonly { readonly carId: string; readonly lapTimeS: number }[];
  readonly noteSets: readonly string[];
}

export interface AuthoringSession {
  readonly trackId: number;
  readonly trackName: string;
  readonly configName: string;
  readonly carName: string;
  readonly carId: string;
}

export interface AuthoringRaceWeek {
  readonly seriesName: string;
  readonly category: string;
  readonly trackName: string;
  readonly configName: string;
  readonly cars: readonly string[];
}

export interface AuthoringVideo {
  readonly id: string;
  readonly title: string;
  readonly channel: string;
  readonly durationS: number | null;
  readonly views: number | null;
}

/** A track and car as the importer takes them. Names are what a guide is searched and briefed by. */
export interface AuthoringTarget {
  /** The sim's track id when known; null finds a mapped track by name. */
  readonly trackId: number | null;
  readonly trackName: string;
  readonly configName: string;
  readonly carName: string;
  readonly carId: string | null;
}

export interface AuthoringVideoRef {
  readonly id: string;
  readonly title: string;
  readonly channel: string;
}

export interface ImportOutcome {
  readonly ok: boolean;
  /** False when there is no map to place the callouts on; they are saved for later. */
  readonly placed: boolean;
  readonly message: string;
  readonly noteSetId: string | null;
  /** What the reply had wrong with it, what did not land on a corner, what to check. */
  readonly problems: readonly string[];
}

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export type BoxName = "pedals" | "line" | "speed" | "gear";

export interface TracerStatus {
  readonly video: { readonly id: string; readonly title: string } | null;
  /** The video is downloaded and loaded. Until then only `message` means anything. */
  readonly ready: boolean;
  /** The window's own status line: downloading, failed, what to do next. */
  readonly message: string;
  readonly durationS: number | null;
  /** The video's own pixels — what every box is measured in. */
  readonly width: number | null;
  readonly height: number | null;
  readonly boxes: Readonly<Record<BoxName, Box | null>>;
  readonly reading: boolean;
  /** How far through the video the read is, seconds. */
  readonly readAtS: number | null;
  readonly readMessage: string;
  /** The stretch that has been read, or null before a read. */
  readonly read: { readonly fromS: number; readonly toS: number; readonly frames: number } | null;
  readonly barsFound: { readonly throttle: boolean; readonly brake: boolean };
  /** Moments the line box changed: candidate start/finish crossings, seconds. */
  readonly crossings: readonly number[];
  readonly lap: { readonly startS: number | null; readonly endS: number | null };
  readonly speed: { readonly shapes: number; readonly message: string };
  readonly gear: { readonly shapes: number; readonly message: string };
  readonly built: { readonly summary: string; readonly doubt: boolean } | null;
  readonly buildMessage: string;
}

export interface TracerHost {
  /** Open the tracer on a video and start downloading it. Returns at once. */
  open(video: { readonly id: string; readonly title: string }): Promise<void>;
  status(): Promise<TracerStatus>;
  /** One frame as a picture, the boxes drawn on it. `crop` is in video pixels and is enlarged. */
  frame(timeS: number, crop: Box | null): Promise<{ readonly image: ToolImage; readonly timeS: number }>;
  setBoxes(boxes: Partial<Record<BoxName, Box | null>>, speedUnit: "kph" | "mph" | null): Promise<TracerStatus>;
  /** Start reading. Returns at once; `status().reading` says when it is done. */
  read(fromS: number, untilS: number | null): Promise<void>;
  stopRead(): Promise<void>;
  /** The shapes found in a number box, as one picture of numbered tiles. */
  shapes(kind: "speed" | "gear"): Promise<{ readonly image: ToolImage; readonly counts: readonly number[] }>;
  /** Name each shape — a digit, "N", or "" for not a digit — and read the number per frame. */
  nameShapes(kind: "speed" | "gear", labels: readonly string[]): Promise<string>;
  setLap(lap: { readonly startS?: number; readonly endS?: number; readonly lapTime?: string }): Promise<TracerStatus>;
  build(target: { readonly trackId: number; readonly configId: string; readonly carId: string }): Promise<{
    readonly summary: string;
    readonly doubt: boolean;
  }>;
  save(): Promise<string>;
}

/** What the driver is in right now, as far as callouts are concerned. */
export interface PackTarget {
  readonly trackId: number;
  readonly configId: string;
  readonly trackName: string;
  readonly configName: string;
  readonly carName: string;
  readonly carId: string;
  readonly carClass: string;
  /** The note set the running session loaded, or null when it is driving without callouts. */
  readonly activeNoteSetId: string | null;
}

export interface LocalPack {
  readonly noteSetId: string;
  readonly carClass: string;
  readonly callouts: number;
}

/** A pack someone published, for this layout and class. */
export interface SharedPack {
  readonly itemId: string;
  readonly title: string;
  readonly author: string;
  readonly stars: number;
  readonly downloads: number;
  /** ISO date of its newest version. */
  readonly updatedAt: string;
  /** Already on this machine under this note set id, or null. */
  readonly installedAs: string | null;
}

export interface PacksHost {
  /** Null when the sim is not running: there is no track to find a pack for. */
  target(): Promise<PackTarget | null>;
  /** Newest first. */
  local(target: PackTarget): Promise<readonly LocalPack[]>;
  /** Most starred first. */
  shared(target: PackTarget): Promise<readonly SharedPack[]>;
  /** Download, place and render someone's pack. Says which note set it became. */
  install(itemId: string): Promise<{ readonly noteSetId: string; readonly message: string }>;
  /** Make the running session use this note set. Opens nothing. */
  activate(noteSetId: string): Promise<void>;
}

export interface AuthoringHost {
  readonly packs: PacksHost;
  tracks(): Promise<{ readonly session: AuthoringSession | null; readonly tracks: readonly AuthoringTrack[] }>;
  raceWeek(): Promise<readonly AuthoringRaceWeek[]>;
  searchVideos(query: string): Promise<readonly AuthoringVideo[]>;
  /** The whole brief a model needs to write callouts: the rules, this layout's corners, the transcript. */
  calloutBrief(target: AuthoringTarget, video: AuthoringVideoRef): Promise<string>;
  importCallouts(
    target: AuthoringTarget,
    video: AuthoringVideoRef,
    carClass: string | null,
    reply: string,
  ): Promise<ImportOutcome>;
  readonly tracer: TracerHost;
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

export type AuthoringTool<Shape extends z.ZodRawShape = z.ZodRawShape> = Tool<AuthoringHost, Shape>;

const tool = <Shape extends z.ZodRawShape>(t: AuthoringTool<Shape>): AuthoringTool<Shape> => t;

/**
 * Said once to a client that connects, ahead of any tool. The order matters
 * more than any one tool's description can say.
 */
export const AUTHORING_INSTRUCTIONS = `
Exxeed can also build callouts for a track from a YouTube track guide, and a reference lap from the same video's telemetry overlay. Both produce drafts for the driver to refine; say what you made and what you were unsure of.

While the driver is on track and asks for callouts: call get_callout_pack and nothing else first. It uses a pack already on this machine or installs a shared one and switches the running session to it, without opening any window. Only if it says there is none, build one from a guide (steps 2–4 below; the session's track and car are in its reply). While a session is running, import_callouts activates the result silently too. Do not use the tracer while the driver is on track unless they ask for it: it decodes video and costs frame rate.

Callouts from a guide:
1. list_tracks — which tracks are mapped, and what the sim is on now. get_race_week if the driver means "this week's track".
2. search_guide_videos — pick a recent guide for this exact layout and, if possible, this car or class. Prefer a full narrated lap over a race or a hotlap with no talking.
3. get_callout_brief — returns the rules, the layout's corners and the transcript. Write the JSON it asks for yourself.
4. import_callouts — pass that JSON as \`reply\`. It places the callouts, renders their audio and opens them in the editor.

Reference lap from the video (optional, after or instead; needs a mapped track that already has a reference lap for the car):
1. tracer_open, then tracer_status until ready (the download can take a few minutes).
2. tracer_frame at a few times to find a stretch where the on-screen overlay shows throttle and brake bars, a speed and a gear. Use \`crop\` to zoom in and read pixel positions off the ruler. Then tracer_set_boxes.
3. tracer_read over a stretch that holds one whole flying lap, and tracer_status until it stops reading. Both bars must be found.
4. tracer_shapes for speed (and gear), look at the tiles, and tracer_name_shapes with what each tile is.
5. tracer_set_lap — from the crossings in tracer_status, or a lap time shown in the video.
6. tracer_build. If it reports doubt, the stretch is not one lap of this layout: choose another stretch or stop. Only then tracer_save, which replaces the car's reference lap (the old one is kept).
`.trim();

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

const lapTime = (s: number): string => {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(3).padStart(6, "0")}`;
};

const clock = (s: number | null): string => {
  if (s === null) return "?";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s - m * 60)).padStart(2, "0")}`;
};

const target = {
  track_name: z.string().min(1).describe("The track's name, as list_tracks or get_race_week gives it."),
  config_name: z.string().default("").describe("The layout's name; empty when the track has only one."),
  track_id: z.number().int().positive().optional().describe("The track's id from list_tracks, when it is mapped."),
  car_name: z.string().min(1).describe("The car the callouts are for, by name."),
  car_id: z.string().optional().describe("The car's id from list_tracks or the session, if known."),
};

const video = {
  video_id: z.string().regex(/^[A-Za-z0-9_-]{11}$/, "an 11-character YouTube video id").describe("From search_guide_videos."),
  video_title: z.string().default(""),
  video_channel: z.string().default(""),
};

interface TargetArgs {
  track_name: string;
  config_name: string;
  track_id?: number | undefined;
  car_name: string;
  car_id?: string | undefined;
}

const targetOf = (a: TargetArgs): AuthoringTarget => ({
  trackId: a.track_id ?? null,
  trackName: a.track_name,
  configName: a.config_name,
  carName: a.car_name,
  carId: a.car_id ?? null,
});

const videoOf = (a: { video_id: string; video_title: string; video_channel: string }): AuthoringVideoRef => ({
  id: a.video_id,
  title: a.video_title,
  channel: a.video_channel,
});

const listTracks = tool({
  name: "list_tracks",
  title: "Tracks",
  description:
    "The tracks Exxeed has a map for — the only ones callouts can be placed on — with their corners, the cars that have a reference lap, and the note sets already made. Also the track and car the sim is on right now, if it is running. Start here.",
  input: {},
  async run(host) {
    const { session, tracks } = await host.tracks();
    const here =
      session === null
        ? "The sim is not running."
        : `The sim is at ${session.trackName}${session.configName === "" ? "" : ` (${session.configName})`} in the ${session.carName}.`;
    return {
      summary: `${here} ${tracks.length} mapped track${tracks.length === 1 ? "" : "s"}.`,
      data: {
        session,
        tracks: tracks.map((t) => ({
          trackId: t.trackId,
          trackName: t.trackName,
          configName: t.configName,
          configId: t.configId,
          lengthKm: Math.round(t.lengthM / 10) / 100,
          corners: t.corners,
          referenceLaps: t.referenceLaps.map((l) => ({ carId: l.carId, lapTime: lapTime(l.lapTimeS) })),
          noteSets: t.noteSets,
        })),
      },
    };
  },
});

const getRaceWeek = tool({
  name: "get_race_week",
  title: "Race week",
  description:
    "What each iRacing series is racing this week: track, layout and cars, from iRacing's public schedule. Use it for \"this week's track\". Pass `series` to narrow it — the full list is long.",
  input: {
    series: z.string().optional().describe("Part of a series, track or car name to filter by."),
  },
  async run(host, args) {
    const all = await host.raceWeek();
    const want = args.series?.toLowerCase() ?? "";
    const entries = all.filter(
      (e) =>
        want === "" ||
        [e.seriesName, e.trackName, e.configName, e.category, ...e.cars].some((v) => v.toLowerCase().includes(want)),
    );
    const shown = entries.slice(0, 40);
    return {
      summary:
        entries.length === 0
          ? `Nothing this week matches "${args.series ?? ""}".`
          : `${entries.length} series this week${entries.length > shown.length ? `, the first ${shown.length} shown — pass \`series\` to narrow it` : ""}.`,
      data: { entries: shown },
    };
  },
});

const searchGuideVideos = tool({
  name: "search_guide_videos",
  title: "Search guides",
  description:
    "Search YouTube for a track guide. Put the track, the layout if it has several, the car or class, and \"track guide\" or \"iRacing\" in the query. Returns titles, channels, lengths and view counts to choose from: a narrated full lap of this exact layout is what the callouts are written from.",
  input: {
    query: z.string().min(3).describe('For example "iRacing Spa GT3 track guide".'),
  },
  async run(host, args) {
    const videos = await host.searchVideos(args.query);
    return {
      summary: videos.length === 0 ? "No videos found." : `${videos.length} videos.`,
      data: {
        videos: videos.map((v) => ({
          videoId: v.id,
          title: v.title,
          channel: v.channel,
          length: clock(v.durationS),
          views: v.views,
        })),
      },
    };
  },
});

const getCalloutBrief = tool({
  name: "get_callout_brief",
  title: "Callout brief",
  description:
    "Everything needed to write callouts from one guide video: the rules for a good callout, this layout's corners in driving order, and the video's transcript. Read it, write the JSON object it asks for yourself, and pass that to import_callouts. If the transcript turns out to be about another track or layout, pick another video instead.",
  input: { ...target, ...video },
  async run(host, args) {
    const brief = await host.calloutBrief(targetOf(args), videoOf(args));
    return {
      summary:
        "The brief follows. Write the JSON it asks for, then call import_callouts with the same track, car and video and that JSON as `reply`.\n\n" +
        brief,
      data: {},
    };
  },
});

const importCallouts = tool({
  name: "import_callouts",
  title: "Import callouts",
  description:
    "Place the callouts you wrote from get_callout_brief on the track map, render their audio and make them the active note set, as a draft. With no session running they also open in Exxeed's editor; while the driver is on track nothing opens and the session just reloads with them. `reply` is the JSON object the brief asked for. On a track with no map yet the callouts are saved to place later. This can take a minute or more the first time, while a voice is installed.",
  input: {
    ...target,
    ...video,
    car_class: z.string().optional().describe('The car\'s class, such as "gt3". Worked out from the car when left out.'),
    reply: z.string().min(2).describe("The JSON object the brief asked for, as text."),
  },
  async run(host, args) {
    const outcome = await host.importCallouts(targetOf(args), videoOf(args), args.car_class ?? null, args.reply);
    return {
      summary: [outcome.message, ...outcome.problems.map((p) => `- ${p}`)].join("\n"),
      data: { ok: outcome.ok, placed: outcome.placed, noteSetId: outcome.noteSetId, problems: outcome.problems },
    };
  },
});

const DAY_MS = 24 * 60 * 60 * 1000;

const getCalloutPack = tool({
  name: "get_callout_pack",
  title: "Get a callout pack",
  description:
    "The driver is in a session and wants callouts for this track and car — \"get me a callout pack\", \"I have no callouts here\". Uses one already on this machine, or else installs the best shared pack for this layout and car class, and switches the running session to it. Nothing opens on screen; callouts pause for a moment while the session reloads. If no pack exists it says so and gives the track and car to build one from a guide with. `max_age_days` is how old a shared pack may be before it is passed over (default a year: cars and tracks change).",
  input: {
    max_age_days: z.number().int().positive().default(365),
  },
  async run(host, args) {
    const target = await host.packs.target();
    if (target === null) {
      return {
        summary: "The sim is not running, so there is no track to find a pack for. Use list_tracks to work on a track by name.",
        data: { status: "no-session" },
      };
    }
    const where = `${target.trackName}${target.configName === "" ? "" : ` (${target.configName})`} in the ${target.carName}`;
    const session = {
      track_name: target.trackName,
      config_name: target.configName,
      track_id: target.trackId,
      car_name: target.carName,
      car_id: target.carId,
      car_class: target.carClass,
    };

    if (target.activeNoteSetId !== null) {
      return {
        summary: `Callouts are already running for ${where}: "${target.activeNoteSetId}".`,
        data: { status: "already-active", noteSetId: target.activeNoteSetId, session },
      };
    }

    // On this machine already, for this class: no network, nothing to wait for.
    const onDisk = await host.packs.local(target);
    const mine = onDisk.find((p) => p.carClass === target.carClass && p.callouts > 0);
    if (mine !== undefined) {
      await host.packs.activate(mine.noteSetId);
      return {
        summary: `Using "${mine.noteSetId}", already on this machine: ${plural(mine.callouts, "callout")} for ${where}. Active as soon as the session reloads.`,
        data: { status: "activated-local", noteSetId: mine.noteSetId, session },
      };
    }

    // Offline, or not signed in to anything: that is "none shared that can be
    // had right now", not a reason to leave the driver without an answer.
    let shared: readonly SharedPack[] = [];
    let unreachable: string | null = null;
    try {
      shared = await host.packs.shared(target);
    } catch (error) {
      unreachable = error instanceof Error ? error.message : String(error);
    }
    const fresh = shared.filter((p) => Date.now() - Date.parse(p.updatedAt) <= args.max_age_days * DAY_MS);
    const pick = fresh[0];
    if (pick !== undefined) {
      // "Installed" is the app's record of it; the note set has to be there
      // too. One that was installed and since deleted is installed again.
      const here = pick.installedAs !== null && onDisk.some((p) => p.noteSetId === pick.installedAs);
      const noteSetId = here && pick.installedAs !== null ? pick.installedAs : (await host.packs.install(pick.itemId)).noteSetId;
      await host.packs.activate(noteSetId);
      return {
        summary: `Installed "${pick.title}" by ${pick.author} (${plural(pick.stars, "star")}, updated ${pick.updatedAt.slice(0, 10)}) for ${where}. Active as soon as the session reloads.`,
        data: { status: "installed-shared", noteSetId, itemId: pick.itemId, session },
      };
    }

    const older = shared.map((p) => ({ title: p.title, author: p.author, updated: p.updatedAt.slice(0, 10) }));
    return {
      summary:
        `No callout pack for ${where}` +
        (unreachable !== null
          ? `: none on this machine, and shared packs could not be checked (${unreachable}).`
          : older.length === 0
          ? ": none on this machine and none shared."
          : `: none on this machine, and the ${older.length} shared ${older.length === 1 ? "is" : "are"} older than ${args.max_age_days} days (call again with a larger max_age_days to use one).`) +
        " To build one now: search_guide_videos for this layout and car, get_callout_brief, write the callouts, import_callouts. It goes live without opening a window.",
      data: { status: "none", older, sharedUnreachable: unreachable, session },
    };
  },
});

// --- The tracer -------------------------------------------------------------

const box = z
  .object({
    x: z.number().min(0),
    y: z.number().min(0),
    w: z.number().min(3),
    h: z.number().min(3),
  })
  .describe("A rectangle in the video's own pixels: x and y of its top-left corner, width and height.");

function describeStatus(s: TracerStatus): string {
  if (s.video === null) return "The tracer is not open. Call tracer_open with a video first.";
  if (!s.ready) return `Not ready: ${s.message}`;
  const parts = [`"${s.video.title}", ${clock(s.durationS)} long, ${s.width ?? "?"}×${s.height ?? "?"} pixels.`];
  const drawn = (Object.keys(s.boxes) as BoxName[]).filter((k) => s.boxes[k] !== null);
  parts.push(drawn.length === 0 ? "No boxes placed." : `Boxes placed: ${drawn.join(", ")}.`);
  if (s.reading) parts.push(`Reading, at ${clock(s.readAtS)}.`);
  else if (s.read !== null) {
    parts.push(s.readMessage);
    if (s.crossings.length > 0) parts.push(`Line crossings at ${s.crossings.map((t) => t.toFixed(1)).join(", ")} s.`);
    if (s.speed.shapes > 0) parts.push(`Speed: ${s.speed.message}`);
    if (s.gear.shapes > 0) parts.push(`Gear: ${s.gear.message}`);
  }
  if (s.lap.startS !== null && s.lap.endS !== null) {
    parts.push(`Lap set from ${s.lap.startS.toFixed(3)} to ${s.lap.endS.toFixed(3)} s (${lapTime(s.lap.endS - s.lap.startS)}).`);
  }
  if (s.built !== null) parts.push(`Built: ${s.built.summary}`);
  else if (s.buildMessage !== "") parts.push(s.buildMessage);
  return parts.join(" ");
}

const statusReply = (s: TracerStatus): ToolReply => ({ summary: describeStatus(s), data: { ...s } });

const tracerOpen = tool({
  name: "tracer_open",
  title: "Open the tracer",
  description:
    "Open Exxeed's tracer on a guide video and start downloading it (once; it is cached). While a session is running its window stays hidden. The tracer reads throttle, brake, speed and gear off the video's on-screen overlay to make a reference lap. Returns at once — poll tracer_status until it is ready.",
  input: { ...video },
  async run(host, args) {
    await host.tracer.open({ id: args.video_id, title: args.video_title === "" ? args.video_id : args.video_title });
    return { summary: "Opening the tracer and downloading the video. Call tracer_status until it is ready.", data: {} };
  },
});

const tracerStatus = tool({
  name: "tracer_status",
  title: "Tracer status",
  description:
    "Where the tracer is: whether the video is loaded, its length and pixel size, the boxes placed, whether a read is running and what it found, the line crossings, the lap chosen, and the last build. Call it after every step that takes time.",
  input: {},
  async run(host) {
    return statusReply(await host.tracer.status());
  },
});

const tracerFrame = tool({
  name: "tracer_frame",
  title: "Look at a frame",
  description:
    "One frame of the video as a picture, with a pixel ruler along the top and left edges and any placed boxes drawn on it. Use it to find where the telemetry overlay is, then again with `crop` round the overlay to zoom in and read exact positions for tracer_set_boxes, and afterwards to check the boxes sit where you meant. Coordinates are always the video's own pixels, whatever size the picture is.",
  input: {
    time_s: z.number().min(0).describe("Seconds into the video."),
    crop: box.optional().describe("Show only this part of the frame, enlarged."),
  },
  async run(host, args) {
    const f = await host.tracer.frame(args.time_s, args.crop ?? null);
    return {
      summary: `Frame at ${f.timeS.toFixed(2)} s${args.crop === undefined ? "" : `, cropped to x ${args.crop.x}–${args.crop.x + args.crop.w}, y ${args.crop.y}–${args.crop.y + args.crop.h}`}. The ruler is in video pixels.`,
      data: { timeS: f.timeS },
      images: [f.image],
    };
  },
});

const tracerSetBoxes = tool({
  name: "tracer_set_boxes",
  title: "Place the boxes",
  description:
    "Say where things are in the overlay, in video pixels. `pedals`: ONE loose box round the throttle and brake bars together, with room to spare above and below — the bars are found inside it by colour (green throttle, red brake). `speed`: tightly round just the speed's digits, not its unit. `gear`: just the gear character, inside any ring drawn round it. `line`: something that changes only when the car crosses the start/finish line, such as the lap number or last-lap time. Only `pedals` is required; `speed` is what makes the lap accurate. Pass null to remove a box. Look again with tracer_frame afterwards.",
  input: {
    pedals: box.nullable().optional(),
    speed: box.nullable().optional(),
    gear: box.nullable().optional(),
    line: box.nullable().optional(),
    speed_unit: z.enum(["kph", "mph"]).optional().describe("What the overlay's speed is in."),
  },
  async run(host, args) {
    const boxes: Partial<Record<BoxName, Box | null>> = {};
    for (const name of ["pedals", "speed", "gear", "line"] as const) {
      const b = args[name];
      if (b !== undefined) boxes[name] = b;
    }
    return statusReply(await host.tracer.setBoxes(boxes, args.speed_unit ?? null));
  },
});

const tracerRead = tool({
  name: "tracer_read",
  title: "Read the video",
  description:
    "Play the video from `from_s` to `until_s` and measure every frame inside the boxes. It runs at twice real time, so a three-minute stretch takes ninety seconds: returns at once, and tracer_status says when it has finished and what it found. Read a stretch that holds one whole flying lap with a few seconds either side, not the whole video.",
  input: {
    from_s: z.number().min(0),
    until_s: z.number().positive().optional().describe("Stop here. Left out, it reads to the end of the video."),
  },
  async run(host, args) {
    if (args.until_s !== undefined && args.until_s <= args.from_s) {
      return { summary: "until_s must be after from_s.", data: {} };
    }
    await host.tracer.read(args.from_s, args.until_s ?? null);
    const span = args.until_s === undefined ? null : args.until_s - args.from_s;
    return {
      summary: `Reading${span === null ? "" : `: about ${Math.ceil(span / 2)} seconds`}. Call tracer_status until it is no longer reading.`,
      data: {},
    };
  },
});

const tracerStop = tool({
  name: "tracer_stop_read",
  title: "Stop reading",
  description: "Stop a read that is running. What was read so far is kept.",
  input: {},
  async run(host) {
    await host.tracer.stopRead();
    return statusReply(await host.tracer.status());
  },
});

const kind = z.enum(["speed", "gear"]);

const tracerShapes = tool({
  name: "tracer_shapes",
  title: "Digit shapes",
  description:
    "After a read: the distinct shapes found in the speed (or gear) box, as one picture of numbered tiles, most common first. Look at each tile and work out which digit it is, then call tracer_name_shapes. Tiles are small and blurry; a shape that is not a digit (a smudge, half of two digits) should be left unnamed.",
  input: { kind },
  async run(host, args) {
    const s = await host.tracer.shapes(args.kind);
    return {
      summary: `${s.counts.length} shapes in the ${args.kind} box, numbered from 0. How often each was seen: ${s.counts.join(", ")}.`,
      data: { counts: s.counts },
      images: [s.image],
    };
  },
});

const tracerNameShapes = tool({
  name: "tracer_name_shapes",
  title: "Name the shapes",
  description:
    "Say what each tile from tracer_shapes is, in tile order: one digit \"0\"–\"9\", \"N\" for neutral (gear only), or \"\" for a shape that is not a digit. The number is then read off every frame. A speed read on well under 80% of the lap's frames means some tiles are named wrong or the box is misplaced.",
  input: {
    kind,
    labels: z.array(z.string().max(1)).min(1).describe("One per tile, in order."),
  },
  async run(host, args) {
    const message = await host.tracer.nameShapes(args.kind, args.labels);
    return { summary: message, data: {} };
  },
});

const tracerSetLap = tool({
  name: "tracer_set_lap",
  title: "Choose the lap",
  description:
    "Which stretch of the video is the lap: `start_s` and `end_s` are the moments the car crosses the start/finish line, usually two consecutive crossings from tracer_status. If the video shows the lap's time on screen, pass it as `lap_time` (\"1:21.310\") with one of the two: that places the other end exactly.",
  input: {
    start_s: z.number().min(0).optional(),
    end_s: z.number().min(0).optional(),
    lap_time: z.string().regex(/^\s*(?:\d+:)?\d+(?:\.\d+)?\s*$/).optional().describe('As shown in the video: "1:21.310" or "81.31".'),
  },
  async run(host, args) {
    return statusReply(
      await host.tracer.setLap({
        ...(args.start_s === undefined ? {} : { startS: args.start_s }),
        ...(args.end_s === undefined ? {} : { endS: args.end_s }),
        ...(args.lap_time === undefined ? {} : { lapTime: args.lap_time }),
      }),
    );
  },
});

const tracerBuild = tool({
  name: "tracer_build",
  title: "Build the lap",
  description:
    "Turn what was read into a reference lap for a track and car from list_tracks (it needs that car's existing reference lap to build on). Nothing is saved. The reply says whether the video's own speed adds up to one lap of this track; `doubt: true` means it does not — a cut, a slow-motion section, another layout — and the lap must not be saved.",
  input: {
    track_id: z.number().int().positive(),
    config_id: z.string().describe("The layout's `configId` from list_tracks."),
    car_id: z.string().describe("A car with a reference lap on that track."),
  },
  async run(host, args) {
    const built = await host.tracer.build({ trackId: args.track_id, configId: args.config_id, carId: args.car_id });
    return {
      summary: built.summary + (built.doubt ? "" : " Looks sound. tracer_save makes it the reference lap."),
      data: { doubt: built.doubt },
    };
  },
});

const tracerSave = tool({
  name: "tracer_save",
  title: "Save the lap",
  description:
    "Make the lap from tracer_build the reference lap for its car and track, replacing the current one — which is kept in a backup folder and named in the reply. Refused when the build was in doubt. Only call this when the driver asked for the reference lap to be replaced, and tell them it was.",
  input: {},
  async run(host) {
    return { summary: await host.tracer.save(), data: {} };
  },
});

/** Every authoring tool. These write; none is marked read-only. */
export const AUTHORING_TOOLS: readonly AuthoringTool[] = [
  getCalloutPack,
  listTracks,
  getRaceWeek,
  searchGuideVideos,
  getCalloutBrief,
  importCallouts,
  tracerOpen,
  tracerStatus,
  tracerFrame,
  tracerSetBoxes,
  tracerRead,
  tracerStop,
  tracerShapes,
  tracerNameShapes,
  tracerSetLap,
  tracerBuild,
  tracerSave,
] as unknown as readonly AuthoringTool[];

/** The ones that only look. Everything else changes something in the app or on disk. */
export const AUTHORING_READ_ONLY: ReadonlySet<string> = new Set([
  "list_tracks",
  "get_race_week",
  "search_guide_videos",
  "get_callout_brief",
  "tracer_status",
  "tracer_frame",
  "tracer_shapes",
]);
