/**
 * Browsing Content — TODO.md M8 step 5.
 *
 * Everything here reads what anyone may read, signed out included, except
 * stars and media uploads, which need an account. Listing shows public items
 * only; unlisted ones are reachable by link (getItem) and never listed.
 */

import { randomUUID } from "node:crypto";

import { TrackMapSchema, type TrackKey, type TrackMap } from "@exxeed/core";

import type { CloudClient } from "./client.js";

const TIMEOUT_MS = 10000;
const timeout = (): AbortSignal => AbortSignal.timeout(TIMEOUT_MS);
const fail = (what: string, message: string): never => {
  throw new Error(`${what}: ${message}`);
};

export type BrowseSort = "stars" | "downloads" | "updated" | "new";

export interface BrowseQuery {
  /** Words to look for in the title, track and summary. */
  readonly text?: string;
  readonly trackKey?: TrackKey | null;
  readonly carClass?: string | null;
  /** Only these items — the starred or installed filter, resolved by the caller. */
  readonly itemIds?: readonly string[] | null;
  /**
   * The signed-in driver: their own packs are listed whatever their
   * visibility, so an unlisted or private pack can still be found by its
   * author. Everyone else's must be public.
   */
  readonly ownerId?: string | null;
  readonly sort: BrowseSort;
  readonly limit: number;
  readonly offset: number;
  /** Callout packs unless said otherwise; `theme` lists overlay themes (M9). */
  readonly kind?: "callouts" | "theme";
}

export interface BrowseRow {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly authorId: string;
  readonly authorName: string;
  readonly visibility: "private" | "unlisted" | "public";
  readonly trackLabel: string;
  readonly trackKey: TrackKey | null;
  readonly carClass: string | null;
  readonly stars: number;
  readonly downloads: number;
  readonly latestVersion: number | null;
  readonly latestVersionId: string | null;
  readonly updatedAt: string;
  readonly createdAt: string;
  /** Public URL, or null for the track-outline fallback. */
  readonly iconUrl: string | null;
}

const ORDER: Record<BrowseSort, "star_count" | "download_count" | "updated_at" | "created_at"> = {
  stars: "star_count",
  downloads: "download_count",
  updated: "updated_at",
  new: "created_at",
};

type Row = {
  id: string;
  title: string;
  summary: string;
  owner: string;
  visibility: string;
  track_label: string;
  sim: string | null;
  track_id: number | null;
  config_id: string | null;
  car_class: string | null;
  star_count: number;
  download_count: number;
  latest_version: number | null;
  latest_version_id: string | null;
  updated_at: string;
  created_at: string;
  icon_path: string | null;
  author: { display_name: string } | null;
};

export const mediaUrl = (client: CloudClient, path: string): string =>
  client.storage.from("content-media").getPublicUrl(path).data.publicUrl;

const toRow = (client: CloudClient, r: Row): BrowseRow => ({
  id: r.id,
  title: r.title,
  summary: r.summary,
  authorId: r.owner,
  authorName: r.author?.display_name ?? "unknown",
  visibility: r.visibility as BrowseRow["visibility"],
  trackLabel: r.track_label,
  trackKey:
    r.sim === null || r.track_id === null || r.config_id === null
      ? null
      : { sim: r.sim as TrackKey["sim"], trackId: r.track_id, configId: r.config_id },
  carClass: r.car_class,
  stars: r.star_count,
  downloads: r.download_count,
  latestVersion: r.latest_version,
  latestVersionId: r.latest_version_id,
  updatedAt: r.updated_at,
  createdAt: r.created_at,
  iconUrl: r.icon_path === null ? null : mediaUrl(client, r.icon_path),
});

const COLUMNS =
  "id, title, summary, owner, visibility, track_label, sim, track_id, config_id, car_class, star_count, download_count, latest_version, latest_version_id, updated_at, created_at, icon_path, author:profiles!content_items_owner_fkey(display_name)";

/** Listed callout packs: public, published, not taken down — plus the caller's own, whatever their visibility. */
export async function browse(client: CloudClient, query: BrowseQuery): Promise<BrowseRow[]> {
  if (query.itemIds !== undefined && query.itemIds !== null && query.itemIds.length === 0) return [];

  let request = client
    .from("content_items")
    .select(COLUMNS)
    .eq("kind", query.kind ?? "callouts")
    .eq("removed", false)
    .not("latest_version", "is", null);
  // The owner id is a uuid from the session, never typed text, so it is safe
  // to put in the filter string.
  request =
    query.ownerId != null && /^[0-9a-f-]{36}$/i.test(query.ownerId)
      ? request.or(`visibility.eq.public,owner.eq.${query.ownerId}`)
      : request.eq("visibility", "public");

  if (query.text !== undefined && query.text.trim() !== "") {
    request = request.textSearch("search", query.text.trim(), { type: "websearch", config: "simple" });
  }
  if (query.trackKey) {
    request = request
      .eq("sim", query.trackKey.sim)
      .eq("track_id", query.trackKey.trackId)
      .eq("config_id", query.trackKey.configId);
  }
  if (query.carClass) request = request.eq("car_class", query.carClass);
  if (query.itemIds) request = request.in("id", [...query.itemIds]);

  const { data, error } = await request
    .order(ORDER[query.sort], { ascending: false })
    // A stable second key, so paging through equal star counts neither
    // repeats nor skips.
    .order("id", { ascending: true })
    .range(query.offset, query.offset + query.limit - 1)
    .abortSignal(timeout());
  if (error !== null) fail("browse", error.message);
  return (data ?? []).map((r) => toRow(client, r as unknown as Row));
}

/** How many listed packs there are for a combo — the "N packs in Content" banner. */
export async function countForCombo(client: CloudClient, trackKey: TrackKey, carClass: string | null): Promise<number> {
  let request = client
    .from("content_items")
    .select("id", { count: "exact", head: true })
    .eq("kind", "callouts")
    .eq("visibility", "public")
    .eq("removed", false)
    .not("latest_version", "is", null)
    .eq("sim", trackKey.sim)
    .eq("track_id", trackKey.trackId)
    .eq("config_id", trackKey.configId);
  if (carClass !== null) request = request.eq("car_class", carClass);
  const { count, error } = await request.abortSignal(timeout());
  if (error !== null) fail("count", error.message);
  return count ?? 0;
}

/** One item's list row, author included — the page header. Null if not visible. */
export async function browseRow(client: CloudClient, itemId: string): Promise<BrowseRow | null> {
  const { data, error } = await client
    .from("content_items")
    .select(COLUMNS)
    .eq("id", itemId)
    .abortSignal(timeout())
    .maybeSingle();
  if (error !== null) fail("item", error.message);
  return data === null ? null : toRow(client, data as unknown as Row);
}

// ---------------------------------------------------------------------------
// Stars
// ---------------------------------------------------------------------------

export async function myStars(client: CloudClient, userId: string): Promise<string[]> {
  const { data, error } = await client.from("stars").select("item_id").eq("user_id", userId).abortSignal(timeout());
  if (error !== null) fail("stars", error.message);
  return (data ?? []).map((r) => r.item_id);
}

export async function setStar(client: CloudClient, itemId: string, on: boolean): Promise<void> {
  const { error } = on
    ? await client.from("stars").insert({ item_id: itemId }).abortSignal(timeout())
    : await client.from("stars").delete().eq("item_id", itemId).abortSignal(timeout());
  // Starring twice is already starred.
  if (error !== null && error.code !== "23505") fail("star", error.message);
}

// ---------------------------------------------------------------------------
// Filter menus
// ---------------------------------------------------------------------------

export interface Facets {
  readonly layouts: readonly LayoutOption[];
  readonly carClasses: readonly { id: string; name: string }[];
}

/**
 * The tracks and car classes that have listed packs — so every option in the
 * menus finds something. Built from the packs rather than the whole catalog: a
 * filter for a track nobody has written callouts for can only say "nothing
 * matches". (The full iRacing catalog also needs the Data API, whose OAuth
 * client ids iRacing has paused — see TODO M8.)
 */
export async function listFacets(client: CloudClient, ownerId: string | null): Promise<Facets> {
  let request = client
    .from("content_items")
    .select("sim, track_id, config_id, track_label, car_class")
    .eq("kind", "callouts")
    .eq("removed", false)
    .not("latest_version", "is", null);
  request =
    ownerId !== null && /^[0-9a-f-]{36}$/i.test(ownerId)
      ? request.or(`visibility.eq.public,owner.eq.${ownerId}`)
      : request.eq("visibility", "public");
  const [{ data, error }, classes] = await Promise.all([request.abortSignal(timeout()), listCarClasses(client)]);
  if (error !== null) fail("facets", error.message);

  const layouts = new Map<string, LayoutOption>();
  const classIds = new Set<string>();
  for (const r of data ?? []) {
    if (r.sim !== null && r.track_id !== null && r.config_id !== null) {
      const key = `${r.sim}:${r.track_id}:${r.config_id}`;
      if (!layouts.has(key)) {
        layouts.set(key, {
          trackKey: { sim: r.sim as TrackKey["sim"], trackId: r.track_id, configId: r.config_id },
          label: r.track_label || `Track ${r.track_id}`,
        });
      }
    }
    if (r.car_class !== null) classIds.add(r.car_class);
  }
  const named = new Map(classes.map((c) => [c.id, c.name]));
  return {
    layouts: [...layouts.values()].sort((a, b) => a.label.localeCompare(b.label)),
    carClasses: [...classIds]
      .map((id) => ({ id, name: named.get(id) ?? id.toUpperCase() }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export interface LayoutOption {
  readonly trackKey: TrackKey;
  readonly label: string;
  readonly trackName?: string;
  readonly configName?: string;
  /** Metres, as the catalog has it; null when nobody reported one. */
  readonly lengthM?: number | null;
}

export async function listLayouts(client: CloudClient): Promise<LayoutOption[]> {
  const { data, error } = await client
    .from("track_layouts")
    .select("sim, track_id, config_id, track_name, config_name, length_m")
    .order("track_name")
    .abortSignal(timeout());
  if (error !== null) fail("layouts", error.message);
  return (data ?? []).map((r) => ({
    trackKey: { sim: r.sim as TrackKey["sim"], trackId: r.track_id, configId: r.config_id },
    label: r.config_name === "" ? r.track_name : `${r.track_name} — ${r.config_name}`,
    trackName: r.track_name,
    configName: r.config_name,
    lengthM: r.length_m,
  }));
}

/** Every car the catalog knows, for matching an imported lap's car by name. */
export async function listCatalogCars(client: CloudClient): Promise<{ carId: string; name: string; classId: string | null }[]> {
  const { data, error } = await client.from("cars").select("car_id, name, class_id").order("name").abortSignal(timeout());
  if (error !== null) fail("cars", error.message);
  return (data ?? []).map((r) => ({ carId: r.car_id, name: r.name, classId: r.class_id }));
}

export async function listCarClasses(client: CloudClient): Promise<{ id: string; name: string }[]> {
  const { data, error } = await client.from("car_classes").select("class_id, name").order("name").abortSignal(timeout());
  if (error !== null) fail("car classes", error.message);
  return (data ?? []).map((r) => ({ id: r.class_id, name: r.name }));
}

/** The standing map for a layout, without storing it — for a page's Map tab. */
export async function fetchMap(client: CloudClient, key: TrackKey): Promise<TrackMap | null> {
  const { data, error } = await client
    .from("track_maps")
    .select("data")
    .eq("sim", key.sim)
    .eq("track_id", key.trackId)
    .eq("config_id", key.configId)
    .order("map_version", { ascending: false })
    .limit(1)
    .abortSignal(timeout());
  if (error !== null) fail("map", error.message);
  const row = data?.[0];
  return row === undefined ? null : TrackMapSchema.parse(row.data);
}

// ---------------------------------------------------------------------------
// Media: an icon and up to 8 screenshots per item
// ---------------------------------------------------------------------------

export const MAX_SCREENSHOTS = 8;

export interface MediaView {
  readonly id: string;
  readonly kind: "icon" | "screenshot";
  readonly path: string;
  readonly url: string;
}

export async function listMedia(client: CloudClient, itemId: string): Promise<MediaView[]> {
  const { data, error } = await client
    .from("content_media")
    .select("id, kind, path, position")
    .eq("item_id", itemId)
    .order("position")
    .abortSignal(timeout());
  if (error !== null) fail("media", error.message);
  return (data ?? []).map((m) => ({ id: m.id, kind: m.kind as MediaView["kind"], path: m.path, url: mediaUrl(client, m.path) }));
}

/**
 * Store an already re-encoded image (the caller strips metadata) and list it
 * on the item. An icon replaces the previous one.
 */
export async function uploadMedia(
  client: CloudClient,
  itemId: string,
  kind: "icon" | "screenshot",
  bytes: Uint8Array,
  contentType: "image/png" | "image/jpeg" | "image/webp",
): Promise<MediaView> {
  const existing = await listMedia(client, itemId);
  if (kind === "screenshot" && existing.filter((m) => m.kind === "screenshot").length >= MAX_SCREENSHOTS) {
    throw new Error(`at most ${MAX_SCREENSHOTS} screenshots`);
  }

  const ext = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
  const path = `items/${itemId}/${randomUUID()}.${ext}`;
  const { error: upload } = await client.storage.from("content-media").upload(path, bytes, { contentType });
  if (upload !== null) fail("upload", upload.message);

  const position = kind === "icon" ? 0 : existing.filter((m) => m.kind === "screenshot").length + 1;
  const { data, error } = await client
    .from("content_media")
    .insert({ item_id: itemId, kind, path, position })
    .select("id")
    .single();
  if (error !== null || data === null) return fail("media row", error?.message ?? "no row returned");

  if (kind === "icon") {
    const { error: iconError } = await client.from("content_items").update({ icon_path: path }).eq("id", itemId);
    if (iconError !== null) fail("icon", iconError.message);
    for (const old of existing.filter((m) => m.kind === "icon")) await removeMedia(client, old);
  }
  return { id: data.id, kind, path, url: mediaUrl(client, path) };
}

export async function removeMedia(client: CloudClient, media: Pick<MediaView, "id" | "path" | "kind">): Promise<void> {
  const { error } = await client.from("content_media").delete().eq("id", media.id);
  if (error !== null) fail("remove media", error.message);
  await client.storage.from("content-media").remove([media.path]);
}
