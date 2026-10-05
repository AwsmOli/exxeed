import { afterEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import {
  AssistantState,
  AUTHORING_READ_ONLY,
  AUTHORING_TOOLS,
  startAssistantServer,
  TOOLS,
  type AssistantServer,
  type AuthoringHost,
  type PackTarget,
  type PacksHost,
  type SharedPack,
  type ToolReply,
  type TracerStatus,
} from "@exxeed/assistant";

const STATUS: TracerStatus = {
  video: { id: "abcdefghijk", title: "Spa guide" },
  ready: true,
  message: "",
  durationS: 600,
  width: 1920,
  height: 1080,
  boxes: { pedals: { x: 100, y: 800, w: 80, h: 200 }, line: null, speed: { x: 900, y: 950, w: 90, h: 40 }, gear: null },
  reading: false,
  readAtS: null,
  readMessage: "Read 5400 frames, 1:00.000 to 4:00.000. Found both bars — dashed on the video.",
  read: { fromS: 60, toS: 240, frames: 5400 },
  barsFound: { throttle: true, brake: true },
  crossings: [71.2, 211.5],
  lap: { startS: 71.2, endS: 211.5 },
  speed: { shapes: 11, message: "Speed read on 97% of frames." },
  gear: { shapes: 0, message: "" },
  built: null,
  buildMessage: "",
};

const TARGET: PackTarget = {
  trackId: 163,
  configId: "grand-prix",
  trackName: "Spa",
  configName: "Grand Prix",
  carName: "Porsche 992 GT3 R",
  carId: "porsche992rgt3",
  carClass: "gt3",
  activeNoteSetId: null,
};

const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

const sharedPack = (over: Partial<SharedPack> = {}): SharedPack => ({
  itemId: "item-1",
  title: "Spa GT3 by Coach",
  author: "Coach",
  stars: 12,
  downloads: 300,
  updatedAt: daysAgo(30),
  installedAs: null,
  ...over,
});

/** A host that records what it was asked, and answers with fixed things. */
function fakeHost(over: Partial<AuthoringHost> = {}): { host: AuthoringHost; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const saw = <T>(name: string, value: T) =>
    (...args: unknown[]): Promise<T> => {
      calls.push([name, ...args]);
      return Promise.resolve(value);
    };
  const host: AuthoringHost = {
    packs: {
      target: saw("target", TARGET),
      local: saw("local", []),
      shared: saw("shared", []),
      install: saw("install", { noteSetId: "installed-set", message: "installed" }),
      activate: saw("activate", undefined),
    },
    tracks: saw("tracks", {
      session: { trackId: 163, trackName: "Spa", configName: "Grand Prix", carName: "Porsche 992 GT3 R", carId: "porsche992rgt3" },
      tracks: [
        {
          trackId: 163,
          trackName: "Spa",
          configName: "Grand Prix",
          configId: "grand-prix",
          lengthM: 6972.4,
          corners: 19,
          referenceLaps: [{ carId: "porsche992rgt3", lapTimeS: 137.3 }],
          noteSets: ["spa-gt3"],
        },
      ],
    }),
    raceWeek: saw("raceWeek", [
      { seriesName: "IMSA", category: "Sports Car", trackName: "Spa", configName: "Grand Prix", cars: ["Porsche 992 GT3 R"] },
      { seriesName: "MX-5 Cup", category: "Sports Car", trackName: "Lime Rock", configName: "", cars: ["Mazda MX-5"] },
    ]),
    searchVideos: saw("searchVideos", [
      { id: "abcdefghijk", title: "Spa GT3 guide", channel: "Coach", durationS: 754, views: 12000 },
    ]),
    calloutBrief: saw("calloutBrief", "## Rules\n…\n## Transcript\n[0:10] Turn one, brake at the 100."),
    importCallouts: saw("importCallouts", {
      ok: true,
      placed: true,
      message: 'Imported and rendered 14 callouts as "spa-gt3-abc" — ready to drive.',
      noteSetId: "spa-gt3-abc",
      problems: ["turn 12: no such corner"],
    }),
    tracer: {
      open: saw("open", undefined),
      status: saw("status", STATUS),
      frame: saw("frame", { image: { mimeType: "image/jpeg" as const, base64: "AAAA" }, timeS: 90 }),
      setBoxes: saw("setBoxes", STATUS),
      read: saw("read", undefined),
      stopRead: saw("stopRead", undefined),
      shapes: saw("shapes", { image: { mimeType: "image/png" as const, base64: "BBBB" }, counts: [900, 850, 12] }),
      nameShapes: saw("nameShapes", "Speed read on 97% of frames."),
      setLap: saw("setLap", STATUS),
      build: saw("build", { summary: "2:17.300 from the video, placed by its own speed.", doubt: false }),
      save: saw("save", "Saved: the 2:17.300 lap from the video is now the reference."),
    },
    ...over,
  };
  return { host, calls };
}

function run(host: AuthoringHost, name: string, args: Record<string, unknown> = {}): Promise<ToolReply> {
  const tool = AUTHORING_TOOLS.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return Promise.resolve(tool.run(host, args));
}

const SPA = { track_name: "Spa", config_name: "Grand Prix", track_id: 163, car_name: "Porsche 992 GT3 R" };
const VIDEO = { video_id: "abcdefghijk", video_title: "Spa GT3 guide", video_channel: "Coach" };

describe("the tool lists", () => {
  it("share no name with the race questions, or with each other", () => {
    const names = [...TOOLS, ...AUTHORING_TOOLS].map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("call read-only only what is", () => {
    for (const name of AUTHORING_READ_ONLY) expect(AUTHORING_TOOLS.some((t) => t.name === name), name).toBe(true);
    for (const writes of ["import_callouts", "tracer_save", "tracer_set_boxes", "tracer_build", "tracer_open"]) {
      expect(AUTHORING_READ_ONLY.has(writes), writes).toBe(false);
    }
  });
});

describe("get_callout_pack", () => {
  const withPacks = (over: Partial<PacksHost>): { host: AuthoringHost; calls: unknown[][] } => {
    const made = fakeHost();
    const packs: PacksHost = { ...made.host.packs };
    for (const [name, fn] of Object.entries(over)) {
      (packs as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
        made.calls.push([name, ...args]);
        return (fn as (...a: unknown[]) => unknown)(...args);
      };
    }
    return { host: { ...made.host, packs }, calls: made.calls };
  };
  const names = (calls: unknown[][]): unknown[] => calls.map((c) => c[0]);

  it("has nothing to go on with the sim not running", async () => {
    const { host, calls } = withPacks({ target: () => Promise.resolve(null) });
    const reply = await run(host, "get_callout_pack", { max_age_days: 365 });
    expect(reply.data["status"]).toBe("no-session");
    expect(names(calls)).toEqual(["target"]);
  });

  it("leaves a session that already has callouts alone", async () => {
    const { host, calls } = withPacks({ target: () => Promise.resolve({ ...TARGET, activeNoteSetId: "spa-gt3" }) });
    const reply = await run(host, "get_callout_pack", { max_age_days: 365 });
    expect(reply.summary).toBe('Callouts are already running for Spa (Grand Prix) in the Porsche 992 GT3 R: "spa-gt3".');
    expect(names(calls)).toEqual(["target"]);
  });

  it("uses a pack already on the machine before looking anywhere else", async () => {
    const { host, calls } = withPacks({
      local: () =>
        Promise.resolve([
          { noteSetId: "spa-mx5", carClass: "mx5", callouts: 9 },
          { noteSetId: "spa-gt3-empty", carClass: "gt3", callouts: 0 },
          { noteSetId: "spa-gt3", carClass: "gt3", callouts: 14 },
        ]),
    });
    const reply = await run(host, "get_callout_pack", { max_age_days: 365 });
    expect(reply.data).toMatchObject({ status: "activated-local", noteSetId: "spa-gt3" });
    // Another class's pack and an empty one are not this car's callouts.
    expect(calls.at(-1)).toEqual(["activate", "spa-gt3"]);
    expect(names(calls)).not.toContain("shared");
  });

  it("installs the most starred recent shared pack and switches to it", async () => {
    const { host, calls } = withPacks({
      shared: () => Promise.resolve([sharedPack({ itemId: "old", updatedAt: daysAgo(900) }), sharedPack()]),
    });
    const reply = await run(host, "get_callout_pack", { max_age_days: 365 });
    expect(reply.data).toMatchObject({ status: "installed-shared", noteSetId: "installed-set", itemId: "item-1" });
    expect(reply.summary).toContain('Installed "Spa GT3 by Coach" by Coach (12 stars');
    expect(calls.slice(-2)).toEqual([["install", "item-1"], ["activate", "installed-set"]]);
  });

  it("does not download again a shared pack that is already here", async () => {
    const { host, calls } = withPacks({
      // Here, but for another class's count of zero callouts it is not "mine".
      local: () => Promise.resolve([{ noteSetId: "spa-coach", carClass: "gt3", callouts: 0 }]),
      shared: () => Promise.resolve([sharedPack({ installedAs: "spa-coach" })]),
    });
    await run(host, "get_callout_pack", { max_age_days: 365 });
    expect(names(calls)).not.toContain("install");
    expect(calls.at(-1)).toEqual(["activate", "spa-coach"]);
  });

  it("installs again a pack the app remembers but whose note set is gone", async () => {
    const { host, calls } = withPacks({ shared: () => Promise.resolve([sharedPack({ installedAs: "spa-coach" })]) });
    const reply = await run(host, "get_callout_pack", { max_age_days: 365 });
    expect(calls.slice(-2)).toEqual([["install", "item-1"], ["activate", "installed-set"]]);
    expect(reply.data["noteSetId"]).toBe("installed-set");
  });

  it("passes over packs that are too old, and says they exist", async () => {
    const { host, calls } = withPacks({ shared: () => Promise.resolve([sharedPack({ updatedAt: daysAgo(900) })]) });
    const reply = await run(host, "get_callout_pack", { max_age_days: 365 });
    expect(reply.data["status"]).toBe("none");
    expect(reply.summary).toContain("the 1 shared is older than 365 days");
    expect(reply.summary).toContain("search_guide_videos");
    expect(names(calls)).not.toContain("activate");

    // Asked to accept it, it does.
    const again = await run(host, "get_callout_pack", { max_age_days: 2000 });
    expect(again.data["status"]).toBe("installed-shared");
  });

  it("treats shared packs it cannot reach as none, and says why", async () => {
    const { host } = withPacks({ shared: () => Promise.reject(new Error("offline")) });
    const reply = await run(host, "get_callout_pack", { max_age_days: 365 });
    expect(reply.data).toMatchObject({ status: "none", sharedUnreachable: "offline" });
    expect(reply.summary).toContain("shared packs could not be checked (offline)");
  });

  it("with nothing anywhere, hands over what is needed to build one", async () => {
    const reply = await run(fakeHost().host, "get_callout_pack", { max_age_days: 365 });
    expect(reply.summary).toContain("none on this machine and none shared");
    expect(reply.data["session"]).toEqual({
      track_name: "Spa",
      config_name: "Grand Prix",
      track_id: 163,
      car_name: "Porsche 992 GT3 R",
      car_id: "porsche992rgt3",
      car_class: "gt3",
    });
  });
});

describe("callouts from a guide", () => {
  it("lists the mapped tracks and where the sim is", async () => {
    const reply = await run(fakeHost().host, "list_tracks");
    expect(reply.summary).toBe("The sim is at Spa (Grand Prix) in the Porsche 992 GT3 R. 1 mapped track.");
    expect(reply.data["tracks"]).toMatchObject([
      { trackId: 163, configId: "grand-prix", lengthKm: 6.97, referenceLaps: [{ carId: "porsche992rgt3", lapTime: "2:17.300" }] },
    ]);
  });

  it("narrows the race week by series, track or car", async () => {
    const { host } = fakeHost();
    expect((await run(host, "get_race_week", {})).data["entries"]).toHaveLength(2);
    expect((await run(host, "get_race_week", { series: "mx-5" })).data["entries"]).toMatchObject([{ trackName: "Lime Rock" }]);
    expect((await run(host, "get_race_week", { series: "porsche" })).data["entries"]).toMatchObject([{ seriesName: "IMSA" }]);
    expect((await run(host, "get_race_week", { series: "nascar" })).summary).toBe('Nothing this week matches "nascar".');
  });

  it("returns search results with a length a person would read", async () => {
    const reply = await run(fakeHost().host, "search_guide_videos", { query: "iRacing Spa GT3 track guide" });
    expect(reply.data["videos"]).toEqual([
      { videoId: "abcdefghijk", title: "Spa GT3 guide", channel: "Coach", length: "12:34", views: 12000 },
    ]);
  });

  it("hands over the brief with what to do with it", async () => {
    const { host, calls } = fakeHost();
    const reply = await run(host, "get_callout_brief", { ...SPA, ...VIDEO });
    expect(reply.summary).toContain("call import_callouts");
    expect(reply.summary).toContain("[0:10] Turn one, brake at the 100.");
    expect(calls[0]).toEqual([
      "calloutBrief",
      { trackId: 163, trackName: "Spa", configName: "Grand Prix", carName: "Porsche 992 GT3 R", carId: null },
      { id: "abcdefghijk", title: "Spa GT3 guide", channel: "Coach" },
    ]);
  });

  it("imports the reply, and says what did not land", async () => {
    const { host, calls } = fakeHost();
    const reply = await run(host, "import_callouts", { ...SPA, ...VIDEO, reply: '{"callouts":[]}' });
    expect(reply.summary).toBe(
      'Imported and rendered 14 callouts as "spa-gt3-abc" — ready to drive.\n- turn 12: no such corner',
    );
    expect(reply.data).toMatchObject({ ok: true, placed: true, noteSetId: "spa-gt3-abc" });
    // No class given: the app works it out from the car.
    expect(calls[0]?.[3]).toBeNull();
    expect(calls[0]?.[4]).toBe('{"callouts":[]}');
  });
});

describe("the tracer", () => {
  it("says it is not open, and what to do", async () => {
    const { host } = fakeHost();
    const closed = { ...host.tracer, status: () => Promise.resolve({ ...STATUS, video: null, ready: false }) };
    const reply = await run({ ...host, tracer: closed }, "tracer_status");
    expect(reply.summary).toBe("The tracer is not open. Call tracer_open with a video first.");
  });

  it("passes on the window's own word while the video downloads", async () => {
    const { host } = fakeHost();
    const loading = {
      ...host.tracer,
      status: () => Promise.resolve({ ...STATUS, ready: false, message: "Downloading the video…" }),
    };
    expect((await run({ ...host, tracer: loading }, "tracer_status")).summary).toBe("Not ready: Downloading the video…");
  });

  it("sums up a finished read", async () => {
    const reply = await run(fakeHost().host, "tracer_status");
    expect(reply.summary).toContain('"Spa guide", 10:00 long, 1920×1080 pixels.');
    expect(reply.summary).toContain("Boxes placed: pedals, speed.");
    expect(reply.summary).toContain("Found both bars");
    expect(reply.summary).toContain("Line crossings at 71.2, 211.5 s.");
    expect(reply.summary).toContain("Lap set from 71.200 to 211.500 s (2:20.300).");
  });

  it("returns a frame as a picture", async () => {
    const { host, calls } = fakeHost();
    const reply = await run(host, "tracer_frame", { time_s: 90, crop: { x: 800, y: 900, w: 300, h: 150 } });
    expect(reply.images).toEqual([{ mimeType: "image/jpeg", base64: "AAAA" }]);
    expect(reply.summary).toContain("cropped to x 800–1100, y 900–1050");
    expect(calls[0]).toEqual(["frame", 90, { x: 800, y: 900, w: 300, h: 150 }]);
  });

  it("sets only the boxes it was given, and can remove one", async () => {
    const { host, calls } = fakeHost();
    await run(host, "tracer_set_boxes", { pedals: { x: 1, y: 2, w: 30, h: 40 }, gear: null, speed_unit: "mph" });
    expect(calls[0]).toEqual(["setBoxes", { pedals: { x: 1, y: 2, w: 30, h: 40 }, gear: null }, "mph"]);
  });

  it("will not start a read that ends before it begins", async () => {
    const { host, calls } = fakeHost();
    const reply = await run(host, "tracer_read", { from_s: 200, until_s: 100 });
    expect(reply.summary).toBe("until_s must be after from_s.");
    expect(calls).toHaveLength(0);
  });

  it("says how long a read will take", async () => {
    const reply = await run(fakeHost().host, "tracer_read", { from_s: 60, until_s: 240 });
    expect(reply.summary).toContain("about 90 seconds");
  });

  it("shows the shapes and takes their names", async () => {
    const { host, calls } = fakeHost();
    const shapes = await run(host, "tracer_shapes", { kind: "speed" });
    expect(shapes.images).toHaveLength(1);
    expect(shapes.summary).toContain("3 shapes in the speed box");
    await run(host, "tracer_name_shapes", { kind: "speed", labels: ["1", "0", ""] });
    expect(calls[1]).toEqual(["nameShapes", "speed", ["1", "0", ""]]);
  });

  it("passes on only the ends of the lap it was given", async () => {
    const { host, calls } = fakeHost();
    await run(host, "tracer_set_lap", { start_s: 71.2, lap_time: "2:17.300" });
    expect(calls[0]).toEqual(["setLap", { startS: 71.2, lapTime: "2:17.300" }]);
  });

  it("offers to save a sound build, and not a doubtful one", async () => {
    const { host } = fakeHost();
    const target = { track_id: 163, config_id: "grand-prix", car_id: "porsche992rgt3" };
    expect((await run(host, "tracer_build", target)).summary).toContain("tracer_save makes it the reference lap");

    const doubtful = {
      ...host.tracer,
      build: () => Promise.resolve({ summary: "Its speed adds up to 3,100 m and the track is 6,972 m. Do not save it.", doubt: true }),
    };
    const reply = await run({ ...host, tracer: doubtful }, "tracer_build", target);
    expect(reply.summary).not.toContain("tracer_save");
    expect(reply.data["doubt"]).toBe(true);
  });
});

describe("served over MCP", () => {
  const TOKEN = "test-token-0123456789abcdef";
  let server: AssistantServer | null = null;
  let client: Client | null = null;

  afterEach(async () => {
    await client?.close();
    await server?.close();
    client = null;
    server = null;
  });

  async function connect(authoring: AuthoringHost | null): Promise<Client> {
    server = await startAssistantServer({
      state: new AssistantState(),
      token: TOKEN,
      port: 0,
      ...(authoring === null ? {} : { authoring }),
    });
    client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
      }) as Transport,
    );
    return client;
  }

  it("serves no authoring tool unless authoring is allowed", async () => {
    const c = await connect(null);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(c.getInstructions()).toBeUndefined();
  });

  it("serves them all when it is, marked for what they do, with the order of work", async () => {
    const c = await connect(fakeHost().host);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual([...TOOLS, ...AUTHORING_TOOLS].map((t) => t.name));
    expect(tools.find((t) => t.name === "tracer_save")?.annotations?.readOnlyHint).toBe(false);
    expect(tools.find((t) => t.name === "tracer_frame")?.annotations?.readOnlyHint).toBe(true);
    expect(c.getInstructions()).toContain("get_callout_brief");
  });

  it("sends a frame as an image a model can look at", async () => {
    const c = await connect(fakeHost().host);
    const result = await c.callTool({ name: "tracer_frame", arguments: { time_s: 90 } });
    expect(result.content).toEqual([
      { type: "text", text: 'Frame at 90.00 s. The ruler is in video pixels.\n\n{"timeS":90}' },
      { type: "image", data: "AAAA", mimeType: "image/jpeg" },
    ]);
  });

  it("refuses a malformed video id before the app is asked anything", async () => {
    const { host, calls } = fakeHost();
    const c = await connect(host);
    const result = await c.callTool({ name: "tracer_open", arguments: { video_id: "../../etc" } });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("passes on the app's own reason when something cannot be done", async () => {
    const { host } = fakeHost({ searchVideos: () => Promise.reject(new Error("yt-dlp is not installed")) });
    const c = await connect(host);
    const result = await c.callTool({ name: "search_guide_videos", arguments: { query: "spa guide" } });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "Exxeed could not do that: yt-dlp is not installed" }]);
  });
});
