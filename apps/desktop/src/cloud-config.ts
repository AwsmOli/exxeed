/**
 * Where the backend is: the shared definition lives in @exxeed/repo
 * (cloud/config.ts); this module adds what only the desktop app needs.
 */

export { cloudConfig } from "@exxeed/repo";

/**
 * Where OAuth hands back to. A fixed port on the loopback, because the
 * project's redirect allow-list is a list of exact URLs
 * (supabase/config.toml, and Auth → URL Configuration on the hosted project).
 */
export const AUTH_CALLBACK_PORT = 53682;
export const AUTH_CALLBACK_URL = `http://127.0.0.1:${AUTH_CALLBACK_PORT}/auth/callback`;
