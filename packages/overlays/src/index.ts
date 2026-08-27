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
