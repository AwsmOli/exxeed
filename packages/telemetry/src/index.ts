/**
 * @exxeed/telemetry — sim adapters, the frame shape, and the NDJSON recorder.
 *
 * Note that `irsdk-node` is imported lazily inside `IRacingAdapter.connect()`,
 * so importing this package is safe on any platform. See iracing.ts.
 */

export * from "./frame.js";
export * from "./engine-input.js";
export * from "./source.js";
export * from "./steering.js";
export * from "./recorder.js";
export * from "./recordings.js";
export * from "./replay.js";
export * from "./iracing.js";
