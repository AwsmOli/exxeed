/**
 * Generates `synthetic-3laps.ndjson` — a toy recording for the replay tests.
 *
 * Not a real lap and not pretending to be one: three laps of a constant-radius
 * loop with a single braking zone, enough to exercise ordering, the virtual
 * clock, and the start/finish wrap. The real M1 fixture is a recorded Daytona Road lap
 * and has to wait for a Windows machine (TODO.md, M0b).
 *
 * Run with:  pnpm --filter @exxeed/telemetry exec tsx test/fixtures/generate.ts
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HZ = 10; // 60 Hz would make the fixture 6x larger for no extra coverage
const LAPS = 3;
const LAP_TIME_S = 30;
const FRAMES_PER_LAP = HZ * LAP_TIME_S;

/** Braking zone runs from 0.97 through the S/F line to 0.02 — deliberately
 *  wrapping, so replay consumers meet the §4.6 problem straight away. */
const inBrakingZone = (p: number): boolean => p > 0.97 || p < 0.02;

const lines: string[] = [
  JSON.stringify({
    kind: "meta",
    startedAt: "2026-08-27T00:00:00.000Z",
    source: "synthetic",
    note: "Toy 3-lap loop for replay tests. Not real telemetry.",
    hz: HZ,
    laps: LAPS,
  }),
];

for (let lap = 1; lap <= LAPS; lap++) {
  for (let i = 0; i < FRAMES_PER_LAP; i++) {
    const lapDistPct = i / FRAMES_PER_LAP;
    const braking = inBrakingZone(lapDistPct);
    const angle = 2 * Math.PI * lapDistPct;

    lines.push(
      JSON.stringify({
        tMs: Math.round(((lap - 1) * FRAMES_PER_LAP + i) * (1000 / HZ)),
        sessionTimeS: Number((((lap - 1) * FRAMES_PER_LAP + i) / HZ).toFixed(3)),
        lap,
        lapDistPct: Number(lapDistPct.toFixed(6)),
        speedMps: Number((braking ? 30 : 60).toFixed(3)),
        throttle: braking ? 0 : 1,
        brake: braking ? 0.8 : 0,
        gear: braking ? 3 : 6,
        steerRad: Number((0.35 * Math.sin(angle)).toFixed(6)),
        lat: Number((50.4372 + 0.01 * Math.sin(angle)).toFixed(7)),
        lon: Number((5.9714 + 0.01 * Math.cos(angle)).toFixed(7)),
        isOnTrack: true,
        onPitRoad: false,
        isInGarage: false,
        playerTrackSurface: 3,
        playerCarTowTime: 0,
        enterExitReset: 0,
      }),
    );
  }
}

const out = fileURLToPath(new URL("./synthetic-3laps.ndjson", import.meta.url));
writeFileSync(out, `${lines.join("\n")}\n`, "utf8");
process.stdout.write(`wrote ${lines.length - 1} frames to ${out}\n`);
