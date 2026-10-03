import { describe, expect, it } from "vitest";

import { mirrorBounds } from "@exxeed/overlays";

describe("mirrorBounds", () => {
  const main = { x: 0, y: 0, width: 1920, height: 1080 };

  it("puts the partner the same distance from the other edge", () => {
    expect(mirrorBounds({ x: 100, y: 400, width: 150, height: 60 }, main)).toEqual({ x: 1670, y: 400, width: 150, height: 60 });
  });

  it("leaves a window centred on the line where it is", () => {
    expect(mirrorBounds({ x: 885, y: 0, width: 150, height: 60 }, main).x).toBe(885);
  });

  it("mirrors on a second screen's own centre line, to its right", () => {
    const second = { x: 1920, y: 0, width: 2560, height: 1440 };
    expect(mirrorBounds({ x: 2020, y: 700, width: 150, height: 60 }, second)).toEqual({ x: 4230, y: 700, width: 150, height: 60 });
  });

  it("works on a screen to the left of the main one, at negative x", () => {
    const left = { x: -1920, y: 0, width: 1920, height: 1080 };
    expect(mirrorBounds({ x: -1820, y: 300, width: 150, height: 60 }, left).x).toBe(-250);
  });

  it("is its own inverse", () => {
    const w = { x: 333, y: 50, width: 151, height: 61 };
    expect(mirrorBounds(mirrorBounds(w, main), main)).toEqual(w);
  });
});
