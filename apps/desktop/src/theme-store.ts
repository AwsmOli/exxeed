/**
 * Custom overlay themes on disk — TODO M9, "JSON first".
 *
 * A theme is a JSON file in `<userData>/themes/`, edited in whatever editor
 * its author likes. The folder is watched, so a save from VS Code restyles
 * the overlays as it lands, exactly as a save from anywhere else would. A
 * file that stops parsing keeps the last good version on screen and reports
 * what is wrong, rather than snapping the overlays back to the default
 * mid-edit.
 *
 * Built-in themes are not files and cannot be edited: "New theme" copies one
 * as a starting point, like VS Code's default settings.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";

import { app } from "electron";

import {
  BUILTIN_THEMES,
  parseTheme,
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

export interface CustomTheme {
  readonly theme: Theme;
  readonly problems: readonly string[];
}

export class ThemeStore {
  readonly dir: string;
  /** Last good parse per id, kept while its file is mid-edit and broken. */
  readonly #good = new Map<string, Theme>();
  #custom = new Map<string, CustomTheme>();
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
      this.#watcher = watch(dir, () => {
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
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith(".json") || file === SCHEMA_FILE || file.startsWith(".")) continue;
      const id = file.slice(0, -".json".length);
      // A file named after a built-in would be unreachable in the picker.
      if (BUILTIN_THEMES.some((t) => t.id === id)) continue;
      let text: string;
      try {
        text = readFileSync(join(this.dir, file), "utf8");
      } catch {
        continue;
      }
      const parsed = parseTheme(text, id);
      if (parsed.theme !== null) this.#good.set(id, parsed.theme);
      const theme = parsed.theme ?? this.#good.get(id) ?? null;
      // Never parsed, and still does not: listed by its file name so it can be opened and fixed.
      next.set(id, {
        theme: theme ?? { id, name: id, description: "", base: BUILTIN_THEMES[0]!.id, tokens: {} },
        problems: parsed.problems,
      });
    }
    this.#custom = next;
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

  pathOf(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  /** A new theme file copied from `from`. Returns its id. */
  create(from: Theme, name: string): string {
    const base = slug(name) || "my-theme";
    let id = base;
    for (let n = 2; existsSync(this.pathOf(id)) || BUILTIN_THEMES.some((t) => t.id === id); n++) id = `${base}-${n}`;
    // Relative, so the folder can be moved or shared with its schema beside it.
    writeFileSync(this.pathOf(id), themeFileFor(from, name, `./${SCHEMA_FILE}`));
    this.#read();
    return id;
  }

  remove(id: string): void {
    if (!this.isCustom(id)) return;
    rmSync(this.pathOf(id), { force: true });
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
      for (let n = 2; existsSync(this.pathOf(id)) || BUILTIN_THEMES.some((t) => t.id === id); n++) id = `${base}-${n}`;
    }
    const file = {
      $schema: `./${SCHEMA_FILE}`,
      name: theme.name,
      description: theme.description,
      ...(theme.author !== undefined ? { author: theme.author } : {}),
      base: theme.base ?? BUILTIN_THEMES[0]!.id,
      ...(theme.layout !== undefined ? { layout: theme.layout } : {}),
      tokens: theme.tokens,
    };
    writeFileSync(this.pathOf(id), `${JSON.stringify(file, null, 2)}\n`);
    this.#read();
    return id;
  }

  /** A custom theme's file as text, for editing. Null when there is no such theme. */
  readText(id: string): string | null {
    if (!this.isCustom(id)) return null;
    try {
      return readFileSync(this.pathOf(id), "utf8");
    } catch {
      return null;
    }
  }

  /**
   * Save edited text and re-read it. Whatever the text is: a half-typed file
   * is still the author's file, and the last good version stays on screen
   * until it parses again. Returns what is wrong with it.
   */
  writeText(id: string, text: string): readonly string[] {
    if (!this.isCustom(id)) return ["no such theme"];
    writeFileSync(this.pathOf(id), text);
    this.#read();
    return this.#custom.get(id)?.problems ?? [];
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
