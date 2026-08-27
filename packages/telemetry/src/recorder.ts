/**
 * NDJSON telemetry recorder — SPEC.md §9, step 1.
 *
 * "Record every telemetry frame to NDJSON during any session, always, cheaply."
 *
 * Always-on is the point. You cannot iterate on callout timing by driving laps,
 * so every lap anyone drives needs to be replayable afterwards — and the moment
 * recording becomes a thing you have to remember to switch on, the interesting
 * lap is the one you didn't record.
 *
 * One frame per line, appended, no buffering games beyond the stream's own. At
 * 60 Hz a frame is a few hundred bytes, so an hour of driving is tens of MB.
 */

import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";

import type { TelemetryFrame } from "./frame.js";

export interface RecorderMeta {
  readonly startedAt: string;
  readonly source: string;
  /** Free-form: track, car, whatever the caller knows at session start. */
  readonly [key: string]: unknown;
}

export class NdjsonRecorder {
  readonly path: string;
  #stream: WriteStream;
  #count = 0;
  #closed = false;

  constructor(path: string, meta: RecorderMeta) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.#stream = createWriteStream(path, { flags: "a" });
    // First line is a header record, so a recording is self-describing when you
    // come back to it six months later wondering which car it was.
    this.#stream.write(`${JSON.stringify({ kind: "meta", ...meta })}\n`);
  }

  get frameCount(): number {
    return this.#count;
  }

  write(frame: TelemetryFrame): void {
    if (this.#closed) return;
    this.#stream.write(`${JSON.stringify(frame)}\n`);
    this.#count++;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await new Promise<void>((resolve, reject) => {
      this.#stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }
}
