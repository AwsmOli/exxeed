/**
 * Where the backend is (M8), shared by the app and the tools.
 *
 * The anon key is public by design — it ships in every Supabase client, and
 * RLS is what protects the data (SPEC §8.1). The service-role key never
 * appears anywhere in this repository.
 *
 * The hosted project is the default, so every machine shares one set of maps
 * and packs. `EXXEED_SUPABASE=local` points at the local development stack
 * (`pnpm db:start`) instead; `EXXEED_SUPABASE_URL` and
 * `EXXEED_SUPABASE_ANON_KEY` override either.
 */

import type { CloudConfig } from "./client.js";

export const HOSTED_CLOUD: CloudConfig = {
  url: "https://mxxexxhcftzjvaihhaph.supabase.co",
  // A legacy JWT anon key. Swap for the project's publishable key
  // (`sb_publishable_…`, Settings → API Keys) before legacy keys are turned off.
  anonKey:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im14eGV4eGhjZnR6anZhaWhoYXBoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA3OTgzNjYsImV4cCI6MjEwNjM3NDM2Nn0." +
    "wrSQhAI-qI0s4LuAu-dT8KDz9nJsh8xq-or4qYUDYz4",
};

/** Supabase's standard local-development stack — the same on every machine, not a secret. */
export const LOCAL_CLOUD: CloudConfig = {
  url: "http://127.0.0.1:54321",
  anonKey:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9." +
    "CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0",
};

export function cloudConfig(): CloudConfig {
  const base = process.env["EXXEED_SUPABASE"] === "local" ? LOCAL_CLOUD : HOSTED_CLOUD;
  return {
    url: process.env["EXXEED_SUPABASE_URL"] || base.url,
    anonKey: process.env["EXXEED_SUPABASE_ANON_KEY"] || base.anonKey,
  };
}
