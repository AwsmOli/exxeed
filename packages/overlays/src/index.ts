/**
 * @exxeed/overlays — the IPC contract between the Electron main process and its
 * renderers.
 *
 * The Vue overlays themselves land at M3: the input-trace canvas (§7.1), the
 * delta bar (§7.2) and the dev callout overlay (§7.3). What lives here now is the
 * contract, because main needs it today and it is what keeps §7's hard rule true:
 * timing-critical work runs in main, never a renderer. Renderers get throttled
 * when occluded or backgrounded, which would silently destroy callout timing.
 */

import type { Mps, NoteState, Pct, Radians, Seconds, SuppressionReason } from "@exxeed/core";

/**
 * The overlays, as separate windows.
 *
 * One window per panel rather than one window holding all of them, because a sim
 * rig has a shape: the delta belongs near the eyeline, the trace somewhere it can
 * be glanced at, the map wherever there is room. A single combined panel can only
 * ever be in one of those places.
 *
 * Each is its own BrowserWindow with its own remembered position (§7). They all
 * render the same document — the panel is chosen by query string — so there is
 * one renderer to maintain rather than five.
 */
export const PANELS = ["telemetry", "map", "trace", "delta", "callouts"] as const;

export type PanelId = (typeof PANELS)[number];

export const isPanelId = (v: string): v is PanelId =>
  (PANELS as readonly string[]).includes(v);

export interface PanelSpec {
  readonly id: PanelId;
  readonly title: string;
  /** Starting size. Position is remembered; size is not resized by the user yet. */
  readonly width: number;
  readonly height: number;
}

export const PANEL_SPECS: Readonly<Record<PanelId, PanelSpec>> = {
  telemetry: { id: "telemetry", title: "Telemetry", width: 300, height: 330 },
  map: { id: "map", title: "Track", width: 250, height: 275 },
  trace: { id: "trace", title: "Inputs", width: 340, height: 175 },
  delta: { id: "delta", title: "Delta", width: 230, height: 78 },
  callouts: { id: "callouts", title: "Callouts", width: 320, height: 200 },
};

/** 60 Hz state frame, main → renderer. */
export const STATE_FRAME_CHANNEL = "exxeed:state-frame";

/** Audio clips, main → renderer, once at session start. */
export const AUDIO_PRELOAD_CHANNEL = "exxeed:audio-preload";

/** "Speak this now", main → renderer. Carries no audio, only a key. */
export const AUDIO_PLAY_CHANNEL = "exxeed:audio-play";

/**
 * Everything the engine decided, main → renderer, for the dev overlay (§7.3).
 *
 * Distinct from AUDIO_PLAY_CHANNEL because that one is a command and this is a
 * record. Drops in particular never reached the window before, so the log could
 * show what was said but not what was withheld or why — which is the more useful
 * half when you are sitting in the car wondering about a silence.
 */
export const ENGINE_EVENT_CHANNEL = "exxeed:engine-event";

/** Whether the app is running, and what it is connected to. main → renderer. */
export const SESSION_STATUS_CHANNEL = "exxeed:session-status";

/** Renderer → main: start, stop, or set autostart. */
export const SESSION_COMMAND_CHANNEL = "exxeed:session-command";

/**
 * What the app is doing, for the control window.
 *
 * "waiting" is a normal resting state, not a failure: the app is meant to be
 * left running while the sim comes and goes underneath it.
 */
export type SessionPhase = "stopped" | "waiting" | "running";

export interface SessionStatus {
  readonly phase: SessionPhase;
  readonly autoStart: boolean;
  readonly runAtLogin: boolean;
  readonly startMinimized: boolean;
  /** Track and car the sim reported, once connected. */
  readonly trackName: string | null;
  readonly carName: string | null;
  /** Note set actually loaded, and why there is none when there is none. */
  readonly noteSetId: string | null;
  readonly detail: string | null;
  /** Whether this session is writing a recording, and where. */
  readonly recordingTo: string | null;
}

export type SessionCommand =
  | { readonly kind: "start" }
  | { readonly kind: "stop" }
  | { readonly kind: "autoStart"; readonly value: boolean }
  | { readonly kind: "runAtLogin"; readonly value: boolean }
  | { readonly kind: "startMinimized"; readonly value: boolean }
  | { readonly kind: "quit" };

/**
 * Everything the app is configured by.
 *
 * Replaces a dozen environment variables. Those were a scripting interface being
 * used as a product: fine for a test harness, hopeless for someone who wants to
 * change a voice. They still work as start-up overrides — CI and the replay
 * scripts rely on them — but they are no longer how the thing is meant to be
 * driven.
 *
 * The `debug` group is separated because it is the part that only makes sense
 * against a recording. It is editable only when the app was started with the
 * debug flag; the rest is always editable.
 */
export interface Settings {
  /** Null means telemetry only — no engine, no callouts. */
  readonly noteSetId: string | null;
  /** Null means the built-in demo data. */
  readonly dataDir: string | null;
  readonly voiceId: string;
  /** Null means "the only reference lap recorded for this track". */
  readonly carId: number | null;
  /** Seconds added to every callout's lead. This driver's, not the note set's. */
  readonly leadAdjustS: number;
  readonly panels: readonly PanelId[];
  /**
   * Where Piper lives, so the editor can re-render a callout after editing it.
   *
   * Null means "not set up", and the editor says so rather than failing at the
   * moment someone presses the button.
   */
  readonly piperBinary: string | null;
  readonly piperModel: string | null;
  /**
   * Connect to the sim as soon as it appears, without being asked.
   *
   * The app outlives any one session: it is started once and left running, and
   * the sim comes and goes underneath it. Waiting for the sim is the normal
   * state, not an error.
   */
  readonly autoStart: boolean;
  /**
   * Which note set was last used at each track, keyed by `sim:trackId:configId`.
   *
   * A track can have several sets — different coaches, different car classes —
   * and the useful default is the one that was driven last rather than whichever
   * sorts first. Per track, because the answer at Daytona says nothing about the
   * answer at Spa.
   */
  readonly noteSetByTrack: Readonly<Record<string, string>>;
  /**
   * Launch with Windows.
   *
   * Stored here so the window has something to render, but the setting of record
   * is the OS login-item list — main writes to that and reads it back, because a
   * checkbox that disagrees with what Windows actually does is worse than no
   * checkbox.
   */
  readonly runAtLogin: boolean;
  /**
   * Start with the control window hidden in the tray.
   *
   * The overlays still open and a session still starts: minimised means "do not
   * put a window in front of me", not "do nothing". Pointless without runAtLogin
   * today, but the two are separate settings because "launch on login" and "get
   * out of the way" are separate wishes.
   */
  readonly startMinimized: boolean;
  readonly debug: DebugSettings;
}

export interface DebugSettings {
  /** Replay this recording instead of connecting to the sim. */
  readonly replayPath: string | null;
  /** Replay rate. 1 is real time. */
  readonly replaySpeed: number;
  readonly loopReplay: boolean;
  /**
   * Speak from the first corner instead of waiting out §6.4's out-lap gate.
   *
   * On by default, which is a deliberate departure from §6.4. The gate exists so
   * a callout cannot fire while the driver is still leaving the pits — but every
   * one of those states is *already* suppressed on its own: OnPitRoad, IsInGarage,
   * PlayerCarTowTime and the 30 km/h crawl threshold all hold independently. The
   * gate is a second layer over cases the first layer covers.
   *
   * What it costs is not one lap but nearly two. §6.2 starts every note SPENT,
   * and a note only re-arms once its point is more than half a lap away, so
   * opening the gate at the line still leaves only the back half of the lap
   * armed — measured on Daytona, one callout out of six on the first flying lap
   * and a full set only on the second. Someone joining a session already on
   * track waits that long for nothing.
   */
  readonly skipOutLap: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  noteSetId: null,
  dataDir: null,
  voiceId: "en_test",
  carId: null,
  leadAdjustS: 0,
  panels: [...PANELS],
  piperBinary: null,
  piperModel: null,
  autoStart: true,
  noteSetByTrack: {},
  runAtLogin: false,
  startMinimized: false,
  debug: {
    replayPath: null,
    replaySpeed: 1,
    loopReplay: true,
    skipOutLap: true,
  },
};

/**
 * Merge stored values over the defaults, field by field.
 *
 * Not a spread. A settings file written by an older version is missing keys, and
 * a shallow merge would drop the whole `debug` group the moment one field of it
 * was absent — which is exactly the shape of file that upgrades produce.
 *
 * Pure, so it can be tested without touching a disk.
 */
export function withDefaults(stored: Partial<Settings> | null | undefined): Settings {
  const s = stored ?? {};

  const panels = Array.isArray(s.panels)
    ? s.panels.filter((p): p is PanelId => typeof p === "string" && isPanelId(p))
    : DEFAULT_SETTINGS.panels;

  const number = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;

  const storedDebug =
    typeof s.debug === "object" && s.debug !== null ? s.debug : ({} as Partial<DebugSettings>);

  return {
    noteSetId: s.noteSetId ?? DEFAULT_SETTINGS.noteSetId,
    dataDir: s.dataDir ?? DEFAULT_SETTINGS.dataDir,
    voiceId: typeof s.voiceId === "string" && s.voiceId !== "" ? s.voiceId : DEFAULT_SETTINGS.voiceId,
    carId: typeof s.carId === "number" ? s.carId : DEFAULT_SETTINGS.carId,
    leadAdjustS: number(s.leadAdjustS, DEFAULT_SETTINGS.leadAdjustS),
    // An empty list would open no windows at all, with no way back from inside
    // the app. Treat it as "not set".
    panels: panels.length === 0 ? DEFAULT_SETTINGS.panels : panels,
    piperBinary: s.piperBinary ?? DEFAULT_SETTINGS.piperBinary,
    piperModel: s.piperModel ?? DEFAULT_SETTINGS.piperModel,
    autoStart:
      typeof s.autoStart === "boolean" ? s.autoStart : DEFAULT_SETTINGS.autoStart,
    runAtLogin:
      typeof s.runAtLogin === "boolean" ? s.runAtLogin : DEFAULT_SETTINGS.runAtLogin,
    startMinimized:
      typeof s.startMinimized === "boolean"
        ? s.startMinimized
        : DEFAULT_SETTINGS.startMinimized,
    noteSetByTrack:
      typeof s.noteSetByTrack === "object" && s.noteSetByTrack !== null
        ? Object.fromEntries(
            Object.entries(s.noteSetByTrack).filter(([, v]) => typeof v === "string"),
          )
        : DEFAULT_SETTINGS.noteSetByTrack,
    debug: {
      replayPath: storedDebug.replayPath ?? DEFAULT_SETTINGS.debug.replayPath,
      replaySpeed: number(storedDebug.replaySpeed, DEFAULT_SETTINGS.debug.replaySpeed),
      loopReplay:
        typeof storedDebug.loopReplay === "boolean"
          ? storedDebug.loopReplay
          : DEFAULT_SETTINGS.debug.loopReplay,
      skipOutLap:
        typeof storedDebug.skipOutLap === "boolean"
          ? storedDebug.skipOutLap
          : DEFAULT_SETTINGS.debug.skipOutLap,
    },
  };
}

/**
 * Apply environment overrides on top of stored settings.
 *
 * They still exist because the scripts and tests in this repo lean on them, but
 * an override is never written back: running one session with a replay speed of
 * 8 should not quietly become the saved preference.
 */
export function withEnvOverrides(
  settings: Settings,
  env: Readonly<Record<string, string | undefined>>,
): Settings {
  const get = (name: string): string | undefined => {
    const v = env[name];
    return v === undefined || v === "" ? undefined : v;
  };
  const num = (name: string): number | undefined => {
    const raw = get(name);
    if (raw === undefined) return undefined;
    const v = Number(raw);
    return Number.isFinite(v) ? v : undefined;
  };

  const panelsRaw = get("EXXEED_PANELS");
  const panels =
    panelsRaw === undefined
      ? settings.panels
      : panelsRaw.split(",").map((p) => p.trim()).filter(isPanelId);

  return {
    noteSetId: get("EXXEED_NOTES") ?? settings.noteSetId,
    dataDir: get("EXXEED_DATA") ?? settings.dataDir,
    voiceId: get("EXXEED_VOICE") ?? settings.voiceId,
    carId: num("EXXEED_CAR") ?? settings.carId,
    leadAdjustS: num("EXXEED_LEAD_ADJUST") ?? settings.leadAdjustS,
    panels: panels.length === 0 ? settings.panels : panels,
    piperBinary: get("EXXEED_PIPER") ?? settings.piperBinary,
    piperModel: get("EXXEED_PIPER_MODEL") ?? settings.piperModel,
    autoStart: get("EXXEED_AUTOSTART") !== undefined || settings.autoStart,
    noteSetByTrack: settings.noteSetByTrack,
    runAtLogin: settings.runAtLogin,
    startMinimized: settings.startMinimized,
    debug: {
      replayPath: get("EXXEED_REPLAY") ?? settings.debug.replayPath,
      replaySpeed: num("EXXEED_SPEED") ?? settings.debug.replaySpeed,
      loopReplay: settings.debug.loopReplay,
      skipOutLap: get("EXXEED_SKIP_OUTLAP") !== undefined || settings.debug.skipOutLap,
    },
  };
}

/**
 * Is the debug surface available?
 *
 * Running from source is development by definition, so the Debug section is on
 * there without anyone having to remember a flag — and `app.isPackaged` says so
 * cross-platform, where an env var set in an npm script would not survive
 * Windows `cmd`.
 *
 * A packaged build is off unless explicitly asked, which is what keeps the
 * safety meaningful: debug settings persist but only bite while debug is on, so
 * a replay file set once can never quietly stop a real user's sim connecting.
 *
 * `EXXEED_DEBUG` decides either way when set — including "0" to force it off,
 * which is how you check packaged behaviour without packaging.
 */
export function resolveDebugEnabled(
  packaged: boolean,
  envValue: string | undefined,
): boolean {
  if (envValue !== undefined && envValue !== "") {
    return envValue !== "0" && envValue.toLowerCase() !== "false";
  }
  return !packaged;
}

/** What the preferences window needs to populate its pickers. */
export interface SettingsOptions {
  readonly noteSets: readonly { readonly id: string; readonly label: string }[];
  readonly voices: readonly string[];
  readonly cars: readonly number[];
  /** True when the app was started with the debug flag. */
  readonly debugEnabled: boolean;
  readonly dataDir: string;
}

export interface SettingsPayload {
  readonly settings: Settings;
  readonly options: SettingsOptions;
}

/** Renderer → main, invoke: everything the note editor draws (§7.4). */
export const EDITOR_LOAD_CHANNEL = "exxeed:editor-load";
/** Renderer → main, invoke: save edited notes and get the recomputed view back. */
export const EDITOR_SAVE_CHANNEL = "exxeed:editor-save";
/** Renderer → main, invoke: re-render the note set's audio (§10 stage 6). */
export const EDITOR_RENDER_CHANNEL = "exxeed:editor-render";

/** Main → editor: the menu asked for a render, do the same thing the button does. */
export const EDITOR_RENDER_REQUEST_CHANNEL = "exxeed:editor-render-request";

export interface RenderResultView {
  readonly ok: boolean;
  /** Why it could not run, or what went wrong. */
  readonly message: string;
  readonly payload: EditorPayload | null;
}

/** One note as the editor sees it: what it says, where, and when it speaks. */
export interface EditorNote {
  readonly id: string;
  readonly pct: number;
  readonly text: string;
  readonly textShort: string;
  readonly priority: number;
  readonly leadAdjustS: number;
  /** Text edited since the audio was rendered, so the window below is stale. */
  readonly dirty: boolean;
  readonly durationMs: number;
  readonly shortDurationMs: number;
  /** Where the voice starts, walking the reference speed profile (§7.4). */
  readonly startPct: number;
  /** Where the ENGINE will start, which is not the same on a changing speed. */
  readonly runtimeStartPct: number;
  readonly leadS: number;
  readonly windowM: number;
  /** Seconds to add so the engine's start matches the true one. */
  readonly suggestedLeadAdjustS: number;
  /** Nearest measured braking point, for "put it where braking starts". */
  readonly nearestOnsetPct: number | null;
  /** Ids of notes whose speaking window overlaps this one's. */
  readonly overlaps: readonly string[];
}

export interface EditorPayload {
  readonly noteSetId: string;
  readonly title: string;
  readonly lengthM: number;
  readonly status: string;
  /** Centreline normalised to 0..1 with aspect preserved, as the map view. */
  readonly x: readonly number[];
  readonly y: readonly number[];
  readonly corners: readonly {
    readonly index: number;
    readonly entryPct: number;
    readonly apexPct: number;
    readonly exitPct: number;
  }[];
  readonly notes: readonly EditorNote[];
  /**
   * Without a reference lap there is no speed profile, so no window can be drawn
   * — the editor says so rather than drawing something made up.
   */
  readonly hasReference: boolean;
  /** False when Piper is not configured, so the editor can say so up front. */
  readonly canRender: boolean;
}

/** What the editor sends back. Only the fields it can change. */
export interface EditorNotePatch {
  readonly id: string;
  readonly pct: number;
  readonly text: string;
  readonly textShort: string;
  readonly leadAdjustS: number;
}

/** Renderer → main, invoke: read the current settings and pickers. */
export const SETTINGS_GET_CHANNEL = "exxeed:settings-get";
/** Renderer → main, invoke: merge a patch and persist it. */
export const SETTINGS_SET_CHANNEL = "exxeed:settings-set";
/** Main → renderer: settings changed, here they are. */
export const SETTINGS_CHANGED_CHANNEL = "exxeed:settings-changed";

/**
 * Renderer → main: move this window by a screen-pixel delta.
 *
 * The one channel that runs that way. Dragging is done in JS rather than with
 * `-webkit-app-region: drag` because that property swallows every mouse event in
 * its region — no way to tell a click from a drag, no cursor feedback of its own,
 * and it behaves inconsistently on transparent frameless windows. A mousedown,
 * a delta, and `setPosition` is both more predictable and something we can show
 * the user is happening.
 */
export const MOVE_WINDOW_CHANNEL = "exxeed:move-window";

export interface MoveWindowRequest {
  readonly dx: number;
  readonly dy: number;
}

/** The track outline, main → renderer, once at session start. */
export const MAP_CHANNEL = "exxeed:map";

/** The reference lap's channels, main → renderer, once at session start. */
export const REFERENCE_CHANNEL = "exxeed:reference";

/**
 * The compact state frame pushed to renderers.
 *
 * Deliberately small. §7: "Never send raw telemetry across IPC." Renderers get
 * what they need to draw and nothing more — the engine's inputs stay in main.
 */
export interface StateFrame {
  readonly tMs: number;
  readonly lap: number;
  readonly lapDistPct: Pct;
  /** m/s. Convert to km/h in render code and nowhere else (§3, §7.1). */
  readonly speedMps: Mps;
  readonly throttle: number;
  readonly brake: number;
  readonly gear: number;
  /**
   * Radians. Which sign means left is NOT assumed — see
   * `@exxeed/telemetry`'s steering.ts and §5. Present here because M0b has to
   * read it off a real lap, and M3's corner guides need it after that.
   */
  readonly steerRad: Radians;
  /**
   * Degrees, straight off the SDK. Here so M0b can confirm at a glance that the
   * channels are actually populated — §4.1.1's centreline depends on it, and the
   * dead-reckoning fallback drifts. Drop from the frame once that is settled.
   */
  readonly lat: number;
  readonly lon: number;
  /** Seconds vs the reference lap at this pct index (§7.2). Null until M3. */
  readonly deltaS: Seconds | null;
  readonly connected: boolean;
  readonly sourceName: string;
  /** Driver's elapsed time on this lap. Null until a start/finish crossing has
   *  been seen, since there is nothing to measure from before that. */
  readonly lapElapsedS: Seconds | null;
  /** Non-null when the engine is deliberately quiet. For the dev overlay (§7.3). */
  readonly suppressedBy: SuppressionReason | null;
  readonly queuedNoteIds: readonly string[];
  /** Notes currently ARMED (§6.2). For the dev overlay. */
  readonly armedNoteIds: readonly string[];
}

/** One engine decision, flattened for display. */
export interface EngineEventView {
  readonly kind: "play" | "drop";
  readonly noteId: string;
  /** "full" | "short" for a play, the drop reason otherwise. */
  readonly detail: string;
  readonly leadM: number | null;
  readonly dAheadM: number;
  readonly atPct: number;
}

/** One preloaded clip. Sent once; the renderer decodes and keeps it. */
export interface AudioClip {
  readonly key: string;
  readonly wav: Uint8Array;
}

export interface AudioPlayCommand {
  readonly key: string;
  readonly noteId: string;
  readonly durationMs: number;
}

/**
 * The track drawn as a closed polyline, plus where the notes are.
 *
 * Display only. The engine needs no TrackMap (§4.4) and this does not change
 * that — main loads one if there happens to be a cut for this track, and the
 * window simply has nothing to draw if there isn't.
 *
 * Coordinates are normalised to 0..1 with the aspect ratio preserved, so the
 * renderer scales to whatever box it has without knowing about metres.
 */
export interface TrackMapView {
  readonly trackName: string;
  readonly configName: string;
  /** So the window can report distances in metres rather than percentages. */
  readonly lengthM: number;
  /** Centreline, x/y in 0..1, already aspect-corrected. Closed loop. */
  readonly x: readonly number[];
  readonly y: readonly number[];
  /** Where each note speaks, as an index into x/y. */
  readonly notes: readonly { readonly id: string; readonly index: number }[];
  /** Start/finish, as an index into x/y. */
  readonly startIndex: number;
}

/**
 * What the input trace (§7.1) and the delta bar (§7.2) draw against.
 *
 * Sent once. These arrays are ~2000 samples and never change during a session,
 * which is exactly why §7.0 says to `markRaw` them in a Vue renderer: making
 * them reactive is a measurable waste on load and buys nothing.
 *
 * Everything shares the pct grid (§4.3), so drawing the reference beside the
 * live trace is an index lookup with no time alignment to get wrong.
 */
export interface ReferenceView {
  readonly gridSize: number;
  readonly lapTimeS: number;
  readonly carId: number;
  /** 0..1. */
  readonly throttle: readonly number[];
  /** 0..1. */
  readonly brake: readonly number[];
  /** m/s. Converted to km/h in render code and nowhere else (§3). */
  readonly speedMps: readonly number[];
  /** Elapsed lap time at each pct — what makes the delta bar a lookup (§7.2). */
  readonly elapsedS: readonly number[];
  /** Faint vertical guides on the trace. */
  readonly corners: readonly {
    readonly index: number;
    readonly entryPct: number;
    readonly apexPct: number;
    readonly exitPct: number;
  }[];
  /**
   * Where the reference lap started braking, per corner.
   *
   * §7.1: "Seeing your brake trace start after the reference marker is the single
   * most legible piece of feedback in the app."
   */
  readonly brakeOnsetPcts: readonly number[];
}

/** For the dev callout overlay (§7.3). Not a shipping surface. */
export interface EngineDebugState {
  readonly noteStates: ReadonlyMap<string, NoteState>;
}

/**
 * Renderer-side reactivity rules for the state frame — SPEC.md §7.0, restated
 * here because this is the file every renderer imports:
 *
 *  - Hold the frame in a `shallowRef` and REPLACE it wholesale. Deep reactivity
 *    on an object discarded 60 times a second is pure overhead.
 *  - `markRaw` the reference-lap channel arrays. 2000 elements that never change
 *    during a session; proxying them is a measurable waste on load.
 *  - Canvas components must not re-render on telemetry at all. Subscribe to the
 *    channel in `onMounted`, draw in a `requestAnimationFrame` loop, and let Vue
 *    own only mount/unmount. A Vue update cycle per frame is a bug, not an
 *    optimisation target.
 */
export const REACTIVITY_RULES = "SPEC.md §7.0" as const;
