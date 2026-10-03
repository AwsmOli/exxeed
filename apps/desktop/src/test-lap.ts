/**
 * Test mode's car: a pack's own reference lap, driven round its own track.
 *
 * Test mode used to replay a built-in toy lap whatever pack was loaded. The
 * callouts, the map and the delta then had nothing to do with each other — a
 * 22-second lap against a two-minute reference reads as "45 seconds up" and
 * every delta colour is pinned at full. Driving the reference lap itself
 * makes everything agree: the car is on the pack's track, brakes where the
 * reference brakes, and the callouts fire where the editor shows them.
 *
 * The car does not drive the reference exactly, or the delta would sit at
 * zero. Its pace drifts a little faster and slower than the reference on two
 * slow waves, so the delta gains and loses at every rate from "holding" to
 * about two tenths a second, and stays within a second either way.
 */

import type { ReferenceLap } from "@exxeed/core";
import { metres, mps, pct, radians, seconds } from "@exxeed/core";
import type { SessionIdentity, TelemetryFrame, TelemetrySource } from "@exxeed/telemetry";
import { TRK_LOC } from "@exxeed/telemetry";

export interface TestLap {
  readonly reference: ReferenceLap;
  readonly lengthM: number;
  readonly identity: SessionIdentity;
}

const HZ = 60;
const DT_S = 1 / HZ;

/**
 * How much slower than the reference the car is going, as a share of its
 * speed, `t` seconds in: positive loses time, negative gains it. Two waves of
 * different lengths, so the rate wanders through every value in between and
 * does not repeat lap after lap.
 */
const paceLoss = (t: number): number =>
  0.13 * Math.sin((2 * Math.PI * t) / 31) + 0.07 * Math.sin((2 * Math.PI * t) / 9.7);

export class ReferenceLapSource implements TelemetrySource {
  readonly name = "test lap";
  readonly #load: () => Promise<TestLap | null>;
  readonly #fallback: () => TelemetrySource;
  #lap: TestLap | null = null;
  #other: TelemetrySource | null = null;
  #connected = false;

  /**
   * `load` finds a pack with a reference lap to drive. When there is none —
   * a fresh install with no packs — `fallback` supplies the source instead,
   * so test mode still shows something.
   */
  constructor(load: () => Promise<TestLap | null>, fallback: () => TelemetrySource) {
    this.#load = load;
    this.#fallback = fallback;
  }

  get connected(): boolean {
    return this.#other?.connected ?? this.#connected;
  }

  get identity(): SessionIdentity | null {
    return this.#other !== null ? this.#other.identity : (this.#lap?.identity ?? null);
  }

  async connect(): Promise<void> {
    this.#lap = await this.#load();
    if (this.#lap === null) {
      this.#other = this.#fallback();
      await this.#other.connect();
      return;
    }
    this.#connected = true;
  }

  async close(): Promise<void> {
    this.#connected = false;
    await this.#other?.close();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<TelemetryFrame> {
    if (this.#other !== null) {
      yield* this.#other;
      return;
    }
    const lap = this.#lap;
    if (lap === null) return;

    const { reference, lengthM } = lap;
    const grid = reference.gridSize;
    const at = (channel: readonly number[], p: number): number =>
      channel[Math.min(grid - 1, Math.floor(p * grid))] ?? 0;

    // Start a little before the line on lap 0, so the first full lap is timed
    // from the line like any other.
    let position = 0.97;
    let lapNumber = 0;
    let t = 0;
    const startedAt = Date.now();

    while (this.#connected) {
      const speed = Math.max(5, at(reference.channels.speedMps, position)) * (1 - paceLoss(t));

      yield {
        tMs: Math.round(t * 1000),
        sessionTimeS: seconds(t),
        lap: lapNumber,
        lapDistPct: pct(position),
        speedMps: mps(speed),
        throttle: at(reference.channels.throttle, position),
        brake: at(reference.channels.brake, position),
        gear: at(reference.channels.gear, position),
        steerRad: radians(at(reference.channels.steerRad, position)),
        lat: 0,
        lon: 0,
        velocityXMps: mps(speed),
        velocityYMps: mps(0),
        yawNorthRad: radians(0),
        lapDistM: metres(position * lengthM),
        isOnTrack: true,
        onPitRoad: false,
        isInGarage: false,
        playerTrackSurface: TRK_LOC.OnTrack,
        playerCarTowTime: 0,
        enterExitReset: 0,
      };

      position += (speed * DT_S) / lengthM;
      if (position >= 1) {
        position -= 1;
        lapNumber++;
      }
      t += DT_S;

      // Real time: sleep until this frame is due, however long the consumer took.
      const waitMs = startedAt + t * 1000 - Date.now();
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}
