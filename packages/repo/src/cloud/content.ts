/**
 * Published content: callout packs now, themes in M9 — TODO.md M8 steps 3-3b.
 *
 * Row shapes stay in here; callers get plain objects and domain types. The
 * rules (who may publish, version numbering, refusing dirty notes) are the
 * server's — see supabase/migrations/…_content.sql — and this module only
 * asks.
 */

import { NoteSetSchema, type ContentVisibility, type NoteSet, type NoteSetDiff, type TrackKey } from "@exxeed/core";

import type { CloudClient } from "./client.js";
import type { Json } from "./db.generated.js";

/** Writes can carry a whole note set, so they get longer than sync's reads. */
const TIMEOUT_MS = 15000;
const timeout = (): AbortSignal => AbortSignal.timeout(TIMEOUT_MS);

export interface ItemFields {
  readonly title: string;
  readonly summary: string;
  readonly readme: string;
  readonly visibility: ContentVisibility;
}

export interface ItemView extends ItemFields {
  readonly id: string;
  readonly ownerId: string;
  readonly trackKey: TrackKey | null;
  readonly carClass: string | null;
  readonly trackLabel: string;
  readonly starCount: number;
  readonly downloadCount: number;
  readonly latestVersion: number | null;
  readonly latestVersionId: string | null;
  readonly removed: boolean;
  readonly updatedAt: string;
}

export interface VersionView {
  readonly id: string;
  readonly version: number;
  readonly changelog: string;
  readonly diff: NoteSetDiff | null;
  readonly downloadCount: number;
  readonly publishedAt: string;
  readonly withdrawnAt: string | null;
}

const ITEM_COLUMNS =
  "id, owner, title, summary, readme, visibility, sim, track_id, config_id, car_class, track_label, star_count, download_count, latest_version, latest_version_id, removed, updated_at";

type ItemRow = {
  id: string;
  owner: string;
  title: string;
  summary: string;
  readme: string;
  visibility: string;
  sim: string | null;
  track_id: number | null;
  config_id: string | null;
  car_class: string | null;
  track_label: string;
  star_count: number;
  download_count: number;
  latest_version: number | null;
  latest_version_id: string | null;
  removed: boolean;
  updated_at: string;
};

const toItem = (row: ItemRow): ItemView => ({
  id: row.id,
  ownerId: row.owner,
  title: row.title,
  summary: row.summary,
  readme: row.readme,
  visibility: row.visibility as ContentVisibility,
  trackKey:
    row.sim === null || row.track_id === null || row.config_id === null
      ? null
      : { sim: row.sim as TrackKey["sim"], trackId: row.track_id, configId: row.config_id },
  carClass: row.car_class,
  trackLabel: row.track_label,
  starCount: row.star_count,
  downloadCount: row.download_count,
  latestVersion: row.latest_version,
  latestVersionId: row.latest_version_id,
  removed: row.removed,
  updatedAt: row.updated_at,
});

const fail = (what: string, message: string): never => {
  throw new Error(`${what}: ${message}`);
};

/** A new callout pack, owned by the signed-in driver. Private until published. */
export async function createCalloutItem(
  client: CloudClient,
  fields: ItemFields,
  trackKey: TrackKey,
  carClass: string,
): Promise<ItemView> {
  const { data, error } = await client
    .from("content_items")
    .insert({
      kind: "callouts",
      title: fields.title,
      summary: fields.summary,
      readme: fields.readme,
      visibility: fields.visibility,
      sim: trackKey.sim,
      track_id: trackKey.trackId,
      config_id: trackKey.configId,
      car_class: carClass,
    })
    .select(ITEM_COLUMNS)
    .abortSignal(timeout())
    .single();
  if (error !== null) fail("create item", error.message);
  return toItem(data as unknown as ItemRow);
}

export async function updateItem(client: CloudClient, itemId: string, fields: ItemFields): Promise<ItemView> {
  const { data, error } = await client
    .from("content_items")
    .update({ title: fields.title, summary: fields.summary, readme: fields.readme, visibility: fields.visibility })
    .eq("id", itemId)
    .select(ITEM_COLUMNS)
    .abortSignal(timeout())
    .single();
  if (error !== null) fail("update item", error.message);
  return toItem(data as unknown as ItemRow);
}

/** Null when it does not exist or the caller may not see it. */
export async function getItem(client: CloudClient, itemId: string): Promise<ItemView | null> {
  const { data, error } = await client
    .from("content_items")
    .select(ITEM_COLUMNS)
    .eq("id", itemId)
    .abortSignal(timeout())
    .maybeSingle();
  if (error !== null) fail("get item", error.message);
  return data === null ? null : toItem(data as unknown as ItemRow);
}

/** Newest first. */
export async function listVersions(client: CloudClient, itemId: string): Promise<VersionView[]> {
  const { data, error } = await client
    .from("content_versions")
    .select("id, version, changelog, diff, download_count, published_at, withdrawn_at")
    .eq("item_id", itemId)
    .order("version", { ascending: false })
    .abortSignal(timeout());
  if (error !== null) fail("list versions", error.message);
  return (data ?? []).map((row) => ({
    id: row.id,
    version: row.version,
    changelog: row.changelog,
    diff: row.diff as unknown as NoteSetDiff | null,
    downloadCount: row.download_count,
    publishedAt: row.published_at,
    withdrawnAt: row.withdrawn_at,
  }));
}

/** A published version's note set, validated like a file from disk. */
export async function getVersionPayload(client: CloudClient, versionId: string): Promise<NoteSet | null> {
  const { data, error } = await client
    .from("content_versions")
    .select("payload")
    .eq("id", versionId)
    .abortSignal(timeout())
    .maybeSingle();
  if (error !== null) fail("get version", error.message);
  return data === null ? null : NoteSetSchema.parse(data.payload);
}

export interface PublishRequest {
  readonly itemId: string;
  readonly noteSet: NoteSet;
  readonly changelog: string;
  readonly diff: NoteSetDiff | null;
  readonly mapVersion: number | null;
  readonly voiceId: string | null;
}

/** Publish the next version. The server numbers it and refuses dirty notes. */
export async function publishVersion(client: CloudClient, request: PublishRequest): Promise<{ id: string; version: number }> {
  const { data, error } = await client
    .rpc("publish_version", {
      p_item_id: request.itemId,
      p_payload: request.noteSet as unknown as Json,
      p_changelog: request.changelog,
      p_diff: request.diff as unknown as Json,
      p_map_version: request.mapVersion as number,
      p_voice_id: request.voiceId as string,
    })
    .abortSignal(timeout());
  if (error !== null) fail("publish", error.message);
  const row = data as unknown as { id: string; version: number };
  return { id: row.id, version: row.version };
}

export async function withdrawVersion(client: CloudClient, versionId: string): Promise<void> {
  const { error } = await client.rpc("withdraw_version", { p_version_id: versionId }).abortSignal(timeout());
  if (error !== null) fail("withdraw", error.message);
}

/** The owner's working copy, private to them — how a draft reaches their other machines. */
export async function saveDraft(client: CloudClient, itemId: string, noteSet: NoteSet): Promise<void> {
  const { error } = await client
    .from("content_drafts")
    .upsert({ item_id: itemId, payload: noteSet as unknown as { [key: string]: Json }, updated_at: new Date().toISOString() })
    .abortSignal(timeout());
  if (error !== null) fail("save draft", error.message);
}
