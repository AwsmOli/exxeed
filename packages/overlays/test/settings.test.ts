import { describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS,
  resolveDebugEnabled,
  withDefaults,
  withEnvOverrides,
} from "@exxeed/overlays";

describe("withDefaults", () => {
  it("fills in everything from nothing", () => {
    expect(withDefaults(null)).toEqual(DEFAULT_SETTINGS);
    expect(withDefaults({})).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps the debug group when a file has only part of it", () => {
    // The shape an upgrade produces. A shallow spread would drop every other
    // debug field the moment one of them was present.
    const merged = withDefaults({ debug: { skipOutLap: true } as never });

    expect(merged.debug.skipOutLap).toBe(true);
    expect(merged.debug.replaySpeed).toBe(DEFAULT_SETTINGS.debug.replaySpeed);
    expect(merged.debug.loopReplay).toBe(DEFAULT_SETTINGS.debug.loopReplay);
    expect(merged.debug.replayPath).toBeNull();
  });

  it("drops panel names it does not recognise", () => {
    const merged = withDefaults({ panels: ["map", "nonsense", "delta"] as never });
    expect(merged.panels).toEqual(["map", "delta"]);
  });

  it("treats an empty panel list as unset", () => {
    // An empty list opens no windows at all, and there is no way back from
    // inside the app.
    expect(withDefaults({ panels: [] }).panels).toEqual(DEFAULT_SETTINGS.panels);
    expect(withDefaults({ panels: ["nope"] as never }).panels).toEqual(DEFAULT_SETTINGS.panels);
  });

  it("ignores values of the wrong type rather than passing them through", () => {
    const merged = withDefaults({
      leadAdjustS: "0.4" as never,
      voiceId: "" as never,
      // A number, now that carId is the sim's slug — this used to be the case
      // the other way round, when a hand-typed integer was the car identity.
      carId: 67 as never,
    });
    expect(merged.leadAdjustS).toBe(0);
    expect(merged.voiceId).toBe(DEFAULT_SETTINGS.voiceId);
    expect(merged.carId).toBeNull();
  });

  it("keeps a legitimate zero rather than treating it as absent", () => {
    // ?? not ||: 0 is a real lead adjustment and must survive.
    expect(withDefaults({ leadAdjustS: 0 }).leadAdjustS).toBe(0);
    // An empty slug is not a car, though, so it falls back rather than being kept.
    expect(withDefaults({ carId: "" }).carId).toBe(DEFAULT_SETTINGS.carId);
    expect(withDefaults({ carId: "mx5-mx52016" }).carId).toBe("mx5-mx52016");
  });
});

describe("withEnvOverrides", () => {
  const base = withDefaults({ noteSetId: "stored", voiceId: "stored-voice", leadAdjustS: 0.2 });

  it("changes nothing when the environment is empty", () => {
    expect(withEnvOverrides(base, {})).toEqual(base);
  });

  it("carries the render voice, and lets the environment override it", () => {
    // A voice id in the voices folder, not a path: the app finds the file, so
    // the setting survives the folder moving and can be offered as a picker.
    const stored = withDefaults({ renderVoiceId: "en_US-ljspeech-medium" });
    expect(stored.renderVoiceId).toBe("en_US-ljspeech-medium");
    expect(stored.piperBinary).toBeNull();

    const overridden = withEnvOverrides(stored, { EXXEED_VOICE_MODEL: "en_US-libritts_r-medium" });
    expect(overridden.renderVoiceId).toBe("en_US-libritts_r-medium");
  });

  it("lets the environment win", () => {
    const merged = withEnvOverrides(base, {
      EXXEED_NOTES: "from-env",
      EXXEED_VOICE: "env-voice",
      EXXEED_LEAD_ADJUST: "0.75",
      EXXEED_SPEED: "8",
    });

    expect(merged.noteSetId).toBe("from-env");
    expect(merged.voiceId).toBe("env-voice");
    expect(merged.leadAdjustS).toBeCloseTo(0.75, 6);
    expect(merged.debug.replaySpeed).toBe(8);
  });

  it("ignores an empty variable, which is how a shell unsets one", () => {
    expect(withEnvOverrides(base, { EXXEED_NOTES: "" }).noteSetId).toBe("stored");
  });

  it("ignores a non-numeric value rather than producing NaN", () => {
    // NaN would reach the trigger as a lead time and silence everything.
    expect(withEnvOverrides(base, { EXXEED_LEAD_ADJUST: "soon" }).leadAdjustS).toBeCloseTo(0.2, 6);
    expect(withEnvOverrides(base, { EXXEED_SPEED: "fast" }).debug.replaySpeed).toBe(1);
  });

  it("treats EXXEED_SKIP_OUTLAP as a flag, present or not", () => {
    expect(withEnvOverrides(base, { EXXEED_SKIP_OUTLAP: "1" }).debug.skipOutLap).toBe(true);
    expect(withEnvOverrides(base, {}).debug.skipOutLap).toBe(true);
  });

  it("filters unknown panel names out of the environment too", () => {
    expect(withEnvOverrides(base, { EXXEED_PANELS: "delta, nope ,map" }).panels).toEqual([
      "delta",
      "map",
    ]);
  });

  it("falls back to the stored panels when the environment names none that exist", () => {
    expect(withEnvOverrides(base, { EXXEED_PANELS: "nope" }).panels).toEqual(base.panels);
  });
});

describe("resolveDebugEnabled", () => {
  it("is on when running from source, so pnpm dev needs no flag", () => {
    expect(resolveDebugEnabled(false, undefined)).toBe(true);
  });

  it("is off in a packaged build unless asked", () => {
    // This is what keeps the safety meaningful: debug settings persist but only
    // bite while debug is on, so a replay file set once cannot quietly stop a
    // real user's sim from connecting.
    expect(resolveDebugEnabled(true, undefined)).toBe(false);
    expect(resolveDebugEnabled(true, "1")).toBe(true);
  });

  it("can be forced off from source, for checking packaged behaviour", () => {
    expect(resolveDebugEnabled(false, "0")).toBe(false);
    expect(resolveDebugEnabled(false, "false")).toBe(false);
    expect(resolveDebugEnabled(false, "FALSE")).toBe(false);
  });

  it("treats an empty value as unset, which is how a shell clears one", () => {
    expect(resolveDebugEnabled(true, "")).toBe(false);
    expect(resolveDebugEnabled(false, "")).toBe(true);
  });
});
