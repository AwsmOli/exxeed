import { describe, expect, it } from "vitest";

import {
  assertSteeringSignMeasured,
  directionFromSteer,
  IRacingAdapter,
  isIRacingSupported,
  STEER_SIGN_MEASURED,
  UnsupportedPlatformError,
} from "@exxeed/telemetry";

describe("IRacingAdapter platform guard", () => {
  it("fails with a clear message off Windows, not an opaque native-build error", async () => {
    // @irsdk-node/native ships prebuilds for win32-x64 and win32-arm64 only. A
    // top-level import would take this whole package — and every test in it —
    // down on macOS, so the SDK import lives inside connect() behind this guard.
    if (isIRacingSupported()) {
      expect(process.platform).toBe("win32");
      return;
    }

    const adapter = new IRacingAdapter();
    await expect(adapter.connect()).rejects.toBeInstanceOf(UnsupportedPlatformError);
    await expect(adapter.connect()).rejects.toThrow(/requires Windows/);
    await expect(adapter.connect()).rejects.toThrow(/ReplayAdapter/);
  });

  it("imports cleanly on any platform", () => {
    // The assertion is that the import at the top of this file did not throw.
    expect(new IRacingAdapter().connected).toBe(false);
  });
});

describe("steering sign convention", () => {
  // SPEC.md §5 and §12: never assume it. A wrong sign inverts every corner's
  // direction silently, with no crash to tell you — so corner detection refuses
  // to run until someone has actually measured it on Windows (M0b).
  it("refuses to derive a corner direction while the sign is unmeasured", () => {
    if (STEER_SIGN_MEASURED) {
      expect(() => assertSteeringSignMeasured()).not.toThrow();
      return;
    }

    expect(() => assertSteeringSignMeasured()).toThrow(/not been measured/);
    expect(() => directionFromSteer(0.4)).toThrow(/M0b/);
  });

  it.todo("matches a known right-hander in the M0b reference recording");
});
