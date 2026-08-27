/**
 * @exxeed/overlays — renderer UI.
 *
 * Stub until M3. The Vue 3 app, the input-trace canvas (§7.1), the delta bar
 * (§7.2) and the dev callout overlay (§7.3) all land there.
 *
 * What lives here now is the IPC contract, because the main process needs it
 * today and it is the thing that keeps §7's hard rule true: timing-critical work
 * runs in main, never a renderer. Renderers get throttled when occluded or
 * backgrounded, which would silently destroy callout timing.
 */

import type { Mps, Pct, Seconds } from "@exxeed/core";

/** IPC channel carrying the 60 Hz state frame from main to renderers. */
export const STATE_FRAME_CHANNEL = "exxeed:state-frame";

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
  /** Seconds vs the reference lap at this pct index (§7.2). Null before a
   *  reference lap is loaded. */
  readonly deltaS: Seconds | null;
  readonly connected: boolean;
  readonly sourceName: string;
}

/**
 * Renderer-side reactivity rules for this frame — SPEC.md §7.0, restated here
 * because it is the file every renderer will import:
 *
 *  - Hold the frame in a `shallowRef` and REPLACE it wholesale. Deep reactivity
 *    on an object discarded 60 times a second is pure overhead.
 *  - `markRaw` the reference-lap channel arrays. 2000 elements that never change
 *    during a session; proxying them is a measurable waste on load.
 *  - Canvas components must not re-render on telemetry at all. Subscribe to this
 *    channel in `onMounted`, draw in a `requestAnimationFrame` loop, and let Vue
 *    own only mount/unmount. A Vue update cycle per frame is a bug, not an
 *    optimisation target.
 */
export const REACTIVITY_RULES = "SPEC.md §7.0" as const;
