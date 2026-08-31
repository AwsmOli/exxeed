import { describe, expect, it } from "vitest";

import type { CarRegistry } from "@exxeed/core";
import { carEntry, CarRegistrySchema, classOf, matchesClass } from "@exxeed/core";

const registry: CarRegistry = {
  schema: 1,
  sim: "iracing",
  cars: {
    "mx5-mx52016": { class: "mx5", name: "Mazda MX-5 Cup" },
    ferrari296gt3: { class: "gt3", name: "Ferrari 296 GT3" },
    porsche992r: { class: "gt3", name: "Porsche 992 GT3 R" },
  },
};

describe("classOf", () => {
  it("maps the sim's slug to a class", () => {
    expect(classOf(registry, "mx5-mx52016")).toBe("mx5");
  });

  it("puts two different cars in one class — which is the point of the table", () => {
    // SPEC.md §13 Q2's granularity question is answered by what is written here,
    // not by code. Splitting "gt3" per manufacturer is an edit to the data file.
    expect(classOf(registry, "ferrari296gt3")).toBe("gt3");
    expect(classOf(registry, "porsche992r")).toBe("gt3");
  });

  it("returns null for a car nobody has added yet", () => {
    expect(classOf(registry, "some-new-car-2027")).toBeNull();
    expect(carEntry(registry, "some-new-car-2027")).toBeNull();
  });

  it("returns null when there is no registry at all", () => {
    expect(classOf(null, "mx5-mx52016")).toBeNull();
  });
});

describe("matchesClass", () => {
  it("matches when the note set names the car's own class", () => {
    expect(matchesClass(registry, "mx5-mx52016", "mx5")).toEqual({
      kind: "match",
      carClass: "mx5",
    });
  });

  it("reports a mismatch with both classes, because the warning names both", () => {
    expect(matchesClass(registry, "mx5-mx52016", "gt3")).toEqual({
      kind: "mismatch",
      carClass: "mx5",
      expected: "gt3",
    });
  });

  it("accepts any car in the class, not just the one the lap was recorded in", () => {
    expect(matchesClass(registry, "porsche992r", "gt3").kind).toBe("match");
  });

  /**
   * The distinction that earns the three-valued return. Collapsing "unknown"
   * into "mismatch" would fire the warning every time someone drives a car that
   * is simply not in the table yet, and a warning that cries wolf stops being
   * read — which costs more than the check is worth.
   */
  it("is unknown, NOT a mismatch, for a car missing from the registry", () => {
    expect(matchesClass(registry, "some-new-car-2027", "gt3")).toEqual({ kind: "unknown" });
  });

  it("is unknown when there is no registry, rather than warning about everything", () => {
    expect(matchesClass(null, "mx5-mx52016", "gt3")).toEqual({ kind: "unknown" });
  });

  it("is unknown before the sim has said what is being driven", () => {
    // Identity arrives on connect, after the session is already pinned.
    expect(matchesClass(registry, null, "gt3")).toEqual({ kind: "unknown" });
  });
});

describe("CarRegistrySchema", () => {
  it("accepts the checked-in registry shape", () => {
    expect(() => CarRegistrySchema.parse(registry)).not.toThrow();
  });

  it("rejects an entry with no class rather than defaulting one", () => {
    expect(() =>
      CarRegistrySchema.parse({
        schema: 1,
        sim: "iracing",
        cars: { "mx5-mx52016": { name: "Mazda MX-5 Cup" } },
      }),
    ).toThrow();
  });
});
