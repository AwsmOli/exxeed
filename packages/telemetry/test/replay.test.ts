import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { deltaM, metres, pct } from "@exxeed/core";
import { parseFrame, ReplayAdapter, TRK_LOC } from "@exxeed/telemetry";

const FIXTURE = fileURLToPath(new URL("./fixtures/synthetic-3laps.ndjson", import.meta.url));

const collect = async (adapter: ReplayAdapter) => {
  await adapter.connect();
  const frames = [];
  for await (const frame of adapter) frames.push(frame);
  await adapter.close();
  return frames;
};

describe("ReplayAdapter", () => {
  it("replays every frame in order, flat out", async () => {
    const frames = await collect(new ReplayAdapter(FIXTURE, { speed: 0 }));

    expect(frames).toHaveLength(900);
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i]!.tMs).toBeGreaterThan(frames[i - 1]!.tMs);
    }
  });

  it("skips the meta header rather than emitting it as a frame", async () => {
    const frames = await collect(new ReplayAdapter(FIXTURE, { speed: 0 }));
    expect(frames.every((f) => Number.isFinite(f.lapDistPct))).toBe(true);
    expect(frames[0]?.lap).toBe(1);
  });

  it("covers three laps, wrapping through start/finish each time", async () => {
    const frames = await collect(new ReplayAdapter(FIXTURE, { speed: 0 }));

    expect(new Set(frames.map((f) => f.lap))).toEqual(new Set([1, 2, 3]));

    // Every lap resets lapDistPct to near zero, so consumers that subtract raw
    // percentages break here — which is the point of the fixture.
    const wraps = frames.filter(
      (f, i) => i > 0 && f.lapDistPct < frames[i - 1]!.lapDistPct,
    );
    expect(wraps).toHaveLength(2);

    // Measured properly the step across the wrap is one frame, not a whole lap.
    const wrap = wraps[0]!;
    const before = frames[frames.indexOf(wrap) - 1]!;
    expect(Math.abs(deltaM(wrap.lapDistPct, before.lapDistPct, metres(3700)))).toBeLessThan(30);
  });

  it("paces against the recording's own clock, not wall time", async () => {
    // 900 frames spanning 89.9 s of recording, replayed at 500x, should take
    // roughly 180 ms. Generous bounds — this asserts pacing happens at all, not
    // that setTimeout is precise.
    const started = Date.now();
    const frames = await collect(new ReplayAdapter(FIXTURE, { speed: 500 }));
    const elapsed = Date.now() - started;

    expect(frames).toHaveLength(900);
    expect(elapsed).toBeGreaterThan(50);
    expect(elapsed).toBeLessThan(3000);
  });

  it("stops mid-stream when closed", async () => {
    const adapter = new ReplayAdapter(FIXTURE, { speed: 0 });
    await adapter.connect();

    let seen = 0;
    for await (const _frame of adapter) {
      seen++;
      if (seen === 10) await adapter.close();
    }

    expect(seen).toBeLessThan(900);
    expect(adapter.connected).toBe(false);
  });
});

/** A complete, valid frame record. Tests below vary one field at a time. */
const validRecord = {
  tMs: 0,
  sessionTimeS: 0,
  lap: 1,
  lapDistPct: 0.99781,
  speedMps: 69,
  throttle: 0,
  brake: 0.8,
  gear: 3,
  steerRad: 0.1,
  lat: 50.4372,
  lon: 5.9714,
  isOnTrack: true,
  onPitRoad: false,
  isInGarage: false,
  playerTrackSurface: 3,
  playerCarTowTime: 0,
  enterExitReset: 0,
};

describe("parseFrame", () => {
  it("returns null for the meta header", () => {
    expect(parseFrame(JSON.stringify({ kind: "meta", source: "synthetic" }))).toBeNull();
  });

  it("brands units at the boundary and preserves lapDistPct as 0..1", () => {
    const frame = parseFrame(JSON.stringify(validRecord));

    expect(frame).not.toBeNull();
    // Not 99.781 — the SDK's "%" unit string is a lie (SPEC.md §3).
    expect(frame!.lapDistPct).toBeCloseTo(0.99781, 6);
    expect(frame!.playerTrackSurface).toBe(TRK_LOC.OnTrack);

    // 0.99781 is 29.3 m BEFORE 0.002 across start/finish, not 6976 m after it.
    expect(deltaM(frame!.lapDistPct, pct(0.002), metres(7004))).toBeCloseTo(-29.35, 2);
  });

  it("throws on a malformed numeric field rather than yielding NaN downstream", () => {
    expect(() => parseFrame(JSON.stringify({ ...validRecord, tMs: "soon" }))).toThrow(/tMs/);
    expect(() => parseFrame(JSON.stringify({ ...validRecord, speedMps: null }))).toThrow(
      /speedMps/,
    );
    expect(() => parseFrame(JSON.stringify({ ...validRecord, lapDistPct: "0.5" }))).toThrow(
      /lapDistPct/,
    );
  });

  it("falls back to NotInWorld for an unknown track surface value", () => {
    const line = JSON.stringify({ ...validRecord, playerTrackSurface: 99 });
    expect(parseFrame(line)?.playerTrackSurface).toBe(TRK_LOC.NotInWorld);
  });
});

describe("looping is one continuous session", () => {
  const collectLooped = async (limit: number) => {
    const adapter = new ReplayAdapter(FIXTURE, { speed: 0, loop: true });
    await adapter.connect();
    const frames = [];
    for await (const frame of adapter) {
      frames.push(frame);
      if (frames.length >= limit) break;
    }
    await adapter.close();
    return frames;
  };

  it("never rewinds the clock across a pass boundary", async () => {
    // Reaching the end of a file and starting again is an artefact of replay,
    // not something that happened to the car. Rewinding tMs made the scheduler
    // hold a stale busy-until into the next pass.
    const frames = await collectLooped(2000);

    for (let i = 1; i < frames.length; i++) {
      expect(frames[i]!.tMs).toBeGreaterThan(frames[i - 1]!.tMs);
    }
  });

  it("keeps counting laps, so the out-lap gate can lift", async () => {
    // §6.4 stays quiet until one lap has completed. A recording whose lap number
    // resets every pass can never satisfy that, and the engine looks broken while
    // behaving exactly as specified.
    const frames = await collectLooped(2000);
    const laps = [...new Set(frames.map((f) => f.lap))].sort((a, b) => a - b);

    expect(laps.length).toBeGreaterThan(1);
    // Consecutive, no gaps and no repeats of an earlier lap.
    expect(laps).toEqual(laps.map((_, i) => laps[0]! + i));
  });

  it("does not offset anything on a single pass", async () => {
    const adapter = new ReplayAdapter(FIXTURE, { speed: 0 });
    await adapter.connect();
    const frames = [];
    for await (const frame of adapter) frames.push(frame);
    await adapter.close();

    expect(frames[0]!.tMs).toBe(0);
    expect(frames.every((f) => f.lap >= 1 && f.lap <= 3)).toBe(true);
  });
});
