/**
 * The Supabase client — SPEC.md §8.1.
 *
 * One factory so every caller gets the same auth settings. The caller supplies
 * where the session is kept: in the desktop app that is an encrypted file
 * (apps/desktop/src/account.ts), never localStorage in a renderer, so the
 * refresh token lives only in main.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { WebSocket } from "ws";

import type { Database } from "./db.generated.js";

export type CloudClient = SupabaseClient<Database>;

/** The same shape supabase-js accepts for `auth.storage`. */
export interface SessionStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

export interface CloudConfig {
  readonly url: string;
  /** The anon / publishable key. Public by design: RLS is what protects data. */
  readonly anonKey: string;
}

export function createCloudClient(config: CloudConfig, storage: SessionStorage): CloudClient {
  return createClient<Database>(config.url, config.anonKey, {
    // supabase-js builds its realtime client eagerly, and that throws where
    // there is no global WebSocket — Node 20, which is what Electron 33 runs.
    // Nothing here uses realtime yet; `ws` just lets the client be built.
    ...(typeof globalThis.WebSocket === "undefined"
      ? { realtime: { transport: WebSocket as unknown as typeof globalThis.WebSocket } }
      : {}),
    auth: {
      // PKCE: the browser hands back a one-time code, not tokens in a URL.
      flowType: "pkce",
      storage,
      persistSession: true,
      autoRefreshToken: true,
      // There is no page URL to read a session from; the loopback listener
      // exchanges the code explicitly.
      detectSessionInUrl: false,
    },
  });
}

/**
 * Which sign-in providers the project has switched on, from Auth's public
 * settings endpoint — so the sign-in dialog only offers the ones that work.
 */
export async function enabledProviders(config: CloudConfig): Promise<Record<string, boolean>> {
  const response = await fetch(`${config.url}/auth/v1/settings`, {
    headers: { apikey: config.anonKey },
  });
  if (!response.ok) throw new Error(`auth settings: HTTP ${response.status}`);
  const body = (await response.json()) as { external?: Record<string, boolean> };
  return body.external ?? {};
}
