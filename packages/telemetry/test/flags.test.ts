import { describe, expect, it } from "vitest";

import { FLAG_BITS, flagShown } from "../src/race.js";

describe("flagShown", () => {
  it("shows nothing for a plain green race", () => {
    expect(flagShown(FLAG_BITS.green)).toBeNull();
    expect(flagShown(0)).toBeNull();
  });

  it("puts your own flags before the session's", () => {
    expect(flagShown(FLAG_BITS.green | FLAG_BITS.yellow | FLAG_BITS.black)?.kind).toBe("black");
    expect(flagShown(FLAG_BITS.blue | FLAG_BITS.repair)?.kind).toBe("meatball");
  });

  it("knows a waved yellow from a shown one", () => {
    expect(flagShown(FLAG_BITS.green | FLAG_BITS.yellowWaving)).toEqual({ kind: "yellow", waving: true });
    expect(flagShown(FLAG_BITS.yellow)).toEqual({ kind: "yellow", waving: false });
  });

  it("reads the start bit, which sets the sign bit of a 32-bit field", () => {
    expect(flagShown(FLAG_BITS.startGo | 0)?.kind).toBe("green");
  });
});
