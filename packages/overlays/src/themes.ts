/**
 * Overlay themes — TODO M9.
 *
 * A theme is data, not code: a set of named tokens, each a colour, a length, a
 * font from a fixed list or one of a few keywords. `overlay.css` reads them as
 * custom properties and the canvas panels read the same values, so a theme
 * restyles every overlay without touching a panel's markup. A CSS file from a
 * stranger could load a remote image in every overlay or hide a panel; a list
 * of tokens cannot, and it survives every redesign of a panel. That is why
 * VS Code themes are JSON.
 *
 * Tokens a theme leaves out keep the default look (`overlay.css`'s `:root`),
 * so a theme is as short as what it changes.
 */

/** Every token a theme may set, and what kind of value it takes. */
export const THEME_TOKENS = {
  // Surfaces.
  card: "color",
  "card-hi": "color",
  well: "color",
  line: "color",
  track: "color",
  "card-border": "border",
  // Text.
  text: "color",
  "text-2": "color",
  "text-3": "color",
  /** Small captions beside a value ("GAP", "Last"). */
  label: "color",
  // Colours that carry meaning. The hue names are the palette; the role names
  // (`throttle`, `brake`, `me`) are what the panels ask for.
  green: "color",
  mint: "color",
  red: "color",
  yellow: "color",
  orange: "color",
  cyan: "color",
  purple: "color",
  blue: "color",
  throttle: "color",
  brake: "color",
  /** Between good and bad: a tyre that is warm but not yet hot. */
  warm: "color",
  /** The strongest warning: a car alongside on the radar, the shift lights' blink. */
  danger: "color",
  // The rev lights, from the first to light to the last. Left out, they run
  // green, yellow, orange, red in the theme's own colours.
  "shift-low": "color",
  "shift-mid": "color",
  "shift-high": "color",
  "shift-max": "color",
  me: "color",
  "me-text": "color",
  /** A solid band behind your own row, under the wash of `me`. */
  "me-bg": "color",
  /** The small chips in a row: iRating, lap count, PIT. */
  "chip-bg": "color",
  "chip-text": "color",
  road: "color",
  "road-edge": "color",
  /** Neutral lines on charts and dials: grids, the reference trace. White on a dark theme, dark on a light one. */
  ink: "color",
  /** The used part of the fuel bar. */
  "fuel-empty": "color",
  // On the Relatives: a car a lap ahead of you, and one a lap behind.
  "lap-ahead": "color",
  "lap-behind": "color",
  // Licence colours, in place of the sim's: Rookie, D, C, B, A and Pro.
  "lic-r": "color",
  "lic-d": "color",
  "lic-c": "color",
  "lic-b": "color",
  "lic-a": "color",
  "lic-p": "color",
  // Class colours, fastest class first. Left out, the sim's own are used.
  "class-1": "color",
  "class-2": "color",
  "class-3": "color",
  "class-4": "color",
  "class-5": "color",
  // Shape.
  radius: "length",
  gap: "length",
  "pill-radius": "length",
  /** How far lit things glow (shift lights, pedal knobs, the brake bar). 0px for none. */
  glow: "length",
  /** How strongly the shift lights are coloured, 0..1: lower is more muted. */
  "shift-strength": "number",
  /** The rev lights as a row of lights, or as one curved line that fills (Gran Turismo's). */
  "shift-style": "shiftStyle",
  // Type.
  font: "font",
  /** The face numbers are set in. */
  "num-font": "font",
  /** The face panel titles are set in. */
  "title-font": "font",
  "num-weight": "weight",
  "body-weight": "weight",
  // The short title card above a panel's content.
  "title-bg": "color",
  "title-text": "color",
  "title-size": "length",
  "title-weight": "weight",
  "title-spacing": "length",
  "title-case": "case",
  "title-justify": "justify",
} as const;

export type ThemeToken = keyof typeof THEME_TOKENS;
type TokenKind = (typeof THEME_TOKENS)[ThemeToken];

/** Font stacks a theme may name. Only fonts the OS has; nothing is downloaded. */
export const THEME_FONTS = {
  default: `"Satoshi", "Segoe UI Variable Display", "Segoe UI", system-ui, -apple-system, sans-serif`,
  // Bahnschrift ships with Windows 10 and later: a DIN-style face, close to
  // the bold condensed type of the sim's own boxes.
  condensed: `"Bahnschrift", "Roboto Condensed", "DIN Alternate", "Arial Narrow", "Segoe UI", system-ui, sans-serif`,
  // A plain UI sans, as the sim's 2025 interface uses.
  ui: `"Inter", "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif`,
  // Montserrat ships with the app (static/fonts, SIL Open Font License): a
  // wide geometric sans that reads well bold.
  geometric: `"Montserrat", "Poppins", "Avenir Next", "Segoe UI", system-ui, sans-serif`,
  // Three 80s faces, also bundled under the Open Font License: Orbitron for
  // digits like a digital dash, Audiowide for titles, Exo 2 for the words between.
  digital: `"Orbitron", "Bahnschrift", "Segoe UI", system-ui, sans-serif`,
  arcade: `"Audiowide", "Orbitron", "Segoe UI", system-ui, sans-serif`,
  future: `"Exo 2", "Segoe UI", system-ui, -apple-system, sans-serif`,
  mono: `"Roboto Mono", "Cascadia Mono", Consolas, ui-monospace, SFMono-Regular, Menlo, monospace`,
} as const;

/**
 * How a row of Standings or Relatives is built. Colours cannot say this, so a
 * theme picks one:
 *  - `wash`: the class colour bleeds in behind the position (the default look);
 *  - `chips`: a plain position, the car number in a class-coloured chip, a filled licence chip;
 *  - `blocks`: a white position chip, the car number in a class-coloured block
 *    with a bright stripe, striped rows, and class headers as tabs.
 */
export const THEME_LAYOUTS = ["wash", "chips", "blocks"] as const;
export type ThemeLayout = (typeof THEME_LAYOUTS)[number];

/** The layout each built-in theme uses, which a theme based on it inherits. */
const BUILTIN_LAYOUT: Record<string, ThemeLayout> = {
  classic: "wash",
  iracing: "chips",
  "gran-turismo": "chips",
  synthwave: "wash",
};

export interface Theme {
  readonly id: string;
  readonly name: string;
  /** One line for the picker. */
  readonly description: string;
  /**
   * The built-in theme this one starts from: its tokens fill whatever this
   * theme leaves out, and its row layout is used. Custom themes only; a
   * built-in is its own base.
   */
  readonly base?: string;
  /** How rows are laid out (`THEME_LAYOUTS`). Left out, the base theme's own. */
  readonly layout?: ThemeLayout;
  readonly author?: string;
  readonly tokens: Readonly<Partial<Record<ThemeToken, string>>>;
}

const COLOR = /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.\s,%/]+\)|transparent)$/i;
const LENGTH = /^-?\d+(\.\d+)?(px|em)?$/;
const BORDER = /^\d+(\.\d+)?px (solid|dashed) (#[0-9a-f]{3,8}|rgba?\(\s*[\d.\s,%/]+\)|transparent)$/i;

const VALID: Record<TokenKind, (value: string) => boolean> = {
  color: (v) => COLOR.test(v),
  length: (v) => LENGTH.test(v),
  border: (v) => BORDER.test(v),
  font: (v) => v in THEME_FONTS,
  weight: (v) => /^[1-9]00$/.test(v),
  number: (v) => /^(0(\.\d+)?|1(\.0+)?)$/.test(v),
  case: (v) => v === "none" || v === "uppercase",
  justify: (v) => v === "center" || v === "flex-start",
  shiftStyle: (v) => v === "lights" || v === "sweep",
};

/**
 * A theme's tokens as CSS custom properties, keeping only what is a known
 * token with a value of its kind — so nothing free-form (`url()`, a second
 * declaration) can reach a stylesheet, whoever wrote the theme.
 */
export function themeVariables(theme: Theme): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(theme.tokens)) {
    if (!(name in THEME_TOKENS) || typeof value !== "string") continue;
    const kind = THEME_TOKENS[name as ThemeToken];
    if (!VALID[kind](value.trim())) continue;
    out[`--${name}`] = kind === "font" ? THEME_FONTS[value as keyof typeof THEME_FONTS] : value.trim();
  }
  return out;
}

/** The theme a new install wears. */
export const DEFAULT_THEME_ID = "iracing";

/**
 * The look overlay.css draws with no theme at all: stacked near-black cards,
 * big light numbers, pill bars, a class-colour wash behind each position. Not
 * offered in the picker — the goOverlays community theme wears it — but kept
 * as a base, so a theme built on it gets exactly that and nothing else.
 * "exxeed" is its old name, from when it was the default, and still accepted.
 */
const CLASSIC: Theme = {
  id: "classic",
  name: "Classic",
  description: "The stylesheet's own look, with no theme applied.",
  tokens: {},
};

/** Themes offered in the picker, the default first. */
export const BUILTIN_THEMES: readonly Theme[] = [
  {
    id: "iracing",
    name: "iRacing",
    description: "The sim's own UI: dark navy boxes, gold labels, white monospace numbers, your row in gold.",
    // Colours sampled from iRacing's screenshots of the 2025 sim UI
    // (iracing.com/iracing-101-new-sim-ui): the black boxes, the results
    // table and the settings screen. The row layout that goes with it is in
    // overlay.css under [data-theme="iracing"].
    tokens: {
      // A black box: dark navy, nearly opaque, rounded, no edge.
      card: "rgba(27, 28, 36, 0.9)",
      "card-hi": "rgba(255, 255, 255, 0.08)",
      well: "rgba(255, 255, 255, 0.05)",
      line: "rgba(255, 255, 255, 0.06)",
      track: "rgba(255, 255, 255, 0.12)",
      radius: "6px",
      gap: "3px",
      "pill-radius": "3px",
      // Nothing in the sim's UI glows, and its colours are flatter than a row
      // of neon shift lights: keep them in the family.
      glow: "0px",
      "shift-strength": "0.72",

      text: "#ffffff",
      "text-2": "rgba(255, 255, 255, 0.72)",
      "text-3": "rgba(255, 255, 255, 0.45)",
      // Labels are gold, values white — "Elapsed  00:00:00".
      label: "#ffdf00",

      green: "#45d51f",
      mint: "#59ff53",
      red: "#d9191e",
      yellow: "#ffdf00",
      orange: "#ff9f1c",
      cyan: "#33ceff",
      purple: "#ae6bff",
      blue: "#1680f7",
      throttle: "#45d51f",
      brake: "#d9191e",
      // Your own row: gold text on a dark gold band.
      me: "#ffdf00",
      "me-text": "#ffdf00",
      road: "rgba(238, 238, 238, 0.96)",
      "road-edge": "rgba(20, 21, 28, 0.95)",

      font: "ui",
      "num-font": "mono",
      "num-weight": "600",
      "body-weight": "500",

      // "LAP TIMING", "RESULTS & STATS": gold bold caps, left-aligned, on the box itself.
      "title-bg": "rgba(27, 28, 36, 0.9)",
      "title-text": "#ffe500",
      "title-size": "13px",
      "title-weight": "700",
      "title-spacing": "0em",
      "title-case": "uppercase",
      "title-justify": "flex-start",
    },
  },
  {
    id: "gran-turismo",
    name: "Gran Turismo",
    description: "GT7's race screen: dark slate slabs, white type, your own row in light grey and gaps in red.",
    // Taken from GT7's race HUD: each row its own dark slate slab with a gap
    // of scene between, the position in a square box with a thin light edge,
    // your own row turned light grey with dark type, the gap to the car ahead
    // in a red box, captions in white capitals, and a white outline for the
    // course map. The shapes it cannot say in tokens are in overlay.css.
    tokens: {
      card: "rgba(22, 27, 33, 0.78)",
      "card-hi": "rgba(255, 255, 255, 0.05)",
      well: "rgba(0, 0, 0, 0.22)",
      line: "rgba(255, 255, 255, 0.07)",
      track: "rgba(255, 255, 255, 0.16)",
      "card-border": "0px solid transparent",
      radius: "0px",
      gap: "3px",
      "pill-radius": "0px",
      glow: "0px",
      // GT's tachometer: one curved line that fills white and flashes red at the shift point.
      "shift-style": "sweep",

      text: "#ffffff",
      "text-2": "rgba(255, 255, 255, 0.72)",
      "text-3": "rgba(255, 255, 255, 0.48)",
      label: "rgba(255, 255, 255, 0.92)",
      ink: "#ffffff",

      green: "#3ccf6b",
      mint: "#3ccf6b",
      red: "#d7141e",
      yellow: "#f2c230",
      orange: "#f07a12",
      cyan: "#3aa8f0",
      purple: "#b05cf0",
      blue: "#3aa8f0",
      throttle: "#3ccf6b",
      brake: "#d7141e",
      danger: "#e0141e",
      warm: "#f2c230",
      // Your own row: light grey with dark type, as GT marks the player.
      me: "#111418",
      "me-text": "#111418",
      "me-bg": "rgba(226, 228, 230, 0.94)",
      "chip-bg": "rgba(12, 15, 19, 0.92)",
      "chip-text": "#ffffff",
      "lap-ahead": "#ff4a4a",
      "lap-behind": "#5ab8ff",
      "fuel-empty": "rgba(255, 255, 255, 0.12)",
      // The course map: a white outline with the scene showing through.
      road: "rgba(16, 20, 24, 0.45)",
      "road-edge": "rgba(255, 255, 255, 0.98)",

      font: "ui",
      "num-font": "ui",
      "title-font": "condensed",
      "num-weight": "500",
      "body-weight": "500",

      // Captions sit on the scene in white capitals, the way POSITION and LAP do.
      "title-bg": "rgba(12, 15, 19, 0.88)",
      "title-text": "#ffffff",
      "title-size": "13px",
      "title-weight": "600",
      "title-spacing": "0.04em",
      "title-case": "uppercase",
      "title-justify": "flex-start",
    },
  },
  {
    id: "synthwave",
    name: "Synthwave",
    description: "Neon on black: cyan for throttle and time gained, pink for brake and time lost, glowing numbers and lines.",
    // An 80s neon palette on plain dark panels, so the colours do the work.
    // Good is cyan and bad is pink throughout, the same pair as the pedals.
    // The glow on text is in overlay.css under [data-theme="synthwave"].
    tokens: {
      card: "rgba(10, 10, 12, 0.82)",
      "card-hi": "rgba(255, 255, 255, 0.08)",
      well: "rgba(255, 255, 255, 0.06)",
      line: "rgba(255, 255, 255, 0.09)",
      track: "rgba(255, 255, 255, 0.12)",
      "card-border": "1px solid rgba(255, 255, 255, 0.1)",
      radius: "4px",
      gap: "4px",
      // Square-cut bars, not pills.
      "pill-radius": "2px",
      glow: "12px",
      "shift-strength": "1",

      text: "#ffffff",
      "text-2": "rgba(255, 255, 255, 0.66)",
      "text-3": "rgba(255, 255, 255, 0.42)",
      label: "#00f0ff",

      // Every "good" is neon cyan and every "bad" neon pink.
      green: "#00f0ff",
      mint: "#00f0ff",
      red: "#ff2bd6",
      yellow: "#f9f002",
      orange: "#ff6c11",
      cyan: "#00f0ff",
      purple: "#f15bff",
      danger: "#ff1744",
      // A warm tyre is violet, so the tread runs cyan to violet to pink with no green on the way.
      warm: "#a45cff",
      // Rev lights as a neon sweep, no traffic-light yellow: cyan, violet, pink, red.
      "shift-low": "#00f0ff",
      "shift-mid": "#a45cff",
      "shift-high": "#ff2bd6",
      "shift-max": "#ff1744",
      blue: "#5b8cff",
      throttle: "#00f0ff",
      brake: "#ff2bd6",
      // Your own row: white on a pink-to-cyan band (the band is in overlay.css).
      me: "#ff6ad5",
      "me-text": "#ffffff",
      "chip-bg": "rgba(0, 240, 255, 0.14)",
      "chip-text": "#9ff8ff",
      road: "rgba(232, 232, 238, 0.95)",
      "road-edge": "rgba(10, 10, 12, 0.95)",
      // Nothing keeps the sim's traffic-light colours: a car a lap up is pink,
      // a lap down violet, and licences run red, orange, yellow, cyan, violet.
      "lap-ahead": "#ff6ad5",
      "lap-behind": "#a45cff",
      "lic-r": "#ff1744",
      "lic-d": "#ff6c11",
      "lic-c": "#f9f002",
      "lic-b": "#00f0ff",
      "lic-a": "#a45cff",
      "lic-p": "#ffffff",
      // Classes in neon too, in place of the sim's pastels.
      "class-1": "#ff3355",
      "class-2": "#ff9a1f",
      "class-3": "#b967ff",
      "class-4": "#00f0ff",
      "class-5": "#b6ff3a",

      font: "future",
      "num-font": "digital",
      "title-font": "arcade",
      "num-weight": "700",
      "body-weight": "600",

      "title-bg": "rgba(10, 10, 12, 0.82)",
      "title-text": "#ff6ad5",
      "title-size": "11px",
      "title-weight": "400",
      "title-spacing": "0.1em",
      "title-case": "uppercase",
      "title-justify": "center",
    },
  },
];

/** The theme with this id, or the default when there is none (a removed or mistyped id). */
export const themeById = (id: string | null | undefined): Theme =>
  BUILTIN_THEMES.find((t) => t.id === id) ?? BUILTIN_THEMES[0]!;

/** Main → every overlay window: the theme changed. Payload: `ThemeView`. */
export const THEME_CHANNEL = "exxeed:theme";
/** Overlay window → main, invoke: the theme to start with. */
export const THEME_GET_CHANNEL = "exxeed:theme-get";

/** What an overlay window needs to wear a theme: its id and the variables to set. */
export interface ThemeView {
  readonly id: string;
  /** The row layout to use (`data-layout` in overlay.css). */
  readonly layout: ThemeLayout;
  /** The built-in this theme is built on, or its own id when it is one. */
  readonly base: string;
  readonly variables: Readonly<Record<string, string>>;
}

/** Everything a theme may name as its base: the built-ins and the classic look. */
const BASES: readonly Theme[] = [...BUILTIN_THEMES, CLASSIC];
/** Base ids a theme file may use, old names included. */
export const THEME_BASE_IDS: readonly string[] = [...BASES.map((t) => t.id), "exxeed"];
const baseById = (id: string): Theme | undefined => BASES.find((t) => t.id === (id === "exxeed" ? "classic" : id));

/** A theme's base built-in, or itself when it is one. */
const baseOf = (theme: Theme): Theme =>
  theme.base === undefined ? theme : (baseById(theme.base) ?? BUILTIN_THEMES[0]!);

export const themeView = (theme: Theme): ThemeView => {
  const base = baseOf(theme);
  return {
    id: theme.id,
    layout: theme.layout ?? BUILTIN_LAYOUT[base.id] ?? "wash",
    base: base.id,
    // The base's tokens first, the theme's own over them.
    variables: base === theme ? themeVariables(theme) : { ...themeVariables(base), ...themeVariables(theme) },
  };
};

// ---------------------------------------------------------------------------
// Custom themes: a JSON file a person writes (TODO M9, "JSON first").
// ---------------------------------------------------------------------------

/** What each kind of token accepts, in words — for error messages and the schema's hover text. */
const KIND_HELP: Record<TokenKind, string> = {
  color: 'a colour: "#rrggbb", "#rrggbbaa", "rgb(…)", "rgba(…)" or "transparent"',
  length: 'a length such as "8px" or "0.05em"',
  border: 'a border such as "1px solid rgba(255, 255, 255, 0.15)"',
  font: `one of ${Object.keys(THEME_FONTS).map((f) => `"${f}"`).join(", ")}`,
  weight: 'a font weight: "100" to "900"',
  number: 'a number from "0" to "1"',
  case: '"none" or "uppercase"',
  justify: '"center" or "flex-start"',
  shiftStyle: '"lights" or "sweep"',
};

export interface ParsedTheme {
  /** Null when the file is not usable at all (not JSON, not an object). */
  readonly theme: Theme | null;
  /** Everything wrong with it, in words a person can act on. Invalid tokens are dropped, not fatal. */
  readonly problems: readonly string[];
}

/**
 * A theme file's contents as a `Theme`. Forgiving: an unknown token or a bad
 * value is reported and skipped, so one typo does not take the whole theme
 * down while someone is editing it.
 */
export function parseTheme(text: string, id: string): ParsedTheme {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { theme: null, problems: [`not valid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { theme: null, problems: ["the file must be a JSON object"] };
  }
  const r = raw as Record<string, unknown>;
  const problems: string[] = [];

  let base = DEFAULT_THEME_ID;
  if (r["base"] !== undefined) {
    if (typeof r["base"] === "string" && baseById(r["base"]) !== undefined) base = baseById(r["base"])!.id;
    else problems.push(`"base" must be one of ${BASES.map((t) => `"${t.id}"`).join(", ")}`);
  }

  let layout: ThemeLayout | undefined;
  if (r["layout"] !== undefined) {
    if ((THEME_LAYOUTS as readonly unknown[]).includes(r["layout"])) layout = r["layout"] as ThemeLayout;
    else problems.push(`"layout" must be one of ${THEME_LAYOUTS.map((l) => `"${l}"`).join(", ")}`);
  }

  const tokens: Partial<Record<ThemeToken, string>> = {};
  const rawTokens = r["tokens"];
  if (rawTokens !== undefined && (typeof rawTokens !== "object" || rawTokens === null || Array.isArray(rawTokens))) {
    problems.push('"tokens" must be an object');
  } else if (rawTokens !== undefined) {
    for (const [name, value] of Object.entries(rawTokens as Record<string, unknown>)) {
      if (!(name in THEME_TOKENS)) {
        problems.push(`"${name}" is not a token`);
        continue;
      }
      const kind = THEME_TOKENS[name as ThemeToken];
      if (typeof value !== "string" || !VALID[kind](value.trim())) {
        problems.push(`"${name}" must be ${KIND_HELP[kind]}`);
        continue;
      }
      tokens[name as ThemeToken] = value.trim();
    }
  }

  const text60 = (v: unknown, fallback: string): string =>
    typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, 60) : fallback;

  return {
    theme: {
      id,
      name: text60(r["name"], id),
      description: typeof r["description"] === "string" ? r["description"].slice(0, 160) : "",
      base,
      ...(layout !== undefined ? { layout } : {}),
      ...(typeof r["author"] === "string" ? { author: r["author"].slice(0, 60) } : {}),
      tokens,
    },
    problems,
  };
}

/** A new theme file, starting as a copy of `from`: every token written out, ready to change. */
export function themeFileFor(from: Theme, name: string, schemaRef: string): string {
  const base = baseOf(from);
  return `${JSON.stringify(
    {
      $schema: schemaRef,
      name,
      description: `Based on ${from.name}.`,
      base: base.id,
      ...(from.layout !== undefined ? { layout: from.layout } : {}),
      tokens: base === from ? from.tokens : { ...base.tokens, ...from.tokens },
    },
    null,
    2,
  )}\n`;
}

/**
 * The JSON Schema for a theme file. Written next to the themes and named by
 * each file's `$schema`, so an editor that reads schemas (VS Code does)
 * completes token names, explains each one, and marks a bad value.
 */
export function themeJsonSchema(): Record<string, unknown> {
  const patterns: Partial<Record<TokenKind, Record<string, unknown>>> = {
    font: { enum: Object.keys(THEME_FONTS) },
    weight: { enum: ["100", "200", "300", "400", "500", "600", "700", "800", "900"] },
    case: { enum: ["none", "uppercase"] },
    justify: { enum: ["center", "flex-start"] },
    shiftStyle: { enum: ["lights", "sweep"] },
  };
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "Exxeed overlay theme",
    type: "object",
    additionalProperties: false,
    properties: {
      $schema: { type: "string" },
      name: { type: "string", maxLength: 60, description: "The name shown in the theme picker." },
      description: { type: "string", maxLength: 160 },
      author: { type: "string", maxLength: 60 },
      base: {
        enum: BASES.map((t) => t.id),
        description:
          "The theme this one starts from. Its tokens fill whatever you leave out, and its row layout is used. classic is the plain stylesheet look.",
      },
      layout: {
        enum: [...THEME_LAYOUTS],
        description:
          "How a row of Standings or Relatives is built. wash: the class colour bleeds in behind the position. chips: the car number in a class-coloured chip. blocks: a white position chip, the car number in a class-coloured block, striped rows. Left out, the base theme's.",
      },
      tokens: {
        type: "object",
        additionalProperties: false,
        description: "The values this theme changes. Leave a token out to keep the base theme's.",
        properties: Object.fromEntries(
          Object.entries(THEME_TOKENS).map(([name, kind]) => [
            name,
            { type: "string", description: `${TOKEN_HELP[name as ThemeToken]} Takes ${KIND_HELP[kind]}.`, ...(patterns[kind] ?? {}) },
          ]),
        ),
      },
    },
  };
}

/** What each token is for, for the schema's hover text. */
const TOKEN_HELP: Record<ThemeToken, string> = {
  card: "The background of a panel.",
  "card-hi": "A highlighted row or cell inside a panel.",
  well: "A slightly lighter inset area, such as a chart's background.",
  line: "Thin separators between rows.",
  track: "The empty part of a bar.",
  "card-border": "The edge around a panel.",
  text: "Main text and numbers.",
  "text-2": "Secondary text.",
  "text-3": "The faintest text.",
  label: 'Small captions beside a value ("GAP", "Last").',
  green: "Good: time gained, a personal best.",
  mint: "A second green, for accents and gains.",
  red: "Bad: time lost.",
  yellow: "Warnings and mid-range values.",
  orange: "Between yellow and red.",
  cyan: "A cool accent.",
  purple: "Fastest of the session.",
  blue: "Accent and selection.",
  throttle: "The throttle trace and bar.",
  brake: "The brake trace, bar and indicator.",
  warm: "Between good and bad, such as a tyre that is warm but not yet hot. Use #rrggbb.",
  danger: "The strongest warning: a car alongside on the radar, the rev lights' blink. Use #rrggbb.",
  "shift-low": "The first rev lights to come on. Use #rrggbb.",
  "shift-mid": "Rev lights a third of the way up. Use #rrggbb.",
  "shift-high": "Rev lights two thirds of the way up. Use #rrggbb.",
  "shift-max": "The last rev lights before the shift. Use #rrggbb.",
  me: "The highlight on your own row.",
  "me-text": "The text of your own row.",
  "me-bg": "A solid band behind your own row.",
  "chip-bg": "The background of the small chips in a row (iRating, lap count, PIT).",
  "chip-text": "The text of those chips.",
  road: "The track surface on the maps.",
  "road-edge": "The outline of the track on the maps.",
  ink: "Neutral lines on charts and dials: grid lines, the reference trace, the wheel. Use #rrggbb.",
  "fuel-empty": "The used part of the fuel bar.",
  "lap-ahead": "On Relatives, a car that is a lap ahead of you.",
  "lap-behind": "On Relatives, a car that is a lap behind you.",
  "lic-r": "The Rookie licence colour, in place of the sim's. Use #rrggbb.",
  "lic-d": "The D licence colour. Use #rrggbb.",
  "lic-c": "The C licence colour. Use #rrggbb.",
  "lic-b": "The B licence colour. Use #rrggbb.",
  "lic-a": "The A licence colour. Use #rrggbb.",
  "lic-p": "The Pro licence colour. Use #rrggbb.",
  "class-1": "The colour of the fastest class, in place of the sim's own. Use #rrggbb.",
  "class-2": "The colour of the second class. Use #rrggbb.",
  "class-3": "The colour of the third class. Use #rrggbb.",
  "class-4": "The colour of the fourth class. Use #rrggbb.",
  "class-5": "The colour of the fifth class. Use #rrggbb.",
  radius: "How rounded a panel's corners are.",
  gap: "The space between a panel's stacked boxes.",
  "pill-radius": "How rounded bars are. 99px is a pill, 0px is square.",
  glow: "How far lit things glow (shift lights, pedal knobs). 0px for none.",
  "shift-strength": "How strongly the shift lights are coloured. Lower is more muted.",
  "shift-style": "The rev lights as a row of lights, or as one curved line that fills white and flashes red at the shift point.",
  font: "The typeface for text.",
  "num-font": "The typeface for numbers.",
  "title-font": "The typeface for panel titles.",
  "num-weight": "How bold the big numbers are.",
  "body-weight": "How bold ordinary text is.",
  "title-bg": "The background of a panel's title strip.",
  "title-text": "The colour of a panel's title.",
  "title-size": "The size of a panel's title.",
  "title-weight": "How bold a panel's title is.",
  "title-spacing": "Letter spacing in a panel's title.",
  "title-case": "Whether a panel's title is in capitals.",
  "title-justify": "Whether a panel's title is centred or left-aligned.",
};
