/**
 * Spa-Francorchamps fixtures, cut down to turn 1.
 *
 * Deliberately the hard case: La Source's braking landmark sits at pct 0.99781,
 * behind the start/finish line, so anything that touches these fixtures exercises
 * the wraparound (SPEC.md §4.2, §6.2).
 */

import type { LandmarkInventory, NoteSet, TrackMap } from "@exxeed/core";

export const SPA_LENGTH_M = 7004;

const flatCentreline = (gridSize: number) => ({
  gridSize,
  x: Array.from({ length: gridSize }, (_, i) => Math.cos((2 * Math.PI * i) / gridSize) * 1114),
  y: Array.from({ length: gridSize }, (_, i) => Math.sin((2 * Math.PI * i) / gridSize) * 1114),
});

export const spaMap: TrackMap = {
  schema: 1,
  trackRef: { sim: "iracing", trackId: 266, configId: "grand_prix", mapVersion: 3 },
  trackName: "Circuit de Spa-Francorchamps",
  configName: "Grand Prix",
  lengthM: SPA_LENGTH_M,
  generatedFrom: {
    source: "telemetry",
    baselineCarId: 173,
    lapHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  },
  corners: [
    {
      index: 1,
      names: ["La Source"],
      entryPct: 0.0121,
      apexPct: 0.018,
      exitPct: 0.0242,
      direction: "right",
      severity: 5,
    },
    {
      index: 2,
      names: ["Eau Rouge", "Raidillon"],
      entryPct: 0.0602,
      apexPct: 0.0668,
      exitPct: 0.0741,
      direction: "left",
      severity: 3,
    },
  ],
  centreline: flatCentreline(2000),
};

export const spaLandmarks: LandmarkInventory = {
  trackRef: spaMap.trackRef,
  landmarks: [
    {
      id: "t1_board_100",
      cornerIndex: 1,
      type: "distance_board",
      label: "hundred board",
      // 100 m before entry at 84.7 m into the lap — i.e. behind start/finish.
      pct: 0.99781,
      confidence: 0.9,
      verified: true,
    },
    {
      id: "t1_kerb_in",
      cornerIndex: 1,
      type: "kerb",
      label: "inside kerb",
      pct: 0.0175,
      confidence: 0.7,
      verified: false,
    },
  ],
};

const audio = (file: string, durationMs: number) => ({ file, durationMs });

export const spaGt3Notes: NoteSet = {
  id: "spa-gt3-fixture",
  trackRef: spaMap.trackRef,
  carClass: "gt3",
  source: { type: "manual", title: "Fixture", channel: "—" },
  status: "draft",
  createdAt: "2026-08-27T00:00:00Z",
  notes: [
    {
      id: "t1_brake",
      cornerIndex: 1,
      phase: "brake",
      text: "Brake at the hundred board",
      textShort: "Hundred board",
      anchor: { type: "landmark", id: "t1_board_100", offsetM: 0 },
      priority: 1,
      leadAdjustS: -0.2,
      confidence: 0.86,
      sourceTs: "01:23",
      fadeable: true,
      audio: audio("gt3/en_amy/t1_brake.wav", 1240),
      audioShort: audio("gt3/en_amy/t1_brake_short.wav", 720),
      dirty: false,
    },
    {
      id: "t1_throttle",
      cornerIndex: 1,
      phase: "throttle",
      text: "Kerb — throttle",
      textShort: "Throttle",
      anchor: { type: "corner", cornerIndex: 1, offsetM: 0 },
      priority: 2,
      leadAdjustS: 0,
      confidence: 0.74,
      fadeable: true,
      audio: audio("gt3/en_amy/t1_throttle.wav", 900),
      audioShort: audio("gt3/en_amy/t1_throttle_short.wav", 540),
      dirty: false,
    },
  ],
};
