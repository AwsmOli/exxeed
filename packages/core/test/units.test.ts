import { describe, expect, it } from "vitest";

import { aheadM, metres, mps, pct, seconds, toKph } from "@exxeed/core";

/**
 * SPEC.md §3's unit rule is only worth anything if the compiler enforces it.
 * These `@ts-expect-error` assertions ARE the enforcement: each one fails the
 * build if the branded types ever collapse back to plain `number`.
 *
 * They are checked by `pnpm typecheck` (tsconfig.test.json), not by the test
 * runner — Vitest transpiles without typechecking, so a broken brand would sail
 * straight through `pnpm test` alone.
 */
describe("branded units", () => {
  it("refuses a raw number where a branded unit is expected", () => {
    // @ts-expect-error raw numbers are not Pct
    aheadM(0.1, pct(0.2), metres(7004));

    // @ts-expect-error raw numbers are not Metres
    aheadM(pct(0.1), pct(0.2), 7004);

    expect(aheadM(pct(0.1), pct(0.2), metres(7004))).toBeCloseTo(700.4, 6);
  });

  it("refuses one unit where another is expected", () => {
    // @ts-expect-error a lap position is not a distance
    aheadM(pct(0.1), pct(0.2), pct(0.5));

    // @ts-expect-error seconds are not metres per second
    toKph(seconds(2));

    expect(toKph(mps(69))).toBeCloseTo(248.4, 6);
  });

  it("still behaves as a number at runtime — the brand is erased", () => {
    expect(mps(69) + 1).toBe(70);
    expect(JSON.stringify({ v: mps(69) })).toBe('{"v":69}');
  });

  it("converts m/s to kph only through toKph", () => {
    // 250 km/h is the speed SPEC.md §6.1 works its 173 m lead example at.
    expect(toKph(mps(69.44))).toBeCloseTo(249.98, 2);
  });
});
