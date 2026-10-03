/**
 * Themes in Content — TODO M9 step 3.
 *
 * A custom theme is a file (theme-store.ts). This publishes one as a content
 * item, and installs other people's as files of the same kind, so an
 * installed theme is edited, deleted and worn exactly like one written here.
 *
 * What comes down from the server is a stranger's JSON. It goes through
 * `parseTheme` before it is written anywhere: only known tokens with values of
 * their kind survive, so an installed theme can set colours and shapes and
 * nothing else.
 */

import { ipcMain } from "electron";

import {
  BUILTIN_THEMES,
  parseTheme,
  themeJsonSchema,
  THEME_CONTENT_CHANNEL,
  THEME_TOKENS,
  type Settings,
  type ThemeContentPage,
  type ThemeContentRequest,
  type ThemeContentRow,
  type ThemePublishState,
  type ThemeToken,
} from "@exxeed/overlays";
import {
  browse,
  browseRow,
  createThemeItem,
  getItem,
  getThemePayload,
  listMedia,
  listVersions,
  myStars,
  publishThemeVersion,
  recordDownload,
  removeMedia,
  updateItem,
  uploadMedia,
  type BrowseRow,
} from "@exxeed/repo";

import { accountView, cloudClient } from "./account.js";
import { pickImage } from "./publish.js";
import type { ThemeLink, ThemeStore } from "./theme-store.js";

interface ThemeContentDeps {
  readonly themes: () => ThemeStore;
  readonly getSettings: () => Settings;
  /** Wear a theme, by id. */
  readonly apply: (themeId: string) => void;
}

const PAGE_SIZE = 30;
const MAX_SCREENSHOTS = 6;

/** Item id → the theme file it is on this machine. */
function localByItem(store: ThemeStore): Map<string, { themeId: string } & ThemeLink> {
  return new Map(Object.entries(store.links()).map(([themeId, link]) => [link.itemId, { themeId, ...link }]));
}

async function starredIds(): Promise<Set<string>> {
  const view = accountView();
  if (!view.signedIn || view.userId === null) return new Set();
  return new Set(await myStars(cloudClient(), view.userId).catch(() => []));
}

function toRow(deps: ThemeContentDeps, row: BrowseRow, starred: Set<string>): ThemeContentRow {
  const local = localByItem(deps.themes()).get(row.id) ?? null;
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    authorName: row.authorName,
    visibility: row.visibility,
    isOwner: row.authorId === accountView().userId,
    stars: row.stars,
    downloads: row.downloads,
    latestVersion: row.latestVersion,
    updatedAt: row.updatedAt,
    iconUrl: row.iconUrl,
    starred: starred.has(row.id),
    local: local === null ? null : { themeId: local.themeId, version: local.version, origin: local.origin },
    inUse: local !== null && deps.getSettings().overlayTheme === local.themeId,
  };
}

async function list(
  deps: ThemeContentDeps,
  request: Extract<ThemeContentRequest, { op: "browse" }>,
): Promise<ThemeContentRow[]> {
  const starred = await starredIds();
  let itemIds: string[] | null = null;
  if (request.starred) itemIds = [...starred];
  if (request.installed) {
    const here = [...localByItem(deps.themes()).keys()];
    itemIds = itemIds === null ? here : itemIds.filter((id) => here.includes(id));
  }
  const rows = await browse(cloudClient(), {
    kind: "theme",
    text: request.text,
    itemIds,
    ownerId: accountView().userId,
    sort: request.sort,
    limit: PAGE_SIZE,
    offset: request.offset,
  });
  return rows.map((r) => toRow(deps, r, starred));
}

async function page(deps: ThemeContentDeps, itemId: string): Promise<ThemeContentPage> {
  const client = cloudClient();
  const row = await browseRow(client, itemId);
  if (row === null) throw new Error("this theme is private, taken down, or does not exist");

  const [starred, versions, media, item] = await Promise.all([
    starredIds(),
    listVersions(client, itemId),
    listMedia(client, itemId),
    getItem(client, itemId),
  ]);
  const payload = row.latestVersionId === null ? null : await getThemePayload(client, row.latestVersionId);
  const theme = payload === null ? null : parseTheme(JSON.stringify(payload), "preview").theme;
  const tokens = Object.entries(theme?.tokens ?? {});

  return {
    ...toRow(deps, row, starred),
    readme: item?.readme ?? "",
    screenshots: media.filter((m) => m.kind === "screenshot").map((m) => m.url),
    versions: versions
      .filter((v) => v.withdrawnAt === null)
      .map((v) => ({ version: v.version, changelog: v.changelog, publishedAt: v.publishedAt })),
    baseName: BUILTIN_THEMES.find((t) => t.id === theme?.base)?.name ?? BUILTIN_THEMES[0]!.name,
    swatches: tokens
      .filter(([name]) => THEME_TOKENS[name as ThemeToken] === "color")
      .map(([name, value]) => ({ name, value: value as string })),
    tokenCount: tokens.length,
  };
}

async function install(deps: ThemeContentDeps, itemId: string): Promise<string> {
  const client = cloudClient();
  const row = await browseRow(client, itemId);
  if (row?.latestVersionId == null || row.latestVersion === null) throw new Error("this theme has no published version");

  const payload = await getThemePayload(client, row.latestVersionId);
  const parsed = parseTheme(JSON.stringify(payload), "incoming");
  if (parsed.theme === null) throw new Error(`this theme cannot be read: ${parsed.problems[0] ?? "unknown problem"}`);

  const store = deps.themes();
  const existing = localByItem(store).get(itemId) ?? null;
  // Your own published theme is the file you are editing: never overwritten by its own published copy.
  if (existing?.origin === "mine") {
    deps.apply(existing.themeId);
    return `${row.title} is your own theme — now in use`;
  }

  const themeId = store.install(
    { ...parsed.theme, name: row.title, author: parsed.theme.author ?? row.authorName },
    existing?.themeId ?? null,
  );
  store.link(themeId, { itemId, versionId: row.latestVersionId, version: row.latestVersion, origin: "installed" });
  deps.apply(themeId);

  const installationId = deps.getSettings().installationId;
  if (installationId !== null) await recordDownload(client, row.latestVersionId, installationId).catch(() => undefined);

  const skipped = parsed.problems.length;
  return `${row.title} v${row.latestVersion} installed and in use${skipped > 0 ? ` (${skipped} setting${skipped === 1 ? "" : "s"} this version of the app does not know were left out)` : ""}`;
}

function uninstall(deps: ThemeContentDeps, itemId: string): string {
  const store = deps.themes();
  const local = localByItem(store).get(itemId) ?? null;
  if (local === null) return "not installed";
  if (local.origin === "mine") throw new Error("this is your own theme — delete it from the Overlays tab if you mean to");
  const wasInUse = deps.getSettings().overlayTheme === local.themeId;
  store.remove(local.themeId);
  if (wasInUse) deps.apply(BUILTIN_THEMES[0]!.id);
  return "theme removed";
}

async function publishState(deps: ThemeContentDeps, themeId: string): Promise<ThemePublishState> {
  const custom = deps.themes().get(themeId);
  if (custom === null) throw new Error("only a theme of your own can be published — use New… to make one");
  const link = deps.themes().links()[themeId] ?? null;
  const signedIn = accountView().signedIn;

  let item: ThemePublishState["item"] = null;
  if (link?.origin === "mine" && signedIn) {
    const client = cloudClient();
    const [found, media] = await Promise.all([getItem(client, link.itemId), listMedia(client, link.itemId)]);
    if (found !== null) {
      item = {
        id: found.id,
        title: found.title,
        summary: found.summary,
        readme: found.readme,
        visibility: found.visibility,
        version: found.latestVersion,
        screenshots: media.filter((m) => m.kind === "screenshot").map((m) => ({ id: m.id, url: m.url })),
      };
    }
  }
  return {
    signedIn,
    themeName: custom.theme.name,
    problems: custom.problems,
    installed: link?.origin === "installed",
    item,
  };
}

async function publish(
  deps: ThemeContentDeps,
  request: Extract<ThemeContentRequest, { op: "publish" }>,
): Promise<string> {
  if (!accountView().signedIn) throw new Error("sign in to publish a theme");
  const store = deps.themes();
  const custom = store.get(request.themeId);
  if (custom === null) throw new Error("only a theme of your own can be published");
  if (custom.problems.length > 0) throw new Error(`fix the theme file first: ${custom.problems[0]}`);
  const link = store.links()[request.themeId] ?? null;
  if (link?.origin === "installed") throw new Error("this theme is someone else's — make your own copy with New… to publish it");

  const title = request.title.trim();
  if (title === "") throw new Error("give the theme a title");
  const fields = { title, summary: request.summary.trim(), readme: request.readme, visibility: request.visibility };

  const client = cloudClient();
  const item = link === null ? await createThemeItem(client, fields) : await updateItem(client, link.itemId, fields);

  // Only what a theme is: its name, base and validated tokens. Not the file's
  // `$schema` path or anything else that happens to be in it.
  const { theme } = custom;
  const payload = {
    name: title,
    description: fields.summary,
    base: theme.base ?? BUILTIN_THEMES[0]!.id,
    ...(theme.layout !== undefined ? { layout: theme.layout } : {}),
    tokens: theme.tokens,
  };
  const published = await publishThemeVersion(client, item.id, payload, request.changelog.trim());
  store.link(request.themeId, { itemId: item.id, versionId: published.id, version: published.version, origin: "mine" });
  return `${title} v${published.version} published${fields.visibility === "public" ? " — listed in Content" : ` as ${fields.visibility}`}`;
}

async function ownedItemId(deps: ThemeContentDeps, themeId: string): Promise<string> {
  if (!accountView().signedIn) throw new Error("sign in first");
  const link = deps.themes().links()[themeId] ?? null;
  if (link === null || link.origin !== "mine") throw new Error("publish the theme first, then add screenshots to its page");
  return Promise.resolve(link.itemId);
}

export function installThemeContentIpc(deps: ThemeContentDeps): void {
  ipcMain.handle(THEME_CONTENT_CHANNEL, async (event, request: ThemeContentRequest) => {
    try {
      switch (request.op) {
        case "browse":
          return { ok: true, value: await list(deps, request) };
        case "page":
          return { ok: true, value: await page(deps, request.itemId) };
        case "install":
          return { ok: true, value: await install(deps, request.itemId) };
        case "uninstall":
          return { ok: true, value: uninstall(deps, request.itemId) };
        case "publishState":
          return { ok: true, value: await publishState(deps, request.themeId) };
        case "publish":
          return { ok: true, value: await publish(deps, request) };
        case "schema":
          return { ok: true, value: themeJsonSchema() };
        case "readFile": {
          const text = deps.themes().readText(request.themeId);
          if (text === null) throw new Error("only a theme of your own can be edited — use New… to make one");
          return { ok: true, value: text };
        }
        case "writeFile": {
          // A megabyte is far more than any theme; a paste of something else stops here.
          if (request.text.length > 1_000_000) throw new Error("that is too large to be a theme");
          const problems = deps.themes().writeText(request.themeId, request.text);
          // The watcher would get there too; this makes the preview immediate.
          deps.apply(deps.getSettings().overlayTheme);
          return { ok: true, value: problems };
        }
        case "addScreenshot": {
          const itemId = await ownedItemId(deps, request.themeId);
          const client = cloudClient();
          const shots = (await listMedia(client, itemId)).filter((m) => m.kind === "screenshot");
          if (shots.length >= MAX_SCREENSHOTS) throw new Error(`a page has at most ${MAX_SCREENSHOTS} screenshots`);
          const picked = await pickImage(event.sender, "screenshot");
          if (picked !== null) await uploadMedia(client, itemId, "screenshot", picked.bytes, picked.type);
          return { ok: true, value: await publishState(deps, request.themeId) };
        }
        case "removeScreenshot": {
          const itemId = await ownedItemId(deps, request.themeId);
          const client = cloudClient();
          const media = (await listMedia(client, itemId)).find((m) => m.id === request.mediaId);
          if (media !== undefined) await removeMedia(client, media);
          return { ok: true, value: await publishState(deps, request.themeId) };
        }
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
