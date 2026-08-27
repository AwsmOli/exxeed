/**
 * @exxeed/core — pure domain logic.
 *
 * No I/O, no Electron, no native modules. Plain objects in, plain objects out.
 * This is what makes the note engine testable without the sim and the Supabase
 * swap (§8) a DI change and nothing else. Enforced by a lint rule — see
 * eslint.config.mjs.
 */

export * from "./units.js";
export * from "./pct.js";
export * from "./track.js";
export * from "./schema.js";
export * from "./anchor.js";
export * from "./profile.js";
export * from "./trigger.js";
export * from "./engine.js";
