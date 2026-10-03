import { describe, expect, it } from "vitest";

import {
  BUILTIN_THEMES,
  MAX_THEME_TEMPLATE,
  parseTheme,
  parseThemeAssets,
  THEME_TOKENS,
  themeById,
  themeFileFor,
  themeJsonSchema,
  themeVariables,
  themeView,
  type Theme,
} from "@exxeed/overlays";

describe("themes", () => {
  it("every built-in token is a known token with a valid value", () => {
    for (const theme of BUILTIN_THEMES) {
      const names = Object.keys(theme.tokens);
      for (const name of names) expect(name in THEME_TOKENS, `${theme.id}: ${name}`).toBe(true);
      // Nothing dropped by validation: a typo in a built-in would vanish silently otherwise.
      expect(Object.keys(themeVariables(theme)).sort(), theme.id).toEqual(names.map((n) => `--${n}`).sort());
    }
  });

  it("falls back to the default theme for an unknown id", () => {
    expect(themeById("no-such-theme").id).toBe("iracing");
    expect(themeById(null).id).toBe("iracing");
  });

  it("still reads a theme built on the old default, by its old name", () => {
    const { theme, problems } = parseTheme(JSON.stringify({ base: "exxeed", tokens: { radius: "3px" } }), "old");
    expect(problems).toEqual([]);
    expect(theme?.base).toBe("classic");
    expect(themeView(theme!).layout).toBe("wash");
    // The classic look is the stylesheet's: the theme adds only what it sets.
    expect(themeView(theme!).variables).toEqual({ "--radius": "3px" });
  });

  it("does not offer the classic look in the picker", () => {
    expect(BUILTIN_THEMES.map((t) => t.id)).toEqual(["iracing", "gran-turismo", "synthwave"]);
  });

  it("names a font stack rather than passing a font string through", () => {
    expect(themeVariables(themeById("iracing"))["--font"]).toContain("Segoe UI");
  });

  it("drops anything that is not a known token with a value of its kind", () => {
    const hostile = {
      id: "x",
      name: "x",
      description: "",
      tokens: {
        card: "url(https://example.com/pixel.png)",
        text: "#fff; background: url(x)",
        radius: "calc(100vw)",
        font: "Comic Sans MS",
        "card-border": "1px solid red; display: none",
        "not-a-token": "#fff",
        green: "#00ff00",
      },
    } as unknown as Theme;
    expect(themeVariables(hostile)).toEqual({ "--green": "#00ff00" });
  });
});

describe("custom themes", () => {
  it("round-trips a theme file made from a built-in", () => {
    const file = themeFileFor(themeById("iracing"), "My iRacing", "./theme.schema.json");
    const { theme, problems } = parseTheme(file, "my-iracing");
    expect(problems).toEqual([]);
    expect(theme?.name).toBe("My iRacing");
    expect(theme?.base).toBe("iracing");
    // Looks the same as what it was copied from, and keeps its row layout.
    expect(themeView(theme!).variables).toEqual(themeView(themeById("iracing")).variables);
    expect(themeView(theme!).layout).toBe("chips");
  });

  it("fills what a theme leaves out from its base", () => {
    const { theme } = parseTheme(JSON.stringify({ base: "iracing", tokens: { me: "#ff00ff" } }), "pink");
    const variables = themeView(theme!).variables;
    expect(variables["--me"]).toBe("#ff00ff");
    expect(variables["--card"]).toBe(themeView(themeById("iracing")).variables["--card"]);
  });

  it("reports a bad token and keeps the rest", () => {
    const { theme, problems } = parseTheme(
      JSON.stringify({ name: "T", tokens: { card: "url(x)", nope: "#fff", radius: "4px" } }),
      "t",
    );
    expect(theme?.tokens).toEqual({ radius: "4px" });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('"card" must be a colour');
    expect(problems[1]).toBe('"nope" is not a token');
  });

  it("says so when the file is not JSON, without a theme", () => {
    const { theme, problems } = parseTheme("{ name: ", "broken");
    expect(theme).toBeNull();
    expect(problems[0]).toContain("not valid JSON");
  });

  it("describes every token in the schema", () => {
    const schema = themeJsonSchema() as { properties: { tokens: { properties: Record<string, { description: string }> } } };
    const described = Object.keys(schema.properties.tokens.properties);
    expect(described.sort()).toEqual(Object.keys(THEME_TOKENS).sort());
    for (const name of described) expect(schema.properties.tokens.properties[name]!.description.length).toBeGreaterThan(10);
  });

  it("carries a stylesheet and templates, and drops what is not one", () => {
    const parsed = parseTheme(
      JSON.stringify({
        name: "GT copy",
        base: "gran-turismo",
        css: ".row { color: red; }",
        templates: { standings: "<div class=\"panel\"></div>", "Bad Id": "<div></div>", relative: 42 },
      }),
      "gt-copy",
    );
    expect(parsed.theme?.css).toBe(".row { color: red; }");
    expect(parsed.theme?.templates).toEqual({ standings: '<div class="panel"></div>' });
    expect(parsed.problems).toHaveLength(2);
  });

  it("refuses a template that is too large", () => {
    const out = parseThemeAssets(undefined, { standings: "x".repeat(MAX_THEME_TEMPLATE + 1) });
    expect(out.templates).toBeUndefined();
    expect(out.problems[0]).toMatch(/standings/);
  });

  it("puts a custom theme's stylesheet and templates over its base's files", () => {
    const files = (id: string) =>
      id === "gran-turismo" ? { css: "/* gt */", templates: { standings: "gt", relative: "gt" } } : {};
    const custom: Theme = {
      id: "mine",
      name: "Mine",
      description: "",
      base: "gran-turismo",
      tokens: {},
      css: "/* mine */",
      templates: { relative: "mine" },
    };
    const view = themeView(custom, files);
    expect(view.css).toBe("/* gt */\n/* mine */");
    expect(view.templates).toEqual({ standings: "gt", relative: "mine" });
    // A built-in gets its own files.
    expect(themeView(themeById("gran-turismo"), files).templates).toEqual({ standings: "gt", relative: "gt" });
  });
});
