/**
 * Where the backend is (M8).
 *
 * The anon key is public by design — it ships in every Supabase client, and
 * RLS is what protects the data (SPEC §8.1). The service-role key never
 * appears anywhere in the app.
 *
 * The hosted project is the default, so every machine — this one and the rig —
 * shares one set of maps and packs. `EXXEED_SUPABASE=local` points the app at
 * the local development stack (`pnpm db:start`) instead, for working on the
 * schema without touching real data. `EXXEED_SUPABASE_URL` and
 * `EXXEED_SUPABASE_ANON_KEY` override either.
 */

import type { CloudConfig } from "@exxeed/repo";

const HOSTED: CloudConfig = {
  url: "https://mxxexxhcftzjvaihhaph.supabase.co",
  // A legacy JWT anon key. Swap for the project's publishable key
  // (`sb_publishable_…`, Settings → API Keys) before legacy keys are turned off.
  anonKey:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im14eGV4eGhjZnR6anZhaWhoYXBoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA3OTgzNjYsImV4cCI6MjEwNjM3NDM2Nn0." +
    "wrSQhAI-qI0s4LuAu-dT8KDz9nJsh8xq-or4qYUDYz4",
};

/** Supabase's standard local-development stack — the same on every machine, not a secret. */
const LOCAL: CloudConfig = {
  url: "http://127.0.0.1:54321",
  anonKey:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9." +
    "CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0",
};

export function cloudConfig(): CloudConfig {
  const base = process.env["EXXEED_SUPABASE"] === "local" ? LOCAL : HOSTED;
  return {
    url: process.env["EXXEED_SUPABASE_URL"] || base.url,
    anonKey: process.env["EXXEED_SUPABASE_ANON_KEY"] || base.anonKey,
  };
}

/**
 * Where OAuth hands back to. A fixed port on the loopback, because the
 * project's redirect allow-list is a list of exact URLs
 * (supabase/config.toml, and Auth → URL Configuration on the hosted project).
 */
export const AUTH_CALLBACK_PORT = 53682;
export const AUTH_CALLBACK_URL = `http://127.0.0.1:${AUTH_CALLBACK_PORT}/auth/callback`;
