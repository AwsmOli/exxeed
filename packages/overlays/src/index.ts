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
 * one renderer to maintain rather than twenty.
 *
 * The set follows GO Fast's overlay suite, so someone moving from it finds the
 * panels they expect, less the two the SDK cannot feed: a racing-line
 * comparison needs a lateral track position iRacing does not expose, and a
 * weather forecast needs a forecast it does not publish.
 */
export const PANELS = [
  // Driving — the car's own inputs, against the reference where there is one.
  "inputs",
  "pedals",
  "trace",
  "speed",
  "brake",
  // Timing.
  "delta",
  "sectors",
  "corners",
  "reference",
  // The race around the car. Live sim only — see RaceView.
  "standings",
  "relative",
  "radar",
  // Track.
  "map",
  "minimap",
  // The car.
  "fuel",
  "tyres",
  "damage",
  "weather",
  // Exxeed's own.
  "callouts",
  "telemetry",
] as const;

export type PanelId = (typeof PANELS)[number];

export const isPanelId = (v: string): v is PanelId =>
  (PANELS as readonly string[]).includes(v);

/**
 * What a fresh install opens.
 *
 * Not every panel. There are twenty, and twenty windows on first launch is a
 * wall to pull apart before anything can be driven. These are the ones Exxeed
 * is actually about — where to brake, and how that went — and the rest are a
 * checkbox away in the Overlays section.
 */
export const DEFAULT_PANELS: readonly PanelId[] = [
  "telemetry",
  "map",
  "trace",
  "delta",
  "brake",
  "callouts",
];

export interface PanelSpec {
  readonly id: PanelId;
  readonly title: string;
  /** Starting size. Position and size are both remembered once changed. */
  readonly width: number;
  readonly height: number;
}

export const PANEL_SPECS: Readonly<Record<PanelId, PanelSpec>> = {
  inputs: { id: "inputs", title: "Essential Inputs", width: 540, height: 110 },
  pedals: { id: "pedals", title: "Input Telemetry", width: 540, height: 170 },
  trace: { id: "trace", title: "Input Comparison", width: 640, height: 150 },
  speed: { id: "speed", title: "Speed Comparison", width: 640, height: 140 },
  brake: { id: "brake", title: "Brake Indicator", width: 300, height: 72 },
  delta: { id: "delta", title: "Delta Bar", width: 340, height: 72 },
  sectors: { id: "sectors", title: "Delta Sectors", width: 280, height: 224 },
  corners: { id: "corners", title: "Corner Analysis", width: 340, height: 220 },
  reference: { id: "reference", title: "Comparison Target", width: 360, height: 190 },
  standings: { id: "standings", title: "Standings", width: 640, height: 420 },
  relative: { id: "relative", title: "Relatives", width: 440, height: 360 },
  radar: { id: "radar", title: "Radar", width: 260, height: 260 },
  map: { id: "map", title: "Track Map", width: 360, height: 360 },
  minimap: { id: "minimap", title: "Mini Map", width: 230, height: 230 },
  fuel: { id: "fuel", title: "Fuel Calculator", width: 260, height: 340 },
  tyres: { id: "tyres", title: "Tyres", width: 250, height: 340 },
  damage: { id: "damage", title: "Damage", width: 220, height: 100 },
  weather: { id: "weather", title: "Weather Conditions", width: 400, height: 130 },
  callouts: { id: "callouts", title: "Callouts", width: 320, height: 220 },
  telemetry: { id: "telemetry", title: "Telemetry", width: 300, height: 340 },
};

/**
 * The field, fuel, tyres and weather, main → renderer, a few times a second.
 *
 * Not on the state frame, and not at its rate. §7 wants that frame small, and
 * nothing here changes fast enough to be worth 60 Hz — a standings table
 * redrawn sixty times a second only flickers. Sent only while the source has
 * it (the live sim does; a replay never does), and null when it goes away, so
 * the race panels can say so rather than show the last race forever.
 */
export const RACE_CHANNEL = "exxeed:race";

/** One row of the standings, as the panel draws it. */
export interface RaceRow {
  readonly carIdx: number;
  readonly position: number;
  readonly classPosition: number;
  readonly carNumber: string;
  readonly name: string;
  readonly iRating: number;
  readonly license: string;
  readonly licenseColor: string;
  readonly lap: number;
  /** Seconds behind the class leader. Null for the leader. */
  readonly gapS: number | null;
  /** Seconds behind the car one place ahead in class. Null for the leader. */
  readonly intervalS: number | null;
  readonly lastLapS: number | null;
  readonly bestLapS: number | null;
  /** Holds the class's fastest lap — drawn purple, as every timing screen does. */
  readonly fastest: boolean;
  readonly onPitRoad: boolean;
  readonly isPlayer: boolean;
}

export interface RaceClass {
  readonly classId: number;
  readonly className: string;
  readonly classColor: string;
  /** Strength of field for this class alone. */
  readonly sof: number | null;
  readonly rows: readonly RaceRow[];
}

/** One car near the player on the road, for the relative. */
export interface RelativeRow {
  readonly carIdx: number;
  readonly position: number;
  readonly carNumber: string;
  readonly name: string;
  readonly classColor: string;
  readonly iRating: number;
  readonly license: string;
  readonly licenseColor: string;
  readonly lap: number;
  /** Seconds on the road, positive ahead. */
  readonly gapS: number;
  /** +1 lapping the player, −1 being lapped by them, 0 on the same lap. */
  readonly lapState: -1 | 0 | 1;
  readonly onPitRoad: boolean;
  readonly isPlayer: boolean;
}

export type SpotterState = "off" | "clear" | "left" | "right" | "both" | "twoLeft" | "twoRight";

export interface RaceView {
  readonly sessionType: string;
  /** "moderate usage" — how rubbered-in the track is, in the sim's words. */
  readonly rubber: string;
  /** Where the shift lights start, and where they say shift. RPM. */
  readonly shiftLights: {
    readonly firstRpm: number;
    readonly shiftRpm: number;
    readonly lastRpm: number;
    readonly blinkRpm: number;
  } | null;
  readonly lap: number;
  readonly lapsTotal: number | null;
  readonly lapsRemain: number | null;
  readonly timeRemainS: number | null;
  readonly trackLengthM: number | null;
  readonly classes: readonly RaceClass[];
  /** Ahead first, the player in the middle, behind last. */
  readonly relatives: readonly RelativeRow[];
  /** Every car in the world, for the maps. */
  readonly cars: readonly {
    readonly carIdx: number;
    readonly lapDistPct: number;
    readonly classColor: string;
    readonly isPlayer: boolean;
    readonly onPitRoad: boolean;
  }[];
  readonly radar: {
    readonly spotter: SpotterState;
    /** Cars within radar range, metres along the road — positive ahead. */
    readonly nearby: readonly { readonly aheadM: number; readonly classColor: string }[];
  };
  readonly fuel: {
    readonly levelL: number;
    readonly levelPct: number;
    readonly tankL: number;
    readonly useLph: number;
    readonly perLapL: number | null;
    readonly lastLapL: number | null;
    readonly maxLapL: number | null;
    readonly lapsLeft: number | null;
    readonly toFinishL: number | null;
    readonly marginL: number | null;
  };
  readonly tyres: Readonly<
    Record<
      "lf" | "rf" | "lr" | "rr",
      {
        readonly tempC: readonly number[];
        readonly wear: readonly number[];
        readonly coldPressureKpa: number;
      }
    >
  >;
  readonly weather: {
    readonly airC: number;
    readonly trackC: number;
    readonly humidity: number;
    readonly precipitation: number;
    readonly windMps: number;
    readonly windDirRad: number;
    readonly wetness: string;
    readonly skies: string;
    readonly declaredWet: boolean;
  };
  readonly repairS: number;
  readonly optionalRepairS: number;
  readonly brakeBiasPct: number | null;
  readonly incidents: number;
  readonly sectorStartPcts: readonly number[];
  readonly lastLapS: number | null;
  readonly bestLapS: number | null;
}

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

/** Renderer → main, invoke: publish the editor's note set, and its versions (M8). */
export const PUBLISH_CHANNEL = "exxeed:publish";

export type PublishVisibility = "private" | "unlisted" | "public";

export interface PublishFields {
  readonly title: string;
  readonly summary: string;
  readonly readme: string;
  readonly visibility: PublishVisibility;
}

/** What the editor's publish dialog shows for the note set it has open. */
export interface PublishState {
  readonly signedIn: boolean;
  readonly noteSetId: string | null;
  /** Callouts whose audio is older than their words; publishing is refused while > 0. */
  readonly dirtyCount: number;
  readonly noteCount: number;
  /** Someone else's pack, installed here — not this person's to publish. */
  readonly installed: boolean;
  /** Filled for a first publish, from the track and car. */
  readonly suggested: PublishFields;
  /** Files for the next version: the last version's, plus and minus changes. */
  readonly files: readonly PublishFile[];
  /** The files differ from the latest version's, so publishing makes a new version. */
  readonly filesChanged: boolean;
  /** Null until this set has been published at least once. */
  readonly published: {
    readonly itemId: string;
    readonly fields: PublishFields;
    readonly latestVersion: number | null;
    readonly localVersion: number | null;
    readonly starCount: number;
    readonly downloadCount: number;
    readonly versions: readonly {
      readonly id: string;
      readonly version: number;
      readonly changelog: string;
      readonly publishedAt: string;
      readonly withdrawn: boolean;
      readonly downloads: number;
    }[];
    /** What changed since the latest published version, one line each. */
    readonly changes: readonly string[];
    /** The page's icon and screenshots (M8 step 5). */
    readonly media: readonly { readonly id: string; readonly kind: "icon" | "screenshot"; readonly url: string }[];
  } | null;
}

/** A file to go out with the next version: a setup or an iRacing lap file (M8 step 6). */
export interface PublishFile {
  readonly key: string;
  readonly kind: "setup" | "blap" | "olap";
  readonly label: string;
  /** The file's own name, for recognising it. */
  readonly name: string;
  readonly bytes: number;
  /** What a lap file's header says, e.g. "Sebastian Crex · 1:02.667". */
  readonly detail: string | null;
  /** Added since the last version, so it still needs the rights confirmation. */
  readonly isNew: boolean;
}

export type PublishRequest =
  | { readonly op: "state" }
  | {
      readonly op: "publish";
      readonly fields: PublishFields;
      readonly changelog: string;
      /** "These files are mine to share" — required when new files are attached. */
      readonly filesConfirmed?: boolean;
    }
  | { readonly op: "addFiles" }
  | { readonly op: "removeFile"; readonly key: string }
  | { readonly op: "setFileLabel"; readonly key: string; readonly label: string }
  | { readonly op: "withdraw"; readonly versionId: string }
  /** Pick an image file, re-encode it (dropping its metadata) and add it to the page. */
  | { readonly op: "addMedia"; readonly kind: "icon" | "screenshot" }
  | { readonly op: "removeMedia"; readonly mediaId: string };

/** Renderer → main, invoke: sign in, sign out, edit the profile (M8). */
export const ACCOUNT_CHANNEL = "exxeed:account";
/** Main → renderer: who is signed in changed. */
export const ACCOUNT_CHANGED_CHANNEL = "exxeed:account-changed";

/**
 * Who is signed in, as a window may see it. No tokens: the session stays in
 * main (apps/desktop/src/account.ts).
 */
export interface AccountView {
  /** False when no backend is configured or it cannot be reached. */
  readonly available: boolean;
  readonly signedIn: boolean;
  readonly userId: string | null;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
  /** False until the person has confirmed their display name on first sign-in. */
  readonly onboarded: boolean;
  /** OAuth providers switched on for the project, e.g. { discord: true }. */
  readonly providers: Readonly<Record<string, boolean>>;
  /** A sign-in in progress in the browser, so the dialog can say so. */
  readonly waitingForBrowser: boolean;
}

export type AccountRequest =
  | { readonly op: "view" }
  | { readonly op: "signInWith"; readonly provider: string }
  | { readonly op: "cancelBrowserSignIn" }
  | { readonly op: "sendEmailCode"; readonly email: string }
  | { readonly op: "verifyEmailCode"; readonly email: string; readonly code: string }
  | { readonly op: "saveProfile"; readonly displayName: string }
  | { readonly op: "signOut" };

/**
 * What the app is doing, for the control window.
 *
 * "waiting" is a normal resting state, not a failure: the app is meant to be
 * left running while the sim comes and goes underneath it.
 */
export type SessionPhase = "stopped" | "waiting" | "running";

/** One callout pack, as the control window lists it. */
export interface NoteSetPack {
  /** Empty for a track that has a map but no notes written for it yet. */
  readonly id: string;
  readonly trackName: string;
  readonly carClass: string;
  readonly noteCount: number;
  readonly status: string;
  readonly trackId: number;
  readonly configId: string;
  /** Set while this is the pack a running session actually loaded. */
  readonly active: boolean;
  /**
   * Published content this set belongs to (M8), or null for a set that has
   * never been published or installed — an import, or one written by hand.
   */
  readonly content: {
    readonly itemId: string;
    readonly origin: "mine" | "installed";
    /** The version this machine has. Null for mine before its first publish. */
    readonly version: number | null;
    /** The newest published version, when last checked. Null until checked or offline. */
    readonly latestVersion: number | null;
    readonly policy: "auto" | "pinned";
    readonly stars: number | null;
    readonly downloads: number | null;
  } | null;
}

/**
 * One of your own packs that is on your account but not on this machine —
 * published or drafted on the other one. Shown under Mine with a Download.
 */
export interface RemotePack {
  readonly itemId: string;
  readonly title: string;
  readonly trackLabel: string;
  readonly carClass: string | null;
  readonly latestVersion: number | null;
}

/** Renderer → main, invoke: browse Content and read an item's page (M8). */
export const CONTENT_CHANNEL = "exxeed:content";

export type ContentSort = "stars" | "downloads" | "updated" | "new";

export interface ContentTrackKey {
  readonly sim: "iracing";
  readonly trackId: number;
  readonly configId: string;
}

/** What the Content sidebar filters by. Everything optional; empty lists everything. */
export interface ContentFilters {
  readonly text: string;
  readonly trackKey: ContentTrackKey | null;
  readonly carClass: string | null;
  readonly starred: boolean;
  readonly installed: boolean;
  readonly sort: ContentSort;
}

/** Where this machine stands with an item. */
export interface ContentLocal {
  readonly noteSetId: string;
  readonly origin: "mine" | "installed";
  readonly version: number | null;
  readonly policy: "auto" | "pinned";
}

export interface ContentRow {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly authorName: string;
  /** Only ever not "public" on your own packs, which you see whatever their visibility. */
  readonly visibility: "private" | "unlisted" | "public";
  /** Yours — editable, whether or not it is on this machine. */
  readonly isOwner: boolean;
  readonly trackLabel: string;
  readonly carClass: string | null;
  readonly stars: number;
  readonly downloads: number;
  readonly latestVersion: number | null;
  readonly updatedAt: string;
  readonly iconUrl: string | null;
  readonly starred: boolean;
  readonly local: ContentLocal | null;
}

export interface ContentPage extends ContentRow {
  readonly readme: string;
  readonly trackKey: ContentTrackKey | null;
  readonly shareLink: string;
  readonly screenshots: readonly string[];
  readonly versions: readonly LibraryVersion[];
  /** The latest version's attached files. */
  readonly files: readonly {
    readonly kind: "setup" | "blap" | "olap";
    readonly label: string;
    readonly bytes: number;
    readonly carId: string | null;
  }[];
  /** The latest version's callouts, in lap order. */
  readonly callouts: readonly { readonly id: string; readonly text: string; readonly textShort: string; readonly metresFromStart: number }[];
  /** Null when no map of the layout has been shared yet. */
  readonly map: TrackMapView | null;
  readonly facts: {
    readonly callouts: number;
    readonly mapVersion: number | null;
    readonly source: { readonly title: string | null; readonly url: string | null; readonly channel: string | null } | null;
    readonly publishedAt: string | null;
  };
}

export type ContentRequest =
  | { readonly op: "facets" }
  | { readonly op: "browse"; readonly filters: ContentFilters; readonly offset: number }
  | { readonly op: "page"; readonly itemId: string }
  | { readonly op: "star"; readonly itemId: string; readonly on: boolean }
  /** Download the latest version's files into a folder the driver picks. */
  | { readonly op: "saveFiles"; readonly itemId: string }
  /** A link in a description or a source video: opened in the browser, never in the app. */
  | { readonly op: "openExternal"; readonly url: string };

export interface ContentFacets {
  readonly layouts: readonly { readonly trackKey: ContentTrackKey; readonly label: string }[];
  readonly carClasses: readonly { readonly id: string; readonly name: string }[];
  readonly signedIn: boolean;
}

/** On a combo with no callouts: how many packs Content has for it (M8 step 5). */
export interface ContentHint {
  readonly trackKey: ContentTrackKey;
  readonly carClass: string | null;
  readonly label: string;
  readonly count: number;
}

/** Renderer → main, invoke: import a lap file (a Garage 61 CSV) as a map and reference lap. */
export const LAP_IMPORT_CHANNEL = "exxeed:lap-import";

/** A lap read from a file, waiting for the driver to confirm track and car. */
export interface LapImportDraft {
  /** Names the parsed lap held in main until `import` or a new `pick`. */
  readonly token: string;
  readonly fileName: string;
  /** From the file name, when it follows Garage 61's pattern. */
  readonly driver: string | null;
  readonly carName: string | null;
  readonly trackName: string | null;
  readonly layoutName: string | null;
  readonly lapTimeS: number;
  readonly samples: number;
  /** Every layout the app knows, the best name match first. */
  readonly layouts: readonly { readonly trackKey: ContentTrackKey; readonly label: string; readonly hasMap: boolean }[];
  readonly suggestedLayout: ContentTrackKey | null;
  readonly cars: readonly { readonly carId: string; readonly name: string }[];
  readonly suggestedCarId: string | null;
}

export type LapImportRequest =
  | { readonly op: "pick" }
  | { readonly op: "import"; readonly token: string; readonly trackKey: ContentTrackKey; readonly carId: string };

/** Renderer → main, invoke: install, update, uninstall packs (M8). */
export const LIBRARY_CHANNEL = "exxeed:library";

export type LibraryRequest =
  /** A pack id, or a link containing one (`exxeed://pack/<id>`). A version id pins that version. */
  | { readonly op: "install"; readonly ref: string; readonly versionId?: string }
  | { readonly op: "uninstall"; readonly noteSetId: string }
  | { readonly op: "setPolicy"; readonly noteSetId: string; readonly policy: "auto" | "pinned" }
  | { readonly op: "versions"; readonly itemId: string }
  /** One of your own packs from your account onto this machine. */
  | { readonly op: "downloadMine"; readonly itemId: string }
  | { readonly op: "checkUpdates" };

export interface LibraryVersion {
  readonly id: string;
  readonly version: number;
  readonly changelog: string;
  readonly changes: readonly string[];
  readonly publishedAt: string;
  readonly withdrawn: boolean;
}

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
  /** Every pack on disk, for the picker. */
  readonly packs: readonly NoteSetPack[];
  /** Your own packs that are on your account but not on this machine (M8). */
  readonly remoteMine: readonly RemotePack[];
  /** A long-running library operation, for the Track Coach tab to show. */
  readonly libraryBusy: string | null;
  /** Set while a session runs with no callouts for its combo (M8 step 5). */
  readonly contentHint: ContentHint | null;
  /** Replaying a lap by choice instead of connecting to the sim. */
  readonly testMode: boolean;
  /**
   * The pack pinned by hand, or null to follow whatever track the sim loads.
   *
   * Distinct from `noteSetId`, which is what a session ended up using: pinning
   * Spa's notes while sitting at Daytona is a choice the app should keep and
   * show, not silently correct.
   */
  readonly pinnedNoteSetId: string | null;
}

export type SessionCommand =
  | { readonly kind: "start" }
  | { readonly kind: "stop" }
  /** Replay a lap through the app — overlays and callouts — instead of the sim. */
  | { readonly kind: "testMode"; readonly value: boolean }
  | { readonly kind: "autoStart"; readonly value: boolean }
  | { readonly kind: "runAtLogin"; readonly value: boolean }
  | { readonly kind: "startMinimized"; readonly value: boolean }
  | { readonly kind: "selectNoteSet"; readonly id: string | null }
  | { readonly kind: "editNoteSet"; readonly id: string }
  /** With a track, the importer opens already pointed at it. */
  | { readonly kind: "openImporter"; readonly track?: { readonly trackId: number; readonly configId: string } }
  /** An empty hand-authored set for a mapped track, opened in the editor. */
  | { readonly kind: "newNoteSet"; readonly trackId: number; readonly configId: string };

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
  /** Null means the repo's `data/` folder. The Spa fixture is `data/demo`. */
  readonly dataDir: string | null;
  readonly voiceId: string;
  /** The sim's car slug. Null means "the only reference lap recorded for this
   *  track", or the car being driven once the sim reports one. */
  readonly carId: string | null;
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
  /**
   * Which installed voice to render with — an id in the voices folder, not a
   * path. Null means "the first one installed", so a fresh setup that has
   * downloaded exactly one voice needs no choice made at all.
   */
  readonly renderVoiceId: string | null;
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
  /**
   * Hide the overlays and mute the callouts while a live iRacing session is
   * running but the sim is not the window in front — alt-tab to a browser and
   * they go with the sim instead of floating always-on-top over it and talking.
   * Windows only; elsewhere there is no sim window to be in front, and this
   * does nothing. Test mode is never affected.
   */
  readonly hideOverlaysWhenSimUnfocused: boolean;
  /**
   * A random id for this copy of the app, made on first run. Counts a download
   * once per installation (M8), signed in or not. Not tied to a person and
   * never sent anywhere except with a download.
   */
  readonly installationId: string | null;
  readonly debug: DebugSettings;
}

export interface DebugSettings {
  /**
   * Replay this recording instead of connecting to the sim.
   *
   * A path **inside the recordings folder** — `<trackId>/<carId>/<stamp>.ndjson`,
   * exactly as the recorder wrote it — so the preferences picker can list the
   * folder and select from it, and so a setting stays valid when the data folder
   * moves. An absolute path is still honoured and used as-is, which is what
   * `EXXEED_REPLAY` and the replay harness pass.
   */
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
  panels: [...DEFAULT_PANELS],
  piperBinary: null,
  renderVoiceId: null,
  autoStart: true,
  noteSetByTrack: {},
  runAtLogin: false,
  startMinimized: false,
  hideOverlaysWhenSimUnfocused: true,
  installationId: null,
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
    carId: typeof s.carId === "string" && s.carId !== "" ? s.carId : DEFAULT_SETTINGS.carId,
    leadAdjustS: number(s.leadAdjustS, DEFAULT_SETTINGS.leadAdjustS),
    // An empty list would open no windows at all, with no way back from inside
    // the app. Treat it as "not set".
    panels: panels.length === 0 ? DEFAULT_SETTINGS.panels : panels,
    piperBinary: s.piperBinary ?? DEFAULT_SETTINGS.piperBinary,
    renderVoiceId: s.renderVoiceId ?? DEFAULT_SETTINGS.renderVoiceId,
    autoStart:
      typeof s.autoStart === "boolean" ? s.autoStart : DEFAULT_SETTINGS.autoStart,
    runAtLogin:
      typeof s.runAtLogin === "boolean" ? s.runAtLogin : DEFAULT_SETTINGS.runAtLogin,
    startMinimized:
      typeof s.startMinimized === "boolean"
        ? s.startMinimized
        : DEFAULT_SETTINGS.startMinimized,
    hideOverlaysWhenSimUnfocused:
      typeof s.hideOverlaysWhenSimUnfocused === "boolean"
        ? s.hideOverlaysWhenSimUnfocused
        : DEFAULT_SETTINGS.hideOverlaysWhenSimUnfocused,
    installationId:
      typeof s.installationId === "string" && s.installationId !== ""
        ? s.installationId
        : DEFAULT_SETTINGS.installationId,
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
    carId: get("EXXEED_CAR") ?? settings.carId,
    leadAdjustS: num("EXXEED_LEAD_ADJUST") ?? settings.leadAdjustS,
    panels: panels.length === 0 ? settings.panels : panels,
    piperBinary: get("EXXEED_PIPER") ?? settings.piperBinary,
    renderVoiceId: get("EXXEED_VOICE_MODEL") ?? settings.renderVoiceId,
    autoStart: get("EXXEED_AUTOSTART") !== undefined || settings.autoStart,
    noteSetByTrack: settings.noteSetByTrack,
    runAtLogin: settings.runAtLogin,
    startMinimized: settings.startMinimized,
    hideOverlaysWhenSimUnfocused: settings.hideOverlaysWhenSimUnfocused,
    installationId: settings.installationId,
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
  readonly cars: readonly string[];
  /** What is in the recordings folder, newest first. Debug builds only. */
  readonly recordings: readonly { readonly path: string; readonly label: string }[];
  /** Shown so someone knows where to drop a file to have it picked up. */
  readonly recordingsDir: string;
  /**
   * Authoring only — the runtime plays rendered WAVs and needs none of it.
   * Distinct from `voices` above, which is the rendered packs available to play.
   */
  readonly rendering: VoiceSetup;
  /** True when the app was started with the debug flag. */
  readonly debugEnabled: boolean;
  readonly dataDir: string;
}

export interface SettingsPayload {
  readonly settings: Settings;
  readonly options: SettingsOptions;
}

/**
 * Renderer → main, invoke: check a file will replay and copy it into the
 * recordings folder. Returns `RecordingImportView`.
 */
export const RECORDING_IMPORT_CHANNEL = "exxeed:recording-import";

/**
 * Renderer → main, invoke: show the recordings folder in the file manager.
 *
 * The import button checks a file; this is for the case where someone has ten of
 * them, or already knows the file is good, and dragging them in is simply faster
 * than ten dialogs. The folder is listed either way — nothing about a recording
 * being picked up depends on how it got there.
 */
export const RECORDING_REVEAL_CHANNEL = "exxeed:recording-reveal";

/** Renderer → main, invoke: fetch a catalogue voice. Returns `InstallView`. */
export const VOICE_DOWNLOAD_CHANNEL = "exxeed:voice-download";
/** Renderer → main, invoke: install the standalone Piper. Returns `InstallView`. */
export const PIPER_INSTALL_CHANNEL = "exxeed:piper-install";
/** Main → preferences: how a download is going. Voices are tens of megabytes. */
export const INSTALL_PROGRESS_CHANNEL = "exxeed:install-progress";

export interface InstallView {
  readonly ok: boolean;
  readonly message: string;
}

export interface InstallProgress {
  readonly id: string;
  readonly received: number;
  readonly total: number;
}

/** A voice offered for download, and whether it is already here. */
export interface VoiceOption {
  readonly id: string;
  readonly label: string;
  readonly licence: string;
  readonly attribution: string | null;
  readonly bytes: number;
  readonly installed: boolean;
}

/** Where rendering stands: what is installed and what is missing. */
export interface VoiceSetup {
  readonly installed: readonly { readonly id: string; readonly licence: string | null }[];
  readonly catalogue: readonly VoiceOption[];
  /** Null when Piper was not found anywhere. */
  readonly piperFrom: "setting" | "bundled" | "path" | "venv" | null;
  /** Null when Piper is present, or when this platform can install it itself. */
  readonly piperHint: string | null;
  /** False on macOS, where no standalone build works. */
  readonly piperInstallable: boolean;
  readonly voicesDir: string;
}

export interface RecordingImportView {
  readonly ok: boolean;
  /** What happened, in a sentence the preferences window can show as-is. */
  readonly message: string;
  /** The imported recording's path inside the folder, when it worked. */
  readonly path: string | null;
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

/**
 * What the editor sends back. Only the fields it can change.
 *
 * A patch for an id the set does not have is a new note — the editor mints the
 * id, since it is an opaque handle (note-id.ts) and nothing is gained by a round
 * trip to ask for one. `deleted` removes the note.
 */
export interface EditorNotePatch {
  readonly id: string;
  readonly pct: number;
  readonly text: string;
  readonly textShort: string;
  readonly leadAdjustS: number;
  readonly deleted?: boolean;
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

/**
 * One overlay profile — a named, switchable arrangement of which panels are open
 * and where they sit.
 *
 * Positions are not part of this view: the control window only ever creates,
 * renames, deletes, activates or edits a profile by id, and never needs to know
 * where a panel currently sits to do any of that. Main keeps the positions.
 */
export interface OverlayProfile {
  readonly id: string;
  readonly name: string;
  readonly panels: readonly PanelId[];
}

/** What the Overlays section of the control window draws. */
export interface OverlayProfilesView {
  readonly profiles: readonly OverlayProfile[];
  readonly activeProfileId: string;
  /** The active profile's overlays are grabbable and shown for arranging. */
  readonly editing: boolean;
  /** Whether the telemetry panel is offerable — a debugging instrument, not a
   *  shipping one (see `chosenPanels` in main.ts). */
  readonly debugEnabled: boolean;
  /** Settings.hideOverlaysWhenSimUnfocused, for the checkbox under the list. */
  readonly hideWhenSimUnfocused: boolean;
}

/**
 * Control window → main: create, rename, delete, switch, or edit a profile.
 *
 * `setActive` switches which profile's overlays are open without touching
 * whether they are grabbable. `edit` is the "Edit" button: switch to this
 * profile if it is not already active, and either way leave it grabbable and
 * visible so it can be dragged into place. `stopEditing` is "Done" — lock the
 * currently open profile and let it go back to following the session.
 */
export type OverlayProfileCommand =
  | { readonly kind: "create"; readonly name: string }
  | { readonly kind: "rename"; readonly id: string; readonly name: string }
  | { readonly kind: "delete"; readonly id: string }
  | { readonly kind: "setPanels"; readonly id: string; readonly panels: readonly PanelId[] }
  | { readonly kind: "setActive"; readonly id: string }
  | { readonly kind: "edit"; readonly id: string }
  | { readonly kind: "stopEditing" }
  | { readonly kind: "hideWhenSimUnfocused"; readonly value: boolean };

/** Main → control window: the profile list, active id, or editing state changed. */
export const OVERLAY_PROFILES_CHANGED_CHANNEL = "exxeed:overlay-profiles-changed";
/** Control window → main. */
export const OVERLAY_PROFILE_COMMAND_CHANNEL = "exxeed:overlay-profile-command";

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
  /**
   * Engine speed, clutch travel (0..1, 1 = pedal down) and force-feedback load
   * (0..1). Live sim only — they come off `TelemetrySource.dash()`, which a
   * replay does not have, and they are never recorded. Null when absent.
   */
  readonly rpm: number | null;
  readonly clutch: number | null;
  readonly ffb: number | null;
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
  readonly carId: string;
  /** 0..1. */
  readonly throttle: readonly number[];
  /** 0..1. */
  readonly brake: readonly number[];
  /** m/s. Converted to km/h in render code and nowhere else (§3). */
  readonly speedMps: readonly number[];
  /** The reference's gear at each pct, for "what gear here" beside your own. */
  readonly gear: readonly number[];
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
