import { describe, expect, it } from "vitest";

import type { SuppressionInput } from "@exxeed/core";
import { CRAWL_SPEED_MPS, mps, OFF_TRACK_HOLD_S, SuppressionGate } from "@exxeed/core";

/** Driving normally, on track, second lap. Tests override one field at a time. */
const driving = (overrides: Partial<SuppressionInput> = {}): SuppressionInput => ({
  tMs: 0,
  speedMps: mps(69),
  lap: 2,
  onTrack: true,
  inPitLane: false,
  inGarage: false,
  offTrack: false,
  towTimeS: 0,
  resetCounter: 0,
  ...overrides,
});

/** A gate already past the out-lap requirement. */
function warm(): SuppressionGate {
  const gate = new SuppressionGate();
  gate.evaluate(driving({ lap: 1 }));
  gate.evaluate(driving({ lap: 2 }));
  return gate;
}

describe("the §6.4 conditions", () => {
  it("says nothing when not on track", () => {
    expect(warm().evaluate(driving({ onTrack: false }))).toBe("not_on_track");
  });

  it("says nothing in the pit lane", () => {
    expect(warm().evaluate(driving({ inPitLane: true }))).toBe("pit_lane");
  });

  it("says nothing in the garage", () => {
    expect(warm().evaluate(driving({ inGarage: true }))).toBe("garage");
  });

  it("says nothing while being towed", () => {
    expect(warm().evaluate(driving({ towTimeS: 12.5 }))).toBe("towing");
  });

  it("says nothing below 30 km/h", () => {
    expect(warm().evaluate(driving({ speedMps: mps(CRAWL_SPEED_MPS - 0.1) }))).toBe("crawling");
    expect(warm().evaluate(driving({ speedMps: mps(CRAWL_SPEED_MPS + 0.1) }))).toBeNull();
  });

  it("speaks when everything is normal", () => {
    expect(warm().evaluate(driving())).toBeNull();
  });
});

describe("reset to pits", () => {
  it("suppresses when EnterExitReset changes, but not on the first sighting", () => {
    const gate = warm();
    // First evaluate in warm() established the counter; a steady value is fine.
    expect(gate.evaluate(driving({ resetCounter: 0 }))).toBeNull();
    expect(gate.evaluate(driving({ resetCounter: 1 }))).toBe("reset");
  });

  it("does not fire on the very first tick of a session", () => {
    const gate = new SuppressionGate();
    // No previous value to compare against, so a non-zero counter is not a change.
    expect(gate.evaluate(driving({ resetCounter: 7, lap: 1 }))).toBe("out_lap");
  });

  it("puts the driver back on an out-lap", () => {
    const gate = warm();
    expect(gate.evaluate(driving({ resetCounter: 1 }))).toBe("reset");
    // Same lap number as before the reset — but they are on an out-lap again.
    expect(gate.evaluate(driving({ resetCounter: 1, lap: 2 }))).toBe("out_lap");
    expect(gate.evaluate(driving({ resetCounter: 1, lap: 3 }))).toBeNull();
  });
});

describe("off-track hold", () => {
  it("suppresses while off track and for two seconds after", () => {
    // SPEC.md §6.4: PlayerTrackSurface == OffTrack is the closest available proxy
    // for four wheels off, and it flickers on kerbs — hence the hold.
    const gate = warm();

    expect(gate.evaluate(driving({ tMs: 1000, offTrack: true }))).toBe("off_track");
    expect(gate.evaluate(driving({ tMs: 1500, offTrack: false }))).toBe("off_track_hold");
    expect(gate.evaluate(driving({ tMs: 2500, offTrack: false }))).toBe("off_track_hold");

    // 1000 + 2000 = 3000 ms.
    expect(gate.evaluate(driving({ tMs: 3001, offTrack: false }))).toBeNull();
  });

  it("restarts the hold on every off-track sample, so kerb-hopping stays quiet", () => {
    const gate = warm();
    gate.evaluate(driving({ tMs: 1000, offTrack: true }));
    gate.evaluate(driving({ tMs: 2000, offTrack: true }));

    // The second excursion pushed the deadline to 4000, not 3000.
    expect(gate.evaluate(driving({ tMs: 3500, offTrack: false }))).toBe("off_track_hold");
    expect(gate.evaluate(driving({ tMs: 4001, offTrack: false }))).toBeNull();
  });

  it("holds for exactly OFF_TRACK_HOLD_S", () => {
    const gate = warm();
    gate.evaluate(driving({ tMs: 0, offTrack: true }));
    const justBefore = OFF_TRACK_HOLD_S * 1000 - 1;

    expect(gate.evaluate(driving({ tMs: justBefore }))).toBe("off_track_hold");
    expect(gate.evaluate(driving({ tMs: OFF_TRACK_HOLD_S * 1000 }))).toBeNull();
  });
});

describe("out-lap gate", () => {
  it("requires one completed lap since going on track", () => {
    const gate = new SuppressionGate();

    expect(gate.evaluate(driving({ lap: 4 }))).toBe("out_lap");
    expect(gate.evaluate(driving({ lap: 4 }))).toBe("out_lap");
    expect(gate.evaluate(driving({ lap: 5 }))).toBeNull();
  });

  it("restarts after going back to the garage", () => {
    const gate = warm();
    expect(gate.evaluate(driving())).toBeNull();

    gate.evaluate(driving({ inGarage: true }));
    expect(gate.evaluate(driving({ lap: 2 }))).toBe("out_lap");
    expect(gate.evaluate(driving({ lap: 3 }))).toBeNull();
  });
});

describe("precedence", () => {
  it("reports the most fundamental reason when several apply at once", () => {
    // Sitting stationary in the garage having just been towed: "not on track"
    // is the useful answer, not "crawling".
    const gate = warm();
    const reason = gate.evaluate(
      driving({ onTrack: false, inGarage: true, towTimeS: 5, speedMps: mps(0) }),
    );
    expect(reason).toBe("not_on_track");
  });
});
