/**
 * Files attached to pack versions, against the local Supabase stack (M8 step
 * 6). Skipped when the stack is not running.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { NoteSet } from "@exxeed/core";
import {
  createCalloutItem,
  downloadPackFile,
  getItem,
  listVersionFiles,
  publishVersion,
  reportSession,
  sha256Hex,
  uploadPackFile,
  type CloudClient,
} from "@exxeed/repo";

import { SPA_LENGTH_M, spaGt3Notes } from "../../core/test/fixtures.js";
import { anonClient, driver, LOCAL_SERVICE, LOCAL_URL, removeDriver, serviceDelete, stackUp } from "./local-stack.js";

describe.skipIf(!stackUp)("files in a pack", () => {
  const trackId = 930000 + Math.floor(Math.random() * 69999);
  const trackKey = { sim: "iracing" as const, trackId, configId: "files-test" };
  const noteSet: NoteSet = { ...spaGt3Notes, id: "files-test", trackKey, status: "published" };
  const setup = new TextEncoder().encode(`setup for ${trackId}`);

  const drivers: string[] = [];
  let author: CloudClient;
  let stranger: CloudClient;
  let itemId = "";

  beforeAll(async () => {
    const stamp = Date.now();
    const a = await driver(`files-author-${stamp}@example.test`);
    const s = await driver(`files-stranger-${stamp}@example.test`);
    drivers.push(a.id, s.id);
    author = a.client;
    stranger = s.client;
    await reportSession(author, { trackKey, trackName: "Files Test", configName: "", lengthM: SPA_LENGTH_M, carId: null, carName: null });
    itemId = (await createCalloutItem(author, { title: "Pack with files", summary: "", readme: "", visibility: "public" }, trackKey, "gt3")).id;
  });

  afterAll(async () => {
    // Storage objects outlive their rows; remove the one this test made.
    if (itemId !== "") {
      await fetch(`${LOCAL_URL}/storage/v1/object/setups`, {
        method: "DELETE",
        headers: { apikey: LOCAL_SERVICE, authorization: `Bearer ${LOCAL_SERVICE}`, "content-type": "application/json" },
        body: JSON.stringify({ prefixes: [`items/${itemId}/${sha256Hex(setup)}.sto`] }),
      });
    }
    if (itemId !== "") await serviceDelete("content_items", `id=eq.${itemId}`);
    await serviceDelete("track_layouts", `track_id=eq.${trackId}`);
    await Promise.all(drivers.map(removeDriver));
  });

  it("stores a file once by its hash, and keeps it private until a version is published", async () => {
    const first = await uploadPackFile(author, itemId, "setup", setup);
    const again = await uploadPackFile(author, itemId, "setup", setup);
    expect(again.path).toBe(first.path);
    // Unpublished: nobody else can read it.
    await expect(downloadPackFile(stranger, first)).rejects.toThrow();
  });

  it("is readable by anyone once a published version lists it, and checked against its hash", async () => {
    const uploaded = await uploadPackFile(author, itemId, "setup", setup);
    await publishVersion(author, {
      itemId,
      noteSet,
      changelog: "",
      diff: null,
      mapVersion: null,
      voiceId: null,
      files: [{ kind: "setup", label: "Race", carId: "ferrari296gt3", ...uploaded }],
    });
    const item = await getItem(anonClient(), itemId);
    const files = await listVersionFiles(anonClient(), item!.latestVersionId!);
    expect(files.map((f) => [f.kind, f.label])).toEqual([["setup", "Race"]]);
    expect(new TextDecoder().decode(await downloadPackFile(anonClient(), files[0]!))).toBe(`setup for ${trackId}`);
  });

  it("refuses to upload into someone else's item", async () => {
    await expect(uploadPackFile(stranger, itemId, "setup", new TextEncoder().encode("not mine"))).rejects.toThrow();
  });
});
