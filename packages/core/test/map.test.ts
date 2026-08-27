import { describe, expect, it } from "vitest";

import { cornerByIndex, indexLandmarks, trackLength } from "@exxeed/core";

import { spaLandmarks, spaMap, SPA_LENGTH_M } from "./fixtures.js";

describe("cornerByIndex", () => {
  it("looks up by the corner's index field, not its array position", () => {
    // Indices are 1-based and a corners.override.json can renumber them (§5.2),
    // so position and index are not interchangeable — corner 1 is at corners[0].
    expect(cornerByIndex(spaMap, 1)?.names).toEqual(["La Source"]);
    expect(cornerByIndex(spaMap, 2)?.names).toEqual(["Eau Rouge", "Raidillon"]);
    expect(cornerByIndex(spaMap, 0)).toBeUndefined();
    expect(spaMap.corners[1]?.index).toBe(2);
  });
});

describe("trackLength", () => {
  it("hands back branded metres so callers stop rewrapping it", () => {
    expect(trackLength(spaMap)).toBe(SPA_LENGTH_M);
  });
});

describe("indexLandmarks", () => {
  it("indexes by id for the ingest pipeline, not for the runtime", () => {
    // Nothing on the 60 Hz path touches this. A note is a point and a message
    // (§4.4); landmarks are how §10 stage 3 hands the model a closed vocabulary.
    const index = indexLandmarks(spaLandmarks);
    expect(index.get("t1_board_100")?.pct).toBeCloseTo(0.99781, 6);
    expect(index.get("nope")).toBeUndefined();
  });
});
