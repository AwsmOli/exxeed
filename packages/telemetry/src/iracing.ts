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

import { metres, mps, pct, radians, seconds } from "@exxeed/core";

import { isTrkLoc, TRK_LOC, type TelemetryFrame, type TrkLoc } from "./frame.js";
import {
  slug,
  UnsupportedPlatformError,
  type SessionIdentity,
  type TelemetrySource,
} from "./source.js";

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
  // Absent in practice — see the note on TelemetryFrame.lat. Read anyway, so the
  // day a sim does populate them the centreline gets the better source for free.
  readonly Lat?: { value?: number[] | number };
  readonly Lon?: { value?: number[] | number };
  readonly VelocityX?: { value?: number[] | number };
  readonly VelocityY?: { value?: number[] | number };
  readonly YawNorth?: { value?: number[] | number };
  readonly LapDist?: { value?: number[] | number };
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
  getSessionData(): Promise<IRacingSessionData | null>;
  readonly sessionStatusOK: boolean;
}

/** Only the corner of the session YAML this adapter reads — track and car. */
interface IRacingSessionData {
  readonly WeekendInfo?: {
    readonly TrackName?: string;
    readonly TrackDisplayName?: string;
    readonly TrackConfigName?: string;
    /** iRacing's own id, unique per track AND layout. This is §4.0's trackId. */
    readonly TrackID?: number;
  };
  readonly DriverInfo?: {
    readonly DriverCarIdx?: number;
    readonly Drivers?: readonly {
      readonly CarIdx?: number;
      readonly CarPath?: string;
      readonly CarScreenName?: string;
    }[];
  };
}

const first = <T>(v: T[] | T | undefined, fallback: T): T => {
  if (v === undefined) return fallback;
  return Array.isArray(v) ? (v[0] ?? fallback) : v;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How many polls connect() gives the sim to produce session data before deciding
 * it is not there. At 60 Hz this is about a second and a half — long enough to
 * ride out the gap while a session loads, short enough that a supervisor polling
 * for the sim stays responsive.
 */
const READY_ATTEMPTS = 90;

export class IRacingAdapter implements TelemetrySource {
  readonly name = "iracing";
  readonly #intervalMs: number;
  #sdk: IRacingSdk | null = null;
  #connected = false;
  #startedAtMs = 0;
  #identity: SessionIdentity | null = null;

  constructor(options: IRacingOptions = {}) {
    this.#intervalMs = 1000 / (options.hz ?? 60);
  }

  get connected(): boolean {
    return this.#connected;
  }

  get identity(): SessionIdentity | null {
    return this.#identity;
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

    // startSDK() succeeding does NOT mean the sim is running. It maps the shared
    // memory and returns true whether or not anything is on the other end, so an
    // app that trusts it "connects" to nothing, reports no track, and records a
    // file of pure header. The session data is the real handshake: it only
    // appears once the sim has a session mapped.
    this.#identity = await readIdentity(sdk, this.#intervalMs, READY_ATTEMPTS);
    if (this.#identity === null) {
      sdk.stopSDK();
      throw new Error(
        "the iRacing SDK is there but no session is — the sim is not running, " +
          "or it is still at the menu",
      );
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
      // waitForData is what refreshes sessionStatusOK, and getTelemetry aborts the
      // whole process (not throws) when the session data is not yet mapped — so the
      // wait must come first and the status must gate the read.
      //
      // The timeout is 0 because waitForData blocks the calling thread, and in
      // Electron that thread also pumps Chromium's message loop: a blocking wait
      // here starves IPC to the renderer, so frames reach the recorder but never
      // reach the window. Poll with sleep instead and let the wait return at once.
      const hasData = this.#sdk.waitForData(0);
      if (hasData && this.#sdk.sessionStatusOK) {
        const telemetry = this.#sdk.getTelemetry();
        if (telemetry !== null) {
          yield toFrame(telemetry, Date.now() - this.#startedAtMs);
        }
      }
      await sleep(this.#intervalMs);
    }
  }
}

/**
 * Track and car from the session YAML, for the recording header (§9).
 *
 * Best-effort by design. The session data only appears once the sim has mapped
 * it, which is not necessarily the moment connect() is called, so this waits a
 * short while and then gives up. An unlabelled recording is a nuisance; a lap
 * that was never recorded because we insisted on a label is a lost lap.
 */
async function readIdentity(
  sdk: IRacingSdk,
  intervalMs: number,
  attempts = 20,
): Promise<SessionIdentity | null> {
  try {
    for (let i = 0; i < attempts; i++) {
      sdk.waitForData(0);
      if (sdk.sessionStatusOK) {
        const data = await sdk.getSessionData();
        const weekend = data?.WeekendInfo;
        const info = data?.DriverInfo;
        const me = info?.Drivers?.find((d) => d.CarIdx === info.DriverCarIdx);

        const trackName = weekend?.TrackName;
        if (trackName !== undefined && trackName !== "") {
          return {
            // §4.0's TrackKey, straight from the sim. configId is slugged so it
            // is stable and filesystem-safe; iRacing gives each layout its own
            // TrackID anyway, so the pair is doubly unambiguous.
            trackKey: {
              sim: "iracing",
              trackId: weekend?.TrackID ?? 0,
              configId: slug(weekend?.TrackConfigName ?? ""),
            },
            trackId: slug(trackName),
            trackName: weekend?.TrackDisplayName ?? trackName,
            trackConfig: weekend?.TrackConfigName ?? "",
            carId: slug(me?.CarPath ?? "unknown-car"),
            carName: me?.CarScreenName ?? "unknown car",
          };
        }
      }
      await sleep(intervalMs);
    }
  } catch {
    // Fall through — see the doc comment. Never let this stop a session.
  }
  return null;
}

function resolveSdk(mod: unknown): IRacingSdk {
  type Ctor = new () => IRacingSdk;
  const candidate = mod as { default?: { IRacingSDK?: Ctor }; IRacingSDK?: Ctor };
  const Sdk = candidate.IRacingSDK ?? candidate.default?.IRacingSDK;
  if (typeof Sdk !== "function") {
    throw new Error("irsdk-node did not expose IRacingSDK");
  }
  return new Sdk();
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
    velocityXMps: mps(first(t.VelocityX?.value, 0)),
    velocityYMps: mps(first(t.VelocityY?.value, 0)),
    yawNorthRad: radians(first(t.YawNorth?.value, 0)),
    lapDistM: metres(first(t.LapDist?.value, 0)),
    isOnTrack: first(t.IsOnTrack?.value, false),
    onPitRoad: first(t.OnPitRoad?.value, false),
    isInGarage: first(t.IsInGarage?.value, false),
    playerTrackSurface: trkLoc,
    playerCarTowTime: first(t.PlayerCarTowTime?.value, 0),
    enterExitReset: first(t.EnterExitReset?.value, 0),
  };
}
