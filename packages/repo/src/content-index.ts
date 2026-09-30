/**
 * `<dataDir>/content/index.json`: which local note sets are published content,
 * and at which version (schema and reasoning in @exxeed/core, content.ts).
 */

import { join } from "node:path";

import { ContentIndexSchema, ContentLinkSchema, type ContentLink } from "@exxeed/core";

import { readJson, writeJson } from "./local.js";

export class LocalContentIndex {
  constructor(private readonly root: string) {}

  #path(): string {
    return join(this.root, "content", "index.json");
  }

  async #read(): Promise<Record<string, ContentLink>> {
    const raw = await readJson(this.#path());
    return raw === null ? {} : ContentIndexSchema.parse(raw).entries;
  }

  async all(): Promise<Readonly<Record<string, ContentLink>>> {
    return this.#read();
  }

  async get(noteSetId: string): Promise<ContentLink | null> {
    return (await this.#read())[noteSetId] ?? null;
  }

  /** The local note set that holds this item, if any. */
  async findByItem(itemId: string): Promise<string | null> {
    const entry = Object.entries(await this.#read()).find(([, link]) => link.itemId === itemId);
    return entry?.[0] ?? null;
  }

  async put(noteSetId: string, link: ContentLink): Promise<void> {
    const entries = await this.#read();
    await writeJson(this.#path(), {
      schema: 1,
      entries: { ...entries, [noteSetId]: ContentLinkSchema.parse(link) },
    });
  }

  async remove(noteSetId: string): Promise<void> {
    const entries = { ...(await this.#read()) };
    delete entries[noteSetId];
    await writeJson(this.#path(), { schema: 1, entries });
  }
}
