/**
 * The Content tab — TODO.md M8 step 5.
 *
 * Answers the tab's questions: what is listed, what one item's page shows, and
 * starring. Installing goes through the library (library.ts), so an install from
 * here and one from a pasted link are the same code. Works signed out except
 * starring and the Starred filter.
 */

import { ipcMain, shell } from "electron";

import { describeDiff, pct, pctToIndex, type TrackKey } from "@exxeed/core";
import {
  CONTENT_CHANNEL,
  type ContentFacets,
  type ContentFilters,
  type ContentLocal,
  type ContentPage,
  type ContentRequest,
  type ContentRow,
  type Settings,
} from "@exxeed/overlays";
import {
  browse,
  browseRow,
  fetchMap,
  getVersionPayload,
  listFacets,
  listMedia,
  listVersions,
  LocalContentIndex,
  localRepositories,
  myStars,
  setStar,
  type BrowseRow,
} from "@exxeed/repo";

import { accountView, cloudClient } from "./account.js";
import { toMapView } from "./map-view.js";

interface ContentDeps {
  readonly getSettings: () => Settings;
  readonly resolveDataDir: (settings: Settings) => string;
}

const PAGE_SIZE = 30;

/** Links open the app on the pack (exxeed://, not yet registered) — and carry the id either way. */
export const shareLinkFor = (itemId: string): string => `exxeed://pack/${itemId}`;

async function localLinks(deps: ContentDeps): Promise<Map<string, ContentLocal>> {
  const entries = await new LocalContentIndex(deps.resolveDataDir(deps.getSettings())).all();
  return new Map(
    Object.entries(entries).map(([noteSetId, link]) => [
      link.itemId,
      { noteSetId, origin: link.origin, version: link.version, policy: link.policy },
    ]),
  );
}

async function starredIds(): Promise<Set<string>> {
  const view = accountView();
  if (!view.signedIn || view.userId === null) return new Set();
  return new Set(await myStars(cloudClient(), view.userId).catch(() => []));
}

const toRow = (row: BrowseRow, starred: Set<string>, local: Map<string, ContentLocal>): ContentRow => ({
  id: row.id,
  title: row.title,
  summary: row.summary,
  authorName: row.authorName,
  visibility: row.visibility,
  isOwner: row.authorId === accountView().userId,
  trackLabel: row.trackLabel,
  carClass: row.carClass,
  stars: row.stars,
  downloads: row.downloads,
  latestVersion: row.latestVersion,
  updatedAt: row.updatedAt,
  iconUrl: row.iconUrl,
  starred: starred.has(row.id),
  local: local.get(row.id) ?? null,
});

async function facets(): Promise<ContentFacets> {
  const { layouts, carClasses } = await listFacets(cloudClient(), accountView().userId);
  return {
    layouts: layouts.map((l) => ({ trackKey: l.trackKey as ContentFacets["layouts"][number]["trackKey"], label: l.label })),
    carClasses,
    signedIn: accountView().signedIn,
  };
}

async function list(deps: ContentDeps, filters: ContentFilters, offset: number): Promise<ContentRow[]> {
  const [starred, local] = await Promise.all([starredIds(), localLinks(deps)]);

  // Starred and Installed narrow to known ids; both together means both.
  let itemIds: string[] | null = null;
  if (filters.starred) itemIds = [...starred];
  if (filters.installed) {
    const here = [...local.entries()].filter(([, l]) => l.origin === "installed").map(([id]) => id);
    itemIds = itemIds === null ? here : itemIds.filter((id) => here.includes(id));
  }

  const rows = await browse(cloudClient(), {
    text: filters.text,
    trackKey: filters.trackKey as TrackKey | null,
    carClass: filters.carClass,
    itemIds,
    ownerId: accountView().userId,
    sort: filters.sort,
    limit: PAGE_SIZE,
    offset,
  });
  return rows.map((r) => toRow(r, starred, local));
}

async function page(deps: ContentDeps, itemId: string): Promise<ContentPage> {
  const client = cloudClient();
  const row = await browseRow(client, itemId);
  if (row === null) throw new Error("this pack is private, taken down, or does not exist");

  const [starred, local, versions, media, readme] = await Promise.all([
    starredIds(),
    localLinks(deps),
    listVersions(client, itemId),
    listMedia(client, itemId),
    client.from("content_items").select("readme").eq("id", itemId).maybeSingle(),
  ]);

  const latest = row.latestVersionId === null ? null : await getVersionPayload(client, row.latestVersionId);
  const latestRow = versions.find((v) => v.id === row.latestVersionId) ?? null;

  // The map from this machine if it has one, otherwise the shared one — read,
  // not stored: looking at a page is not driving the track.
  let map = null;
  if (row.trackKey !== null) {
    const repos = localRepositories(deps.resolveDataDir(deps.getSettings()));
    const version = await repos.trackMaps.latestVersion(row.trackKey);
    map =
      (version === null ? null : await repos.trackMaps.get({ ...row.trackKey, mapVersion: version })) ??
      (await fetchMap(client, row.trackKey).catch(() => null));
  }

  const callouts = [...(latest?.notes ?? [])]
    .sort((a, b) => a.pct - b.pct)
    .map((n) => ({ id: n.id, text: n.text, textShort: n.textShort, metresFromStart: Math.round(n.pct * (latest?.lengthM ?? 0)) }));

  return {
    ...toRow(row, starred, local),
    readme: (readme.data as { readme?: string } | null)?.readme ?? "",
    trackKey: row.trackKey as ContentPage["trackKey"],
    shareLink: shareLinkFor(itemId),
    screenshots: media.filter((m) => m.kind === "screenshot").map((m) => m.url),
    versions: versions.map((v) => ({
      id: v.id,
      version: v.version,
      changelog: v.changelog,
      changes: v.diff === null ? [] : describeDiff(v.diff),
      publishedAt: v.publishedAt,
      withdrawn: v.withdrawnAt !== null,
    })),
    callouts,
    map:
      map === null
        ? null
        : {
            ...toMapView(map, []),
            notes: (latest?.notes ?? []).map((n) => ({ id: n.id, index: pctToIndex(pct(n.pct), map.centreline.gridSize) })),
          },
    facts: {
      callouts: latest?.notes.length ?? 0,
      mapVersion: map?.trackRef.mapVersion ?? null,
      source:
        latest?.source.type === "youtube"
          ? { title: latest.source.title ?? null, url: latest.source.url ?? null, channel: latest.source.channel ?? null }
          : null,
      publishedAt: latestRow?.publishedAt ?? null,
    },
  };
}

async function star(itemId: string, on: boolean): Promise<number> {
  if (!accountView().signedIn) throw new Error("sign in to star packs");
  await setStar(cloudClient(), itemId, on);
  return (await browseRow(cloudClient(), itemId))?.stars ?? 0;
}

export function installContentIpc(deps: ContentDeps): void {
  ipcMain.handle(CONTENT_CHANNEL, async (_event, request: ContentRequest) => {
    try {
      switch (request.op) {
        case "facets":
          return { ok: true, value: await facets() };
        case "browse":
          return { ok: true, value: await list(deps, request.filters, request.offset) };
        case "page":
          return { ok: true, value: await page(deps, request.itemId) };
        case "star":
          return { ok: true, value: await star(request.itemId, request.on) };
        case "openExternal": {
          // https only: a description is a stranger's text, and file:, javascript:
          // or a custom protocol handler must not be one click away.
          const url = new URL(request.url);
          if (url.protocol !== "https:") throw new Error("only https links open from a pack page");
          await shell.openExternal(url.toString());
          return { ok: true, value: null };
        }
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
