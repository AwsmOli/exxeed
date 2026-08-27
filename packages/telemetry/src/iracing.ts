/**
 * IRacingAdapter — the live SDK path. SPEC.md §3, §6.4, and milestone M0b.
 *
 * ## Why the import is lazy
 *
 * `@irsdk-node/native` ships prebuilds for `win32-x64` and `win32-arm64` only —
 * there is no darwin or linux build. A top-level `import "irsdk-node"` would
 * therefore make this module, and everything that transitively imports it,
 * unloadable off Windows. That would take the schemas, the engine, the replay
 * harness and the entire test suite down with it.
 *
 * So the SDK is imported inside `connect()`, behind a platform guard. The whole
 * tree stays importable, typecheckable and testable anywhere; only actually
 * talking to the sim needs Windows. Callers that want to run elsewhere use
 * `ReplayAdapter` against a recording.
 *
 * ## Why the guard stays even though the package installs fine
 *
 * `@irsdk-node/native`'s install script prints "only usable on windows, a mocked
 * SDK will be used" and installs a mock. So importing it off Windows does NOT
 * throw — it quietly hands back fabricated telemetry. That is worse than a hard
 * failure: an app that appears to connect and streams plausible-looking garbage
 * is exactly how you end up debugging a track map that was never real. The guard
 * fails loudly instead, and points at ReplayAdapter.
 *
 * The upside of `irsdk-node` specifically is that its native addon is N-API built
 * with `prebuildify --napi --electron-compat`, so there is no `electron-rebuild`
 * step — the single biggest source of pain with Electron plus native modules.
 */

import { mps, pct, radians, seconds } from "@exxeed/core";

import { isTrkLoc, TRK_LOC, type TelemetryFrame, type TrkLoc } from "./frame.js";
import { UnsupportedPlatformError, type TelemetrySource } from "./source.js";

export const IRACING_SUPPORTED_PLATFORMS = ["win32"] as const;

export const isIRacingSupported = (): boolean =>
  (IRACING_SUPPORTED_PLATFORMS as readonly string[]).includes(process.platform);

export interface IRacingOptions {
  /** Telemetry poll rate. 60 Hz is the sim's own update rate. */
  readonly hz?: number;
}

/**
 * The subset of the SDK's telemetry map this adapter reads. Names are the SDK's,
 * verified against the header vendored in `@irsdk-node/native` (SPEC.md §6.4).
 */
interface IRacingTelemetry {
  readonly SessionTime?: { value?: number[] | number };
  readonly Lap?: { value?: number[] | number };
  readonly LapDistPct?: { value?: number[] | number };
  readonly Speed?: { value?: number[] | number };
  readonly Throttle?: { value?: number[] | number };
  readonly Brake?: { value?: number[] | number };
  readonly Gear?: { value?: number[] | number };
  readonly SteeringWheelAngle?: { value?: number[] | number };
  readonly Lat?: { value?: number[] | number };
  readonly Lon?: { value?: number[] | number };
  readonly IsOnTrack?: { value?: boolean[] | boolean };
  readonly OnPitRoad?: { value?: boolean[] | boolean };
  readonly IsInGarage?: { value?: boolean[] | boolean };
  readonly PlayerTrackSurface?: { value?: number[] | number };
  readonly PlayerCarTowTime?: { value?: number[] | number };
  readonly EnterExitReset?: { value?: number[] | number };
}

/** Minimal shape of the `irsdk-node` instance this adapter needs. Hand-written
 *  rather than `any`-cast at the call site, per SPEC.md §3. */
interface IRacingSdk {
  startSDK(): boolean;
  stopSDK(): void;
  waitForData(timeoutMs: number): boolean;
  getTelemetry(): IRacingTelemetry | null;
}

const first = <T>(v: T[] | T | undefined, fallback: T): T => {
  if (v === undefined) return fallback;
  return Array.isArray(v) ? (v[0] ?? fallback) : v;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class IRacingAdapter implements TelemetrySource {
  readonly name = "iracing";
  readonly #intervalMs: number;
  #sdk: IRacingSdk | null = null;
  #connected = false;
  #startedAtMs = 0;

  constructor(options: IRacingOptions = {}) {
    this.#intervalMs = 1000 / (options.hz ?? 60);
  }

  get connected(): boolean {
    return this.#connected;
  }

  async connect(): Promise<void> {
    if (!isIRacingSupported()) {
      throw new UnsupportedPlatformError(
        `iRacing telemetry requires Windows (@irsdk-node/native ships prebuilds for ` +
          `win32-x64 and win32-arm64 only); this is ${process.platform}. ` +
          `Use ReplayAdapter against a recording instead — see SPEC.md §9.`,
      );
    }

    // Imported here, not at module scope, so this file loads on any platform.
    const mod: unknown = await import("irsdk-node");
    const sdk = resolveSdk(mod);

    if (!sdk.startSDK()) {
      throw new Error("iRacing SDK did not start — is the sim running?");
    }

    this.#sdk = sdk;
    this.#connected = true;
    this.#startedAtMs = Date.now();
  }

  async close(): Promise<void> {
    this.#connected = false;
    this.#sdk?.stopSDK();
    this.#sdk = null;
    await Promise.resolve();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<TelemetryFrame> {
    if (this.#sdk === null) throw new Error("connect() before iterating");

    while (this.#connected) {
      const telemetry = this.#sdk.getTelemetry();
      if (telemetry !== null) {
        yield toFrame(telemetry, Date.now() - this.#startedAtMs);
      }
      await sleep(this.#intervalMs);
    }
  }
}

function resolveSdk(mod: unknown): IRacingSdk {
  const candidate =
    (mod as { default?: { getInstance?: () => unknown }; getInstance?: () => unknown });
  const factory = candidate.getInstance ?? candidate.default?.getInstance;
  if (typeof factory !== "function") {
    throw new Error("irsdk-node did not expose getInstance()");
  }
  return factory() as IRacingSdk;
}

/**
 * SDK values → a `TelemetryFrame`. This is the I/O boundary, so it is one of the
 * few places allowed to call the unit constructors (SPEC.md §3).
 */
export function toFrame(t: IRacingTelemetry, tMs: number): TelemetryFrame {
  const surface = first(t.PlayerTrackSurface?.value, TRK_LOC.NotInWorld as number);
  const trkLoc: TrkLoc = isTrkLoc(surface) ? surface : TRK_LOC.NotInWorld;

  return {
    tMs,
    sessionTimeS: seconds(first(t.SessionTime?.value, 0)),
    lap: first(t.Lap?.value, 0),
    // LapDistPct's unit string is "%" but the value is genuinely 0..1. Do not
    // divide by 100 (SPEC.md §3).
    lapDistPct: pct(first(t.LapDistPct?.value, 0)),
    speedMps: mps(first(t.Speed?.value, 0)),
    throttle: first(t.Throttle?.value, 0),
    brake: first(t.Brake?.value, 0),
    gear: first(t.Gear?.value, 0),
    steerRad: radians(first(t.SteeringWheelAngle?.value, 0)),
    lat: first(t.Lat?.value, 0),
    lon: first(t.Lon?.value, 0),
    isOnTrack: first(t.IsOnTrack?.value, false),
    onPitRoad: first(t.OnPitRoad?.value, false),
    isInGarage: first(t.IsInGarage?.value, false),
    playerTrackSurface: trkLoc,
    playerCarTowTime: first(t.PlayerCarTowTime?.value, 0),
    enterExitReset: first(t.EnterExitReset?.value, 0),
  };
}
