/**
 * iRacing lap files (`.blap` best lap, `.olap` optimal lap) — what the header
 * says. The format is undocumented; the offsets are from decoding a real file
 * (TODO.md §13, the `.blap` question). Only the header is read: the samples
 * after it carry heading and time but no position, so there is nothing more
 * to use (no map can be cut from one).
 *
 * Pure: bytes in, fields out. A file that does not look like a lap file gives
 * null rather than throwing — this labels an attachment, it is not a gate.
 */

export interface LapFileHeader {
  /** `BLAP` or `OLAP`, as the file says. */
  readonly magic: string;
  readonly formatVersion: number;
  readonly custId: number;
  readonly driver: string;
  /** iRacing's car folder path, e.g. `mx5\mx52016`. */
  readonly carPath: string;
  /** iRacing's track folder path, e.g. `tsukuba\2kfull`. */
  readonly trackPath: string | null;
  /** Seconds. Null when the field is not where the decoded layout puts it. */
  readonly lapTimeS: number | null;
}

/**
 * NUL-terminated text at an offset, up to `max` bytes. UTF-8: driver names are
 * written that way ("Gutiérrez"), and plain ASCII paths decode the same.
 */
function cString(bytes: Uint8Array, offset: number, max: number): string {
  let end = offset;
  while (end < bytes.length && end < offset + max && bytes[end] !== 0) end++;
  const raw = bytes.subarray(offset, end);
  // UTF-8 without TextDecoder, which core cannot import (it is a DOM/Node
  // global). Percent-encoding the bytes lets decodeURIComponent do it; a byte
  // sequence that is not valid UTF-8 falls back to one character per byte.
  try {
    return decodeURIComponent(Array.from(raw, (b) => `%${b.toString(16).padStart(2, "0")}`).join(""));
  } catch {
    return String.fromCharCode(...raw);
  }
}

export function readLapFileHeader(bytes: Uint8Array): LapFileHeader | null {
  if (bytes.length < 0x5c0) return null;
  const magic = cString(bytes, 0, 4);
  if (magic !== "BLAP" && magic !== "OLAP") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const lapTime = view.getFloat32(0x5b4, true);
  const trackPath = cString(bytes, 0x53e, 64);
  return {
    magic,
    formatVersion: view.getInt32(0x04, true),
    custId: view.getInt32(0x0c, true),
    driver: cString(bytes, 0x10, 64),
    carPath: cString(bytes, 0x90, 64),
    trackPath: /^[a-z0-9_]+\\[a-z0-9_]+$/i.test(trackPath) ? trackPath : null,
    // A lap between 10 s and an hour is a lap; anything else is the layout
    // having moved in a newer format version.
    lapTimeS: Number.isFinite(lapTime) && lapTime > 10 && lapTime < 3600 ? lapTime : null,
  };
}

/** The sim's car folder path as the slug the app keys cars by (`mx5\mx52016` → `mx5-mx52016`). */
export const carIdFromPath = (carPath: string): string =>
  carPath.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
