/**
 * Custom overlay themes on disk — TODO M9, "JSON first".
 *
 * A theme is a folder in `<userData>/themes/`:
 *
 *   <id>/theme.json             name, base, tokens
 *   <id>/theme.css              optional: a stylesheet over the built-in one
 *   <id>/templates/<panel>.html optional: how that overlay is built
 *
 * or, from before themes had more than tokens, a single `<id>.json` (which
 * can carry `css` and `templates` inline). Either is edited in whatever editor
 * its author likes. The folder is watched, so a save from VS Code restyles
 * the overlays as it lands, exactly as a save from anywhere else would. A
 * file that stops parsing keeps the last good version on screen and reports
 * what is wrong, rather than snapping the overlays back to the default
 * mid-edit.
 *
 * Built-in themes are not files and cannot be edited: "New theme" copies one
 * as a starting point, like VS Code's default settings.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";

import { app } from "electron";

import {
  BUILTIN_THEMES,
  isThemeFile,
  MAX_THEME_CSS,
  MAX_THEME_TEMPLATE,
  parseTheme,
  parseThemeAssets,
  themeFileFor,
  themeJsonSchema,
  type Theme,
} from "@exxeed/overlays";
import { slug } from "@exxeed/telemetry";

const SCHEMA_FILE = "theme.schema.json";

/** Where a theme file came from in Content, if anywhere. */
export interface ThemeLink {
  readonly itemId: string;
  readonly versionId: string;
  readonly version: number;
  /** `mine`: published from this file. `installed`: someone else's, downloaded. */
  readonly origin: "mine" | "installed";
}

const LINKS_FILE = ".links.json";
/** In a theme folder. */
const THEME_JSON = "theme.json";
const THEME_CSS = "theme.css";
const TEMPLATES_DIR = "templates";

/** A file's text, or undefined when it is missing or too large to be what it should. */
function readSmall(path: string, max: number): string | undefined {
  try {
    if (statSync(path).size > max * 4) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export interface CustomTheme {
  readonly theme: Theme;
  readonly problems: readonly string[];
}

export class ThemeStore {
  readonly dir: string;
  /** Last good parse per id, kept while its file is mid-edit and broken. */
  readonly #good = new Map<string, Theme>();
  #custom = new Map<string, CustomTheme>();
  /** Theme id → whether it is a folder (or an old single file). */
  #folder = new Map<string, boolean>();
  #watcher: FSWatcher | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(onChange: () => void, dir = join(app.getPath("userData"), "themes")) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    // The schema travels with the app's version of the tokens: rewritten on
    // every launch, so an editor's autocomplete is never behind.
    writeFileSync(join(dir, SCHEMA_FILE), `${JSON.stringify(themeJsonSchema(), null, 2)}\n`);
    this.#read();

    try {
      // Recursive: a save to a folder theme's stylesheet or a template is inside it.
      this.#watcher = watch(dir, { recursive: true }, () => {
        // Editors save in several steps (write a temp file, rename it): wait
        // for them to finish.
        if (this.#timer !== null) clearTimeout(this.#timer);
        this.#timer = setTimeout(() => {
          this.#read();
          onChange();
        }, 120);
      });
    } catch {
      // No watching on this filesystem: themes still load, just not live.
    }
  }

  #read(): void {
    const next = new Map<string, CustomTheme>();
    const folder = new Map<string, boolean>();
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === SCHEMA_FILE) continue;
      const isFolder = entry.isDirectory();
      if (!isFolder && !entry.name.endsWith(".json")) continue;
      const id = isFolder ? entry.name : entry.name.slice(0, -".json".length);
      // A theme named after a built-in would be unreachable in the picker.
      if (BUILTIN_THEMES.some((t) => t.id === id)) continue;
      // A folder holds the same theme a file would: the folder wins.
      if (!isFolder && next.has(id) && folder.get(id) === true) continue;
      const jsonPath = isFolder ? join(this.dir, id, THEME_JSON) : join(this.dir, entry.name);
      let text: string;
      try {
        text = readFileSync(jsonPath, "utf8");
      } catch {
        continue;
      }
      const parsed = parseTheme(text, id);
      let theme = parsed.theme;
      const problems = [...parsed.problems];
      if (theme !== null && isFolder) {
        const files = this.#folderAssets(id);
        problems.push(...files.problems);
        const css = [theme.css, files.css].filter((c) => c !== undefined).join("\n");
        const templates = { ...theme.templates, ...files.templates };
        theme = {
          ...theme,
          ...(css !== "" ? { css } : {}),
          ...(Object.keys(templates).length > 0 ? { templates } : {}),
        };
      }
      if (theme !== null) this.#good.set(id, theme);
      theme ??= this.#good.get(id) ?? null;
      // Never parsed, and still does not: listed by its name so it can be opened and fixed.
      next.set(id, {
        theme: theme ?? { id, name: id, description: "", base: BUILTIN_THEMES[0]!.id, tokens: {} },
        problems,
      });
      folder.set(id, isFolder);
    }
    this.#custom = next;
    this.#folder = folder;
  }

  /** A theme folder's theme.css and templates/*.html, checked. */
  #folderAssets(id: string): ReturnType<typeof parseThemeAssets> {
    const root = join(this.dir, id);
    const css = readSmall(join(root, THEME_CSS), MAX_THEME_CSS);
    const templates: Record<string, string> = {};
    try {
      for (const file of readdirSync(join(root, TEMPLATES_DIR))) {
        if (!file.endsWith(".html")) continue;
        const text = readSmall(join(root, TEMPLATES_DIR, file), MAX_THEME_TEMPLATE);
        if (text !== undefined) templates[file.slice(0, -".html".length)] = text;
      }
    } catch {
      // No templates folder: none of the overlays are rebuilt.
    }
    return parseThemeAssets(css, Object.keys(templates).length > 0 ? templates : undefined);
  }

  list(): readonly CustomTheme[] {
    return [...this.#custom.values()].sort((a, b) => a.theme.name.localeCompare(b.theme.name));
  }

  /** Built-in or custom; the default when the id is unknown (a deleted theme). */
  find(id: string | null | undefined): Theme {
    return (
      BUILTIN_THEMES.find((t) => t.id === id) ??
      (typeof id === "string" ? this.#custom.get(id)?.theme : undefined) ??
      BUILTIN_THEMES[0]!
    );
  }

  isCustom(id: string): boolean {
    return this.#custom.has(id);
  }

  /** The theme's JSON: theme.json in its folder, or its single file. */
  pathOf(id: string): string {
    return this.#folder.get(id) === false ? join(this.dir, `${id}.json`) : join(this.dir, id, THEME_JSON);
  }

  /** Where the theme lives: its folder, or its single file. */
  locationOf(id: string): string {
    return this.#folder.get(id) === false ? join(this.dir, `${id}.json`) : join(this.dir, id);
  }

  #taken(id: string): boolean {
    return existsSync(join(this.dir, id)) || existsSync(join(this.dir, `${id}.json`)) || BUILTIN_THEMES.some((t) => t.id === id);
  }

  /** A new theme file copied from `from`. Returns its id. */
  create(from: Theme, name: string): string {
    const base = slug(name) || "my-theme";
    let id = base;
    for (let n = 2; this.#taken(id); n++) id = `${base}-${n}`;
    // A folder, so a stylesheet and templates can go beside it. The schema
    // path is relative, so the themes folder can be moved or shared whole.
    mkdirSync(join(this.dir, id, TEMPLATES_DIR), { recursive: true });
    writeFileSync(join(this.dir, id, THEME_JSON), themeFileFor(from, name, `../${SCHEMA_FILE}`));
    this.#read();
    return id;
  }

  remove(id: string): void {
    if (!this.isCustom(id)) return;
    rmSync(this.locationOf(id), { recursive: true, force: true });
    this.#good.delete(id);
    this.link(id, null);
    this.#read();
  }

  /** The parsed theme and what is wrong with its file, or null when there is no such custom theme. */
  get(id: string): CustomTheme | null {
    return this.#custom.get(id) ?? null;
  }

  /**
   * Write a theme downloaded from Content as a file of its own. `preferredId`
   * is reused when given (an update), otherwise a free id is made from the name.
   */
  install(theme: Theme, preferredId: string | null): string {
    let id = preferredId;
    if (id === null) {
      const base = slug(theme.name) || "theme";
      id = base;
      for (let n = 2; this.#taken(id); n++) id = `${base}-${n}`;
    }
    // Always as a folder; an update to a theme installed as a single file moves it into one.
    rmSync(join(this.dir, `${id}.json`), { force: true });
    const root = join(this.dir, id);
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, TEMPLATES_DIR), { recursive: true });
    const file = {
      $schema: `../${SCHEMA_FILE}`,
      name: theme.name,
      description: theme.description,
      ...(theme.author !== undefined ? { author: theme.author } : {}),
      base: theme.base ?? BUILTIN_THEMES[0]!.id,
      ...(theme.layout !== undefined ? { layout: theme.layout } : {}),
      tokens: theme.tokens,
    };
    writeFileSync(join(root, THEME_JSON), `${JSON.stringify(file, null, 2)}\n`);
    if (theme.css !== undefined) writeFileSync(join(root, THEME_CSS), theme.css);
    for (const [panel, text] of Object.entries(theme.templates ?? {})) {
      writeFileSync(join(root, TEMPLATES_DIR, `${panel}.html`), text);
    }
    this.#read();
    return id;
  }

  /** Where one of a custom theme's files is: its JSON, or a file in its folder. */
  #fileOf(id: string, file: string): string {
    if (!isThemeFile(file)) throw new Error(`"${file}" is not a theme file — theme.json, theme.css or templates/<overlay>.html`);
    return file === THEME_JSON ? this.pathOf(id) : join(this.dir, id, file);
  }

  /** The files a custom theme is made of, theme.json first and templates last. */
  files(id: string): string[] {
    if (!this.isCustom(id)) return [];
    const out = [THEME_JSON];
    if (this.#folder.get(id) !== true) return out;
    if (existsSync(join(this.dir, id, THEME_CSS))) out.push(THEME_CSS);
    try {
      for (const f of readdirSync(join(this.dir, id, TEMPLATES_DIR)).sort()) {
        const path = `${TEMPLATES_DIR}/${f}`;
        if (isThemeFile(path)) out.push(path);
      }
    } catch {
      // No templates.
    }
    return out;
  }

  /** A custom theme's file as text, for editing. Null when there is no such theme or file. */
  readText(id: string, file = THEME_JSON): string | null {
    if (!this.isCustom(id)) return null;
    try {
      return readFileSync(this.#fileOf(id, file), "utf8");
    } catch {
      return null;
    }
  }

  /**
   * Save edited text and re-read it. Whatever the text is: a half-typed file
   * is still the author's file, and the last good version stays on screen
   * until it parses again. Returns what is wrong with the theme.
   */
  writeText(id: string, text: string, file = THEME_JSON): readonly string[] {
    if (!this.isCustom(id)) return ["no such theme"];
    if (file !== THEME_JSON && this.#folder.get(id) !== true) return ["this theme is a single file: add a stylesheet or template to it first"];
    writeFileSync(this.#fileOf(id, file), text);
    this.#read();
    return this.#custom.get(id)?.problems ?? [];
  }

  /** Add a stylesheet or template, starting as `text`; a single-file theme becomes a folder first. */
  addFile(id: string, file: string, text: string): void {
    if (!this.isCustom(id)) throw new Error("only a theme of your own can be edited");
    if (file === THEME_JSON) throw new Error("every theme has a theme.json already");
    this.#toFolder(id);
    const path = this.#fileOf(id, file);
    mkdirSync(join(this.dir, id, TEMPLATES_DIR), { recursive: true });
    // Never over an existing file: that would throw away someone's work.
    if (!existsSync(path)) writeFileSync(path, text);
    this.#read();
  }

  removeFile(id: string, file: string): void {
    if (!this.isCustom(id) || file === THEME_JSON || this.#folder.get(id) !== true) return;
    rmSync(this.#fileOf(id, file), { force: true });
    this.#read();
  }

  /** Move a single-file theme into a folder of its own, keeping its id. */
  #toFolder(id: string): void {
    if (this.#folder.get(id) === true) return;
    const single = join(this.dir, `${id}.json`);
    const text = readFileSync(single, "utf8");
    mkdirSync(join(this.dir, id, TEMPLATES_DIR), { recursive: true });
    // Its $schema path now has a folder to climb out of.
    writeFileSync(join(this.dir, id, THEME_JSON), text.replace('"./theme.schema.json"', `"../${SCHEMA_FILE}"`));
    rmSync(single, { force: true });
    this.#read();
  }

  /** Theme id → where it came from in Content. */
  links(): Record<string, ThemeLink> {
    try {
      const raw: unknown = JSON.parse(readFileSync(join(this.dir, LINKS_FILE), "utf8"));
      return typeof raw === "object" && raw !== null ? (raw as Record<string, ThemeLink>) : {};
    } catch {
      return {};
    }
  }

  link(id: string, link: ThemeLink | null): void {
    const all = this.links();
    if (link === null) delete all[id];
    else all[id] = link;
    writeFileSync(join(this.dir, LINKS_FILE), `${JSON.stringify(all, null, 2)}\n`);
  }

  close(): void {
    this.#watcher?.close();
    if (this.#timer !== null) clearTimeout(this.#timer);
  }
}
