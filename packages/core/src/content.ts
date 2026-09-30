/**
 * Local bookkeeping for published content — TODO.md M8 steps 3-4.
 *
 * Which local note sets are published content, and at which version. Kept
 * beside the note sets rather than inside them: a `NoteSet` is what gets
 * published, and "this copy was installed at v3 and is pinned" is a fact about
 * one machine — putting it in the note set would publish one person's install
 * state to everyone.
 */

import { z } from "zod";

export const ContentLinkSchema = z.object({
  /** The content item this note set belongs to. */
  itemId: z.string().uuid(),
  /** Mine to publish and edit, or someone else's that I installed. */
  origin: z.enum(["mine", "installed"]),
  /** The published version this copy matches; null for mine before its first publish. */
  version: z.number().int().positive().nullable(),
  versionId: z.string().uuid().nullable(),
  /** Installed only: take new versions when no session runs, or stay put. */
  policy: z.enum(["auto", "pinned"]).default("auto"),
});

export type ContentLink = z.infer<typeof ContentLinkSchema>;

export const ContentIndexSchema = z.object({
  schema: z.literal(1),
  /** Keyed by the local note set id. */
  entries: z.record(z.string(), ContentLinkSchema),
});

export type ContentIndex = z.infer<typeof ContentIndexSchema>;

export const ContentVisibilitySchema = z.enum(["private", "unlisted", "public"]);
export type ContentVisibility = z.infer<typeof ContentVisibilitySchema>;
