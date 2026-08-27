/**
 * The steering sign convention — SPEC.md §5, §12, and the M0b measurement.
 *
 * §12 asks for this to be covered by a test specifically because getting it
 * wrong is silent: corner detection still produces a track map, it still passes
 * every other test, and every right-hander in it is labelled a left. The only
 * thing standing between that and shipping is this file.
 */

import { describe, expect, it } from "vitest";

import {
  assertSteeringSignMeasured,
  directionFromSteer,
  STEER_SIGN_MEASURED,
  STEER_SIGN_RIGHT,
} from "@exxeed/telemetry";

describe("steering sign convention", () => {
  it("has been measured, not assumed", () => {
    expect(STEER_SIGN_MEASURED).toBe(true);
    expect(assertSteeringSignMeasured).not.toThrow();
  });

  it("is negative for right, as measured on a real lap", () => {
    // M0b, MX-5 at Daytona: turning right reads negative. If this constant is
    // ever flipped without a new measurement, the failure is silent everywhere
    // except here.
    expect(STEER_SIGN_RIGHT).toBe(-1);
  });

  it("calls a sustained negative angle a right-hander", () => {
    expect(directionFromSteer(-0.919)).toBe("right");
    expect(directionFromSteer(-0.05)).toBe("right");
  });

  it("calls a sustained positive angle a left-hander", () => {
    expect(directionFromSteer(0.878)).toBe("left");
    expect(directionFromSteer(0.05)).toBe("left");
  });

  it("is consistent for both directions of the same magnitude", () => {
    for (const magnitude of [0.05, 0.4, 0.878, 1.6]) {
      expect(directionFromSteer(magnitude)).not.toBe(directionFromSteer(-magnitude));
    }
  });
});
