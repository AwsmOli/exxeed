/**
 * Cutting a `TrackMap` and a `ReferenceLap` from one recorded lap — SPEC.md §5.
 *
 * The assembly moved to `@exxeed/telemetry` (map-build.ts) so the app can cut a
 * map live from a clean lap; this file keeps what only the command needs —
 * reading a recording off disk — and re-exports the rest, so the CLI and the app
 * run the same code.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import { parseFrame, type TelemetryFrame } from "@exxeed/telemetry";

export {
  buildTrackMap,
  inferLengthM,
  TrackMapBuildError,
  type BuildOptions,
  type BuildResult,
} from "@exxeed/telemetry";

/** Read an NDJSON recording into frames, ignoring the header line. */
export async function readFrames(path: string): Promise<TelemetryFrame[]> {
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  const frames: TelemetryFrame[] = [];
  try {
    for await (const line of lines) {
      if (line.trim() === "") continue;
      const frame = parseFrame(line);
      if (frame !== null) frames.push(frame);
    }
  } finally {
    lines.close();
  }
  return frames;
}
