/**
 * Publishing callout packs against the local Supabase stack (M8 steps 3-3b).
 * Skipped when the stack is not running.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Note, NoteSet } from "@exxeed/core";
import { diffNoteSets } from "@exxeed/core";
import {
  createCalloutItem,
  getDraft,
  getItem,
  getItems,
  getVersionPayload,
  listMyItems,
  listVersions,
  LocalContentIndex,
  publishVersion,
  recordDownload,
  reportSession,
  saveDraft,
  updateItem,
  withdrawVersion,
  type CloudClient,
} from "@exxeed/repo";

import { SPA_LENGTH_M, spaGt3Notes } from "../../core/test/fixtures.js";
import { anonClient, driver, removeDriver, serviceDelete, stackUp } from "./local-stack.js";

describe("LocalContentIndex", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "exxeed-index-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("links a note set to its item and version, and finds it back by item", async () => {
    const index = new LocalContentIndex(root);
    expect(await index.get("spa")).toBeNull();

    const itemId = "8f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
    await index.put("spa", { itemId, origin: "mine", version: null, versionId: null, policy: "auto" });
    expect(await index.findByItem(itemId)).toBe("spa");

    const versionId = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";
    await index.put("spa", { itemId, origin: "mine", version: 2, versionId, policy: "auto" });
    expect((await index.get("spa"))?.version).toBe(2);

    await index.remove("spa");
    expect(await index.all()).toEqual({});
  });

  it("refuses a malformed link rather than writing it", async () => {
    const index = new LocalContentIndex(root);
    await expect(
      index.put("bad", { itemId: "not-a-uuid", origin: "mine", version: null, versionId: null, policy: "auto" }),
    ).rejects.toThrow();
  });
});

describe.skipIf(!stackUp)("publishing a callout pack", () => {
  const trackId = 910000 + Math.floor(Math.random() * 89999);
  const trackKey = { sim: "iracing" as const, trackId, configId: "publish-test" };
  const v1: NoteSet = { ...spaGt3Notes, id: "publish-test", trackKey };

  const drivers: string[] = [];
  let author: CloudClient;
  let stranger: CloudClient;
  let itemId = "";

  beforeAll(async () => {
    const stamp = Date.now();
    const a = await driver(`author-${stamp}@example.test`);
    const s = await driver(`stranger-${stamp}@example.test`);
    drivers.push(a.id, s.id);
    author = a.client;
    stranger = s.client;
    await reportSession(author, {
      trackKey,
      trackName: "Publish Test Circuit",
      configName: "",
      lengthM: SPA_LENGTH_M,
      carId: null,
      carName: null,
    });
  });

  afterAll(async () => {
    if (itemId !== "") await serviceDelete("content_items", `id=eq.${itemId}`);
    await serviceDelete("track_layouts", `track_id=eq.${trackId}`);
    await Promise.all(drivers.map(removeDriver));
  });

  it("creates a private item that nobody else can see until it is published", async () => {
    const item = await createCalloutItem(
      author,
      { title: "Spa in the GT3", summary: "Two callouts", readme: "# Spa", visibility: "public" },
      trackKey,
      "gt3",
    );
    itemId = item.id;
    expect(item.latestVersion).toBeNull();
    expect(item.trackLabel).toBe("Publish Test Circuit");
    // Public, but nothing published yet: invisible to others.
    expect(await getItem(stranger, itemId)).toBeNull();
  });

  it("publishes v1, which a signed-out stranger can then read", async () => {
    const published = await publishVersion(author, {
      itemId,
      noteSet: { ...v1, status: "published" },
      changelog: "",
      diff: null,
      mapVersion: 1,
      voiceId: "en_US-lessac-medium",
    });
    expect(published.version).toBe(1);

    const seen = await getItem(anonClient(), itemId);
    expect(seen?.latestVersion).toBe(1);
    expect((await getVersionPayload(anonClient(), published.id))?.notes).toHaveLength(2);
  });

  it("refuses a version with stale audio", async () => {
    const dirty: NoteSet = { ...v1, notes: v1.notes.map((n) => ({ ...n, dirty: true })) };
    await expect(
      publishVersion(author, { itemId, noteSet: dirty, changelog: "", diff: null, mapVersion: 1, voiceId: null }),
    ).rejects.toThrow(/render the audio first/);
  });

  it("publishes v2 with its changelog and diff, and keeps v1", async () => {
    const [brake, throttle] = v1.notes as [Note, Note];
    const v2: NoteSet = { ...v1, notes: [{ ...brake, pct: (brake.pct + 20 / SPA_LENGTH_M) % 1 }, throttle] };
    const diff = diffNoteSets(v1, v2);

    await updateItem(author, itemId, { title: "Spa in the GT3", summary: "Braking moved", readme: "# Spa", visibility: "public" });
    const published = await publishVersion(author, {
      itemId,
      noteSet: { ...v2, status: "published" },
      changelog: "T1 braking 20 m later",
      diff,
      mapVersion: 1,
      voiceId: "en_US-lessac-medium",
    });
    expect(published.version).toBe(2);

    const versions = await listVersions(anonClient(), itemId);
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(versions[0]?.changelog).toBe("T1 braking 20 m later");
    expect(versions[0]?.diff?.moved).toEqual([{ id: "t1_brake", text: brake.text, metres: 20 }]);
  });

  it("keeps the draft private to its author", async () => {
    await saveDraft(author, itemId, v1);
    expect(await getDraft(stranger, itemId)).toBeNull();
    expect((await getDraft(author, itemId))?.noteSet.id).toBe("publish-test");
  });

  it("lists an author's own items, and finds items by id for update checks", async () => {
    const authorId = drivers[0]!;
    expect((await listMyItems(author, authorId)).map((i) => i.id)).toContain(itemId);
    // A stranger asking for the author's items sees only what is visible anyway.
    const seen = await getItems(anonClient(), [itemId, "00000000-0000-4000-8000-000000000000"]);
    expect(seen.map((i) => i.id)).toEqual([itemId]);
  });

  it("counts an install once per installation, signed out", async () => {
    const item = await getItem(anonClient(), itemId);
    const installation = "00000000-0000-4000-8000-00000000beef";
    await recordDownload(anonClient(), item!.latestVersionId!, installation);
    await recordDownload(anonClient(), item!.latestVersionId!, installation);
    expect((await getItem(anonClient(), itemId))?.downloadCount).toBe(1);
  });

  it("does not let a stranger publish or withdraw", async () => {
    await expect(
      publishVersion(stranger, { itemId, noteSet: v1, changelog: "", diff: null, mapVersion: 1, voiceId: null }),
    ).rejects.toThrow(/not your item/);
    const [latest] = await listVersions(stranger, itemId);
    await expect(withdrawVersion(stranger, latest!.id)).rejects.toThrow(/not your version/);
  });

  it("withdrawing v2 makes v1 the latest again", async () => {
    const [latest] = await listVersions(author, itemId);
    await withdrawVersion(author, latest!.id);
    expect((await getItem(anonClient(), itemId))?.latestVersion).toBe(1);
  });
});
