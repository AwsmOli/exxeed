/**
 * Browsing Content against the local Supabase stack (M8 step 5). Skipped when
 * the stack is not running.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { NoteSet } from "@exxeed/core";
import {
  browse,
  browseRow,
  countForCombo,
  createCalloutItem,
  fetchMap,
  listLayouts,
  listMedia,
  myStars,
  publishVersion,
  removeMedia,
  reportSession,
  setStar,
  pushMap,
  updateItem,
  uploadMedia,
  type CloudClient,
} from "@exxeed/repo";

import { SPA_LENGTH_M, spaGt3Notes, spaMap } from "../../core/test/fixtures.js";
import { anonClient, driver, removeDriver, serviceDelete, stackUp } from "./local-stack.js";

/** The smallest valid PNG: one transparent pixel. */
const PNG = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"),
);

describe.skipIf(!stackUp)("browsing Content", () => {
  const trackId = 920000 + Math.floor(Math.random() * 79999);
  const trackKey = { sim: "iracing" as const, trackId, configId: "browse-test" };
  const word = `zolder${trackId}`; // unique, so search cannot match an earlier run
  const noteSet: NoteSet = { ...spaGt3Notes, id: "browse-test", trackKey, status: "published" };

  const drivers: string[] = [];
  let author: CloudClient;
  let fan: CloudClient;
  let fanId = "";
  let listed = "";
  let hidden = "";

  beforeAll(async () => {
    const stamp = Date.now();
    const a = await driver(`browse-author-${stamp}@example.test`);
    const f = await driver(`browse-fan-${stamp}@example.test`);
    drivers.push(a.id, f.id);
    author = a.client;
    fan = f.client;
    fanId = f.id;
    await author.from("profiles").update({ display_name: "Browse Author" }).eq("id", a.id);
    await reportSession(author, { trackKey, trackName: `Circuit ${word}`, configName: "", lengthM: SPA_LENGTH_M, carId: null, carName: null });
    await pushMap(author, { ...spaMap, trackRef: { ...trackKey, mapVersion: 1 } });

    const fields = { title: `Fast laps at ${word}`, summary: "Two callouts", readme: "", visibility: "public" as const };
    listed = (await createCalloutItem(author, fields, trackKey, "gt3")).id;
    await publishVersion(author, { itemId: listed, noteSet, changelog: "", diff: null, mapVersion: 1, voiceId: null });

    // Unlisted: reachable by link, never in the list.
    hidden = (await createCalloutItem(author, { ...fields, title: `Secret laps at ${word}`, visibility: "unlisted" }, trackKey, "gt3")).id;
    await publishVersion(author, { itemId: hidden, noteSet, changelog: "", diff: null, mapVersion: 1, voiceId: null });
  });

  afterAll(async () => {
    await serviceDelete("content_items", `track_id=eq.${trackId}`);
    await serviceDelete("track_maps", `track_id=eq.${trackId}`);
    await serviceDelete("track_layouts", `track_id=eq.${trackId}`);
    await Promise.all(drivers.map(removeDriver));
  });

  it("finds a public pack by a word in its title, with its author's name, signed out", async () => {
    const rows = await browse(anonClient(), { text: word, sort: "stars", limit: 20, offset: 0 });
    expect(rows.map((r) => r.id)).toEqual([listed]);
    expect(rows[0]?.authorName).toBe("Browse Author");
    expect(rows[0]?.trackLabel).toBe(`Circuit ${word}`);
  });

  it("filters by track and car class, and never lists an unlisted pack", async () => {
    const byTrack = await browse(anonClient(), { trackKey, sort: "new", limit: 20, offset: 0 });
    expect(byTrack.map((r) => r.id)).toEqual([listed]);
    expect(await browse(anonClient(), { trackKey, carClass: "mx5", sort: "new", limit: 20, offset: 0 })).toEqual([]);
    // …but the unlisted one opens by id.
    expect((await browseRow(anonClient(), hidden))?.id).toBe(hidden);
  });

  it("counts packs for a combo, for the session banner", async () => {
    expect(await countForCombo(anonClient(), trackKey, "gt3")).toBe(1);
    expect(await countForCombo(anonClient(), trackKey, "mx5")).toBe(0);
  });

  it("stars and un-stars, and the count follows", async () => {
    await setStar(fan, listed, true);
    await setStar(fan, listed, true); // twice is still once
    expect(await myStars(fan, fanId)).toEqual([listed]);
    expect((await browseRow(anonClient(), listed))?.stars).toBe(1);
    await setStar(fan, listed, false);
    expect((await browseRow(anonClient(), listed))?.stars).toBe(0);
  });

  it("returns an empty list, not everything, when filtering by an empty set of ids", async () => {
    expect(await browse(anonClient(), { itemIds: [], sort: "stars", limit: 20, offset: 0 })).toEqual([]);
  });

  it("lists layouts for the filter menu, and fetches a layout's map without storing it", async () => {
    expect((await listLayouts(anonClient())).some((l) => l.trackKey.trackId === trackId)).toBe(true);
    expect((await fetchMap(anonClient(), trackKey))?.corners).toHaveLength(spaMap.corners.length);
  });

  it("uploads an icon and screenshots to the owner's item, public to read, closed to others", async () => {
    const icon = await uploadMedia(author, listed, "icon", PNG, "image/png");
    await uploadMedia(author, listed, "screenshot", PNG, "image/png");
    expect((await browseRow(anonClient(), listed))?.iconUrl).toBe(icon.url);
    expect((await listMedia(anonClient(), listed)).map((m) => m.kind)).toEqual(["icon", "screenshot"]);
    expect((await fetch(icon.url)).status).toBe(200);

    // A new icon replaces the old one.
    const second = await uploadMedia(author, listed, "icon", PNG, "image/png");
    const media = await listMedia(anonClient(), listed);
    expect(media.filter((m) => m.kind === "icon").map((m) => m.id)).toEqual([second.id]);

    // Someone else cannot add to it.
    await expect(uploadMedia(fan, listed, "screenshot", PNG, "image/png")).rejects.toThrow();

    for (const m of media) await removeMedia(author, m);
    expect(await listMedia(anonClient(), listed)).toEqual([]);
  });

  it("orders by the chosen sort", async () => {
    await updateItem(author, listed, { title: `Fast laps at ${word}`, summary: "Edited", readme: "", visibility: "public" });
    const rows = await browse(anonClient(), { text: word, sort: "updated", limit: 20, offset: 0 });
    expect(rows[0]?.summary).toBe("Edited");
  });
});
