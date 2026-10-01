/**
 * Files attached to a pack version: setups and iRacing lap files — TODO.md M8
 * step 6.
 *
 * Stored once by content hash under the item's folder in the `setups` bucket,
 * so an unchanged setup carried from v3 to v4 is not uploaded twice. The bucket
 * is private; a file is readable once a visible version lists it
 * (supabase/migrations/…_storage.sql).
 */

import { createHash } from "node:crypto";

import type { CloudClient } from "./client.js";

const TIMEOUT_MS = 30000;
const timeout = (): AbortSignal => AbortSignal.timeout(TIMEOUT_MS);
const fail = (what: string, message: string): never => {
  throw new Error(`${what}: ${message}`);
};

export type PackFileKind = "setup" | "blap" | "olap";

export const PACK_FILE_EXTENSION: Record<PackFileKind, string> = { setup: "sto", blap: "blap", olap: "olap" };

/** The bucket's own limit (…_buckets.sql); a setup or a lap file is tens of KB. */
export const MAX_PACK_FILE_BYTES = 512 * 1024;

export interface PackFile {
  readonly kind: PackFileKind;
  readonly path: string;
  readonly label: string;
  readonly carId: string | null;
  readonly sha256: string;
  readonly bytes: number;
}

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Upload a file to an item's folder, unless the same bytes are already there. */
export async function uploadPackFile(
  client: CloudClient,
  itemId: string,
  kind: PackFileKind,
  bytes: Uint8Array,
): Promise<{ path: string; sha256: string; bytes: number }> {
  if (bytes.byteLength === 0) throw new Error("the file is empty");
  if (bytes.byteLength > MAX_PACK_FILE_BYTES) throw new Error("the file is too large to be a setup or a lap file");
  const sha256 = sha256Hex(bytes);
  const path = `items/${itemId}/${sha256}.${PACK_FILE_EXTENSION[kind]}`;
  const { error } = await client.storage
    .from("setups")
    .upload(path, bytes, { contentType: "application/octet-stream", upsert: false });
  // Already there: same hash, same bytes. That is the point of the naming.
  if (error !== null && !/exists|duplicate/i.test(error.message)) fail("upload", error.message);
  return { path, sha256, bytes: bytes.byteLength };
}

export async function listVersionFiles(client: CloudClient, versionId: string): Promise<PackFile[]> {
  const { data, error } = await client
    .from("content_files")
    .select("kind, path, label, car_id, sha256, bytes")
    .eq("version_id", versionId)
    .order("kind")
    .abortSignal(timeout());
  if (error !== null) fail("files", error.message);
  return (data ?? []).map((f) => ({
    kind: f.kind as PackFileKind,
    path: f.path,
    label: f.label,
    carId: f.car_id,
    sha256: f.sha256,
    bytes: f.bytes,
  }));
}

/** A file's bytes, checked against the hash it was published under. */
export async function downloadPackFile(client: CloudClient, file: Pick<PackFile, "path" | "sha256">): Promise<Uint8Array> {
  const { data, error } = await client.storage.from("setups").download(file.path);
  if (error !== null || data === null) return fail("download", error?.message ?? "no data");
  const bytes = new Uint8Array(await data.arrayBuffer());
  if (sha256Hex(bytes) !== file.sha256) throw new Error(`${file.path} did not match its published hash`);
  return bytes;
}
