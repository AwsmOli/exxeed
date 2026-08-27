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

/** The track outline, main → renderer, once at session start. */
export const MAP_CHANNEL = "exxeed:map";

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
  /** Non-null when the engine is deliberately quiet. For the dev overlay (§7.3). */
  readonly suppressedBy: SuppressionReason | null;
  readonly queuedNoteIds: readonly string[];
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
  /** Centreline, x/y in 0..1, already aspect-corrected. Closed loop. */
  readonly x: readonly number[];
  readonly y: readonly number[];
  /** Where each note speaks, as an index into x/y. */
  readonly notes: readonly { readonly id: string; readonly index: number }[];
  /** Start/finish, as an index into x/y. */
  readonly startIndex: number;
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
