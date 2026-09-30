/**
 * The cloud half of the repository layer (SPEC.md §8.1). Row types from
 * db.generated.ts stay in here; callers get domain types.
 */

export * from "./client.js";
export * from "./sync.js";
export * from "./content.js";
export type { Database } from "./db.generated.js";
