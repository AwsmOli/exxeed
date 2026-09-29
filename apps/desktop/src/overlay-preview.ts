/**
 * A synthetic lap, fed to whichever overlays are open while arranging them.
 *
 * Blank panels tell someone nothing about what they are dragging into place —
 * the delta bar has no bar, the trace has no ghost, the callout log has no
 * lines. This fabricates a plausible lap (a track shape, a speed/throttle/
 * brake profile, a handful of notes) and drives the same channels a real
 * session does, so a profile can be arranged with something to look at
 * without needing the sim open or a note set loaded.
 *
 * Not a real session: nothing here touches the note engine, the recorder, or
 * `sessionStatus`. It exists purely so the overlays are not blank, and it
 * stops the moment editing ends or a real session starts (see `main.ts`).
 */

import {
  ENGINE_EVENT_CHANNEL,
  MAP_CHANNEL,
  RACE_CHANNEL,
  REFERENCE_CHANNEL,
  STATE_FRAME_CHANNEL,
  type EngineEventView,
  type ReferenceView,
  type StateFrame,
  type TrackMapView,
} from "@exxeed/overlays";
import { mps, pct, radians, seconds } from "@exxeed/core";
import { SPOTTER, type RaceSnapshot, type TyreCorner } from "@exxeed/telemetry";

import { RaceViewBuilder } from "./race-view.js";

/** Fake corners, as fractions of the lap — enough to give the trace something
 *  to shade and the map something to mark. */
const CORNERS = [0.12, 0.35, 0.58, 0.82];
const GRID_SIZE = 400;
const LAP_LENGTH_M = 3200;
const LAP_DURATION_S = 22;
const TICK_MS = 50;

/** A rounded loop, not a circle — a circle reads as "not a track" at a glance. */
function buildShape(): { x: number[]; y: number[] } {
  const x: number[] = [];
  const y: number[] = [];
  for (let i = 0; i < GRID_SIZE; i++) {
    const t = i / GRID_SIZE;
    const a = t * Math.PI * 2;
    // A superellipse-ish blend: squarer than a circle, still closed and smooth.
    const rx = 0.42;
    const ry = 0.34;
    const bulge = 1 + 0.12 * Math.sin(a * 2);
    x.push(0.5 + rx * Math.cos(a) * bulge);
    y.push(0.5 + ry * Math.sin(a));
  }
  return { x, y };
}

/** Brake into each corner, apex, then back to throttle — the shape every other
 *  panel (trace, delta) samples from. */
function buildProfile(): { throttle: number[]; brake: number[]; speedMps: number[] } {
  const throttle: number[] = [];
  const brake: number[] = [];
  const speedMps: number[] = [];

  for (let i = 0; i < GRID_SIZE; i++) {
    const p = i / GRID_SIZE;
    const nearest = Math.min(...CORNERS.map((c) => Math.min(Math.abs(p - c), 1 - Math.abs(p - c))));
    const braking = nearest < 0.05;
    const slow = nearest < 0.02;

    throttle.push(braking ? 0.1 : Math.min(1, 0.4 + nearest * 6));
    brake.push(braking && !slow ? 0.8 : slow ? 0.3 : 0);
    speedMps.push(slow ? 28 : braking ? 42 : 62);
  }
  return { throttle, brake, speedMps };
}

/** A plausible gear for a speed, for the sample lap and its reference. */
const gearFor = (speedMps: number): number => Math.max(2, Math.min(6, Math.ceil((speedMps * 3.6) / 45)));

function buildElapsed(speedMps: readonly number[]): number[] {
  const elapsed: number[] = [];
  let t = 0;
  const stepM = LAP_LENGTH_M / GRID_SIZE;
  for (let i = 0; i < GRID_SIZE; i++) {
    elapsed.push(t);
    t += stepM / Math.max(1, speedMps[i] ?? 40);
  }
  return elapsed;
}

const shape = buildShape();
const profile = buildProfile();
const elapsedS = buildElapsed(profile.speedMps);
const NOTE_IDS = CORNERS.map((_, i) => `preview-${i + 1}`);

function sample(channel: readonly number[], p: number): number {
  const i = Math.min(GRID_SIZE - 1, Math.floor(((p % 1) + 1) % 1 * GRID_SIZE));
  return channel[i] ?? 0;
}

const mapView: TrackMapView = {
  trackName: "Arranging overlays",
  configName: "sample lap",
  lengthM: LAP_LENGTH_M,
  x: shape.x,
  y: shape.y,
  notes: CORNERS.map((c, i) => ({
    id: NOTE_IDS[i]!,
    index: Math.round(c * GRID_SIZE),
  })),
  startIndex: 0,
};

const referenceView: ReferenceView = {
  gridSize: GRID_SIZE,
  lapTimeS: elapsedS[GRID_SIZE - 1] ?? LAP_DURATION_S,
  carId: "preview",
  throttle: profile.throttle,
  brake: profile.brake,
  speedMps: profile.speedMps,
  gear: profile.speedMps.map(gearFor),
  elapsedS,
  // `index` is the corner NUMBER, 1-based, as a real ReferenceView carries it
  // — the maps and Corner Analysis print it.
  corners: CORNERS.map((c, i) => ({
    index: i + 1,
    entryPct: c - 0.03,
    apexPct: c,
    exitPct: (c + 0.04) % 1,
  })),
  brakeOnsetPcts: CORNERS.map((c) => c - 0.05),
};

/**
 * A made-up field, so the race panels have rows to arrange around. Invented
 * names on purpose — a preview is not the place to put real drivers' names.
 */
const FIELD = [
  { name: "You", number: "7", classId: 1, ir: 2850, lic: "A 3.12", offset: 0, pace: 1 },
  { name: "Mara Voss", number: "12", classId: 1, ir: 3410, lic: "A 4.20", offset: 0, pace: 1 },
  { name: "Theo Lindqvist", number: "3", classId: 1, ir: 3120, lic: "A 2.88", offset: 0.06, pace: 1.002 },
  { name: "Ines Carrow", number: "44", classId: 1, ir: 2610, lic: "B 3.90", offset: -0.05, pace: 0.998 },
  { name: "Dario Pell", number: "21", classId: 1, ir: 2470, lic: "B 2.41", offset: -0.11, pace: 0.997 },
  { name: "Juno Hart", number: "88", classId: 1, ir: 1980, lic: "C 3.05", offset: 0.14, pace: 1.001 },
  { name: "Seb Okafor", number: "5", classId: 2, ir: 4120, lic: "A 4.99", offset: 0.3, pace: 1.09 },
  { name: "Rhea Nakamura", number: "9", classId: 2, ir: 3890, lic: "A 4.51", offset: 0.24, pace: 1.088 },
  { name: "Luca Brandt", number: "31", classId: 2, ir: 3300, lic: "A 3.77", offset: 0.5, pace: 1.085 },
  { name: "Noor Aziz", number: "63", classId: 2, ir: 2950, lic: "B 4.02", offset: 0.62, pace: 1.083 },
];

const CLASSES = {
  1: { name: "GT3", color: "#4de95f", estLapS: LAP_DURATION_S },
  2: { name: "GTP", color: "#00ffdc", estLapS: LAP_DURATION_S / 1.09 },
} as const;

const tyreCorner = (base: number, wear: number): TyreCorner => ({
  tempC: [base - 3, base, base + 2],
  wear: [wear, wear - 0.02, wear - 0.01],
  coldPressureKpa: 172,
});

function previewSnapshot(elapsedS: number): RaceSnapshot {
  // Car #12 swings from a few lengths ahead to a few behind and back, so it
  // spends part of every cycle alongside.
  const distance = FIELD.map(
    (f, i) =>
      (elapsedS / LAP_DURATION_S) * f.pace + f.offset + 3 + (i === 1 ? 0.004 * Math.sin(elapsedS / 5) : 0),
  );
  const leader = Math.max(...distance);
  const playerLaps = distance[0]!;

  return {
    sessionType: "Race",
    rubber: "moderate usage",
    shiftLights: { firstRpm: 5200, shiftRpm: 7300, lastRpm: 7500, blinkRpm: 7700 },
    sessionTimeRemainS: Math.max(0, 1800 - elapsedS),
    sessionLapsRemain: null,
    sessionLapsTotal: null,
    playerCarIdx: 0,
    drivers: FIELD.map((f, i) => {
      const cls = CLASSES[f.classId as 1 | 2];
      return {
        carIdx: i,
        name: f.name,
        shortName: i === 0 ? "You" : `${f.name.charAt(0)}. ${f.name.split(" ").slice(1).join(" ")}`,
        carNumber: f.number,
        carName: cls.name,
        iRating: f.ir,
        license: f.lic,
        licenseColor: f.lic.startsWith("A") ? "#0153db" : f.lic.startsWith("B") ? "#00c702" : "#feec04",
        classId: f.classId,
        className: cls.name,
        classColor: cls.color,
        classEstLapS: cls.estLapS,
      };
    }),
    cars: FIELD.map((f, i) => {
      const d = distance[i]!;
      const cls = CLASSES[f.classId as 1 | 2];
      const inClass = FIELD.map((g, j) => ({ g, d: distance[j]! })).filter((x) => x.g.classId === f.classId);
      const classPos = inClass.filter((x) => x.d > d).length + 1;
      return {
        carIdx: i,
        position: distance.filter((x) => x > d).length + 1,
        classPosition: classPos,
        lap: Math.floor(d),
        lapDistPct: d % 1,
        lastLapS: cls.estLapS * (1 + 0.004 * Math.sin(i)),
        bestLapS: cls.estLapS * (1 - 0.003 * ((i % 3) + 1)),
        onPitRoad: false,
        estTimeS: (d % 1) * cls.estLapS,
        gapToLeaderS: (leader - d) * cls.estLapS,
        inWorld: true,
      };
    }),
    trackLengthM: LAP_LENGTH_M,
    sectorStartPcts: [0, 0.34, 0.67],
    fuel: {
      levelL: Math.max(4, 62 - playerLaps * 2.4),
      levelPct: Math.max(4, 62 - playerLaps * 2.4) / 100,
      useLph: 2.4 * (3600 / LAP_DURATION_S),
      tankL: 100,
    },
    tyres: {
      lf: tyreCorner(88, 0.94),
      rf: tyreCorner(92, 0.91),
      lr: tyreCorner(81, 0.95),
      rr: tyreCorner(84, 0.93),
    },
    weather: {
      airC: 21,
      trackC: 31,
      humidity: 0.46,
      precipitation: 0,
      windMps: 3.4,
      windDirRad: 3.9,
      wetness: 1,
      skies: 1,
      declaredWet: false,
    },
    // Car #12 runs alongside for part of every lap, so the radar has
    // something to light up.
    spotter:
      Math.abs(((distance[1]! - distance[0]!) % 1) * LAP_LENGTH_M) < 5
        ? SPOTTER.left
        : SPOTTER.clear,
    brakeBiasPct: 54.5,
    incidents: 2,
    repairS: 0,
    optionalRepairS: 0,
    playerLastLapS: LAP_DURATION_S * 1.003,
    playerBestLapS: LAP_DURATION_S * 0.997,
  };
}

export interface OverlayPreview {
  stop(): void;
}

/**
 * Start sending the synthetic lap to `send` (a broadcast to every open
 * overlay window) and return a handle to stop it.
 */
export function startOverlayPreview(send: (channel: string, payload: unknown) => void): OverlayPreview {
  send(MAP_CHANNEL, mapView);
  send(REFERENCE_CHANNEL, referenceView);

  let lap = 0;
  let firedThisLap = new Set<string>();
  const startedAt = Date.now();
  const race = new RaceViewBuilder();
  let raceSentAt = -Infinity;

  const timer = setInterval(() => {
    const elapsedMs = Date.now() - startedAt;
    const lapPct = (elapsedMs / 1000 / LAP_DURATION_S) % 1;
    const newLap = Math.floor(elapsedMs / 1000 / LAP_DURATION_S);
    if (newLap !== lap) {
      lap = newLap;
      firedThisLap = new Set();
    }

    const throttle = sample(profile.throttle, lapPct);
    const brake = sample(profile.brake, lapPct);
    const speed = sample(profile.speedMps, lapPct);

    const frame: StateFrame = {
      tMs: elapsedMs,
      lap,
      lapDistPct: pct(lapPct),
      speedMps: mps(speed),
      throttle,
      brake,
      gear: gearFor(speed),
      // A little steering into each corner, so the wheel dial moves.
      steerRad: radians(-Math.min(1, brake * 1.4) * 0.9 * Math.sign(Math.sin(lapPct * 40) || 1)),
      lat: 0,
      lon: 0,
      // Revs climbing through each gear, so the shift lights run.
      rpm: 4800 + ((speed * 3.6) % 45) / 45 * 3000,
      clutch: 0,
      ffb: 0.35 + brake * 0.4,
      lapElapsedS: seconds(lapPct * LAP_DURATION_S),
      // A gentle side-to-side wander — enough to show the bar move both ways
      // without ever reading as a real, consistent pace difference.
      deltaS: seconds(0.4 * Math.sin(elapsedMs / 4000)),
      connected: true,
      sourceName: "preview lap — arranging overlays",
      suppressedBy: null,
      queuedNoteIds: NOTE_IDS,
      armedNoteIds: NOTE_IDS,
    };
    send(STATE_FRAME_CHANNEL, frame);

    // Through the real builder, so what the preview shows is what a session
    // would — and so the builder gets exercised on every arrange.
    if (elapsedMs - raceSentAt >= 200) {
      raceSentAt = elapsedMs;
      send(RACE_CHANNEL, race.build(previewSnapshot(elapsedMs / 1000)));
    }

    for (let i = 0; i < CORNERS.length; i++) {
      const c = CORNERS[i]!;
      const id = NOTE_IDS[i]!;
      if (firedThisLap.has(id)) continue;
      if (lapPct < c && lapPct + 0.01 >= c) {
        firedThisLap.add(id);
        const event: EngineEventView = {
          kind: "play",
          noteId: id,
          detail: "full",
          leadM: 60,
          dAheadM: 0,
          atPct: c,
        };
        send(ENGINE_EVENT_CHANNEL, event);
      }
    }
  }, TICK_MS);

  return {
    stop(): void {
      clearInterval(timer);
      // The made-up field must not outlive the arranging — a real session with
      // no race data (a replay) would otherwise go on showing it.
      send(RACE_CHANNEL, null);
    },
  };
}
