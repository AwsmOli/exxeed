import { describe, expect, it } from "vitest";

import { PANEL_PARTS, PANEL_STYLES, PANELS, sanitizePanelSettings } from "@exxeed/overlays";

describe("panel options", () => {
  it("only names overlays that exist, with unique part ids of plain letters", () => {
    for (const [panel, parts] of Object.entries(PANEL_PARTS)) {
      expect((PANELS as readonly string[]).includes(panel), panel).toBe(true);
      const ids = parts.map((p) => p.id);
      expect(new Set(ids).size, panel).toBe(ids.length);
      // The overlay page turns an id into a CSS selector, so nothing else may be in one.
      for (const id of ids) expect(id, `${panel}.${id}`).toMatch(/^[a-z]+$/);
    }
    for (const panel of Object.keys(PANEL_STYLES)) expect((PANELS as readonly string[]).includes(panel), panel).toBe(true);
  });

  it("keeps known hidden parts and drops the rest", () => {
    expect(sanitizePanelSettings("standings", { hidden: ["gap", "nope", "gap", 3], style: "x" })).toEqual({
      hidden: ["gap"],
      style: null,
    });
  });

  it("stores the default style as null, and a chosen one by id", () => {
    expect(sanitizePanelSettings("delta", { hidden: [], style: "bar" }).style).toBeNull();
    expect(sanitizePanelSettings("delta", { hidden: [], style: "dial" }).style).toBe("dial");
  });

  it("gives defaults for anything that is not settings", () => {
    expect(sanitizePanelSettings("fuel", null)).toEqual({ hidden: [], style: null });
    expect(sanitizePanelSettings("radar", { hidden: ["x"] })).toEqual({ hidden: [], style: null });
  });
});
