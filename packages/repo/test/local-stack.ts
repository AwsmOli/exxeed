/**
 * Helpers for tests that run against the local Supabase stack (`pnpm db:start`).
 * Such tests skip themselves when `stackUp` is false.
 */

import { createCloudClient, type CloudClient } from "@exxeed/repo";

export const LOCAL_URL = "http://127.0.0.1:54321";
// Supabase's standard local-development keys — the same on every machine, and
// useless against anything but a local stack.
export const LOCAL_ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
export const LOCAL_SERVICE =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

export const stackUp = await fetch(`${LOCAL_URL}/auth/v1/settings`, { headers: { apikey: LOCAL_ANON } })
  .then((r) => r.ok)
  .catch(() => false);

const memory = (): { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void } => {
  const values = new Map<string, string>();
  return {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => void values.set(k, v),
    removeItem: (k) => void values.delete(k),
  };
};

/** A signed-out client. */
export const anonClient = (): CloudClient => createCloudClient({ url: LOCAL_URL, anonKey: LOCAL_ANON }, memory());

/** A fresh confirmed user, signed in. Remove with `removeDriver`. */
export async function driver(email: string): Promise<{ id: string; client: CloudClient }> {
  const response = await fetch(`${LOCAL_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: LOCAL_SERVICE, authorization: `Bearer ${LOCAL_SERVICE}`, "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct horse battery", email_confirm: true }),
  });
  const user = (await response.json()) as { id: string };
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({ email, password: "correct horse battery" });
  if (error !== null) throw error;
  return { id: user.id, client };
}

export async function removeDriver(id: string): Promise<void> {
  await fetch(`${LOCAL_URL}/auth/v1/admin/users/${id}`, {
    method: "DELETE",
    headers: { apikey: LOCAL_SERVICE, authorization: `Bearer ${LOCAL_SERVICE}` },
  });
}

/** Delete rows the tests created, bypassing RLS. `filter` is a PostgREST query string. */
export async function serviceDelete(table: string, filter: string): Promise<void> {
  await fetch(`${LOCAL_URL}/rest/v1/${table}?${filter}`, {
    method: "DELETE",
    headers: { apikey: LOCAL_SERVICE, authorization: `Bearer ${LOCAL_SERVICE}` },
  });
}
