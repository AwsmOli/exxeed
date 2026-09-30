/**
 * Sign-in — TODO.md M8 step 1.
 *
 * The session lives here, in main, and nowhere else. Windows get an
 * `AccountView` with a name and an avatar, never a token — the same rule as the
 * importer's API keys (importer-secrets.ts), and for the same reason: nothing a
 * renderer holds can end up in devtools or a crash dump.
 *
 * Three ways in:
 *  - **OAuth** (Discord, Google): PKCE through the system browser, back to a
 *    one-shot listener on the loopback. Never an embedded login window — nobody
 *    should type a Google password into an app's webview.
 *  - **Email**: a 6-digit code typed into the app where the project's email
 *    template carries one, and always a link, caught by the same loopback
 *    listener when it is clicked on this PC. The code is the better path (a
 *    link opened on a phone cannot reach the PC), but custom templates need
 *    custom SMTP on a hosted project, so the link is what works until then.
 *
 * Everything works signed out except publishing, starring and syncing drafts.
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

import { app, BrowserWindow, ipcMain, safeStorage, shell } from "electron";

import {
  ACCOUNT_CHANGED_CHANNEL,
  ACCOUNT_CHANNEL,
  type AccountRequest,
  type AccountView,
} from "@exxeed/overlays";
import { createCloudClient, enabledProviders, type CloudClient, type SessionStorage } from "@exxeed/repo";

import { AUTH_CALLBACK_PORT, AUTH_CALLBACK_URL, cloudConfig } from "./cloud-config.js";

/** The OAuth providers the app knows how to offer. */
const OAUTH_PROVIDERS = ["discord", "google"] as const;
type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

/** How long a browser sign-in may take before the listener gives up. */
const BROWSER_TIMEOUT_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Session storage: an encrypted file
// ---------------------------------------------------------------------------

/**
 * supabase-js's storage, backed by one file encrypted with the OS keychain.
 *
 * Where the OS offers no encryption, the session is kept in memory only: you
 * stay signed in until you quit. Writing a refresh token in the clear would be
 * the alternative, and it is not one.
 */
class EncryptedSessionStorage implements SessionStorage {
  #values: Record<string, string> = {};
  #loaded = false;

  #path(): string {
    return join(app.getPath("userData"), "account-session.bin");
  }

  #load(): void {
    if (this.#loaded) return;
    this.#loaded = true;
    if (!safeStorage.isEncryptionAvailable()) return;
    try {
      this.#values = JSON.parse(safeStorage.decryptString(readFileSync(this.#path()))) as Record<string, string>;
    } catch {
      this.#values = {};
    }
  }

  #save(): void {
    if (!safeStorage.isEncryptionAvailable()) return;
    if (Object.keys(this.#values).length === 0) {
      rmSync(this.#path(), { force: true });
      return;
    }
    writeFileSync(this.#path(), safeStorage.encryptString(JSON.stringify(this.#values)));
  }

  getItem(key: string): string | null {
    this.#load();
    return this.#values[key] ?? null;
  }

  setItem(key: string, value: string): void {
    this.#load();
    this.#values[key] = value;
    this.#save();
  }

  removeItem(key: string): void {
    this.#load();
    delete this.#values[key];
    this.#save();
  }
}

// ---------------------------------------------------------------------------
// The client and the view
// ---------------------------------------------------------------------------

let client: CloudClient | null = null;

/** The one Supabase client. Created on first use, after `app` is ready. */
export function cloudClient(): CloudClient {
  client ??= createCloudClient(cloudConfig(), new EncryptedSessionStorage());
  return client;
}

let providers: Record<string, boolean> | null = null;
let waitingForBrowser = false;
let view: AccountView = {
  available: false,
  signedIn: false,
  userId: null,
  email: null,
  displayName: null,
  avatarUrl: null,
  onboarded: false,
  providers: {},
  waitingForBrowser: false,
};

export const accountView = (): AccountView => view;

/**
 * Re-read who is signed in, and tell every window.
 *
 * Reachability is judged by the Auth settings endpoint: if it cannot be read,
 * the backend is down or not configured, and the account area says so rather
 * than offering a sign-in that will fail.
 */
async function refreshView(): Promise<AccountView> {
  const config = cloudConfig();
  if (providers === null) {
    try {
      providers = await enabledProviders(config);
    } catch {
      providers = null;
    }
  }

  const base = {
    available: providers !== null,
    providers: Object.fromEntries(
      OAUTH_PROVIDERS.map((p) => [p, providers?.[p] === true]),
    ),
    waitingForBrowser,
  };

  const { data } = await cloudClient().auth.getSession();
  const user = data.session?.user ?? null;
  if (user === null) {
    view = { ...base, signedIn: false, userId: null, email: null, displayName: null, avatarUrl: null, onboarded: false };
  } else {
    const { data: profile } = await cloudClient()
      .from("profiles")
      .select("display_name, onboarded")
      .eq("id", user.id)
      .maybeSingle();
    const meta = user.user_metadata as Record<string, unknown>;
    view = {
      ...base,
      signedIn: true,
      userId: user.id,
      email: user.email ?? null,
      displayName: profile?.display_name ?? null,
      avatarUrl: typeof meta["avatar_url"] === "string" ? meta["avatar_url"] : null,
      onboarded: profile?.onboarded ?? false,
    };
  }

  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(ACCOUNT_CHANGED_CHANNEL, view);
  }
  for (const listener of listeners) listener(view);
  return view;
}

const listeners: ((view: AccountView) => void)[] = [];

/** Main-process code that cares who is signed in (cloud-sync.ts). */
export function onAccountChange(listener: (view: AccountView) => void): void {
  listeners.push(listener);
}

// ---------------------------------------------------------------------------
// OAuth through the browser
// ---------------------------------------------------------------------------

let listener: { server: Server; timer: NodeJS.Timeout } | null = null;

function stopListening(): void {
  if (listener === null) return;
  clearTimeout(listener.timer);
  listener.server.close();
  listener = null;
  waitingForBrowser = false;
}

const page = (title: string, body: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:15px system-ui;background:#101215;color:#e6e9ee;display:grid;place-items:center;height:90vh">` +
  `<div style="text-align:center"><h2>${title}</h2><p>${body}</p></div></body>`;

/**
 * Listen for the one redirect back from the browser, exchange its code, and
 * close. Resolves once the listener is up — before the browser is opened, so
 * the redirect can never arrive at a closed port.
 */
function listenForCallback(): Promise<void> {
  stopListening();
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", AUTH_CALLBACK_URL);
      if (url.pathname !== "/auth/callback") {
        response.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const failure = url.searchParams.get("error_description") ?? url.searchParams.get("error");

      const finish = (ok: boolean, message: string): void => {
        response.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
        response.end(page(ok ? "Signed in to Exxeed" : "Sign-in failed", message));
        stopListening();
        void refreshView();
      };

      if (code === null) {
        finish(false, failure ?? "The sign-in was cancelled.");
        return;
      }
      cloudClient()
        .auth.exchangeCodeForSession(code)
        .then(({ error }) => finish(error === null, error?.message ?? "You can close this tab and go back to Exxeed."))
        .catch((err: unknown) => finish(false, err instanceof Error ? err.message : String(err)));
    });

    server.once("error", (err: NodeJS.ErrnoException) => {
      reject(
        err.code === "EADDRINUSE"
          ? new Error(`port ${AUTH_CALLBACK_PORT} is in use by another program, so the browser cannot hand the sign-in back`)
          : err,
      );
    });
    // Loopback only: nothing on the network can reach it.
    server.listen(AUTH_CALLBACK_PORT, "127.0.0.1", () => {
      listener = {
        server,
        timer: setTimeout(() => {
          stopListening();
          void refreshView();
        }, BROWSER_TIMEOUT_MS),
      };
      waitingForBrowser = true;
      resolve();
    });
  });
}

async function signInWith(provider: string): Promise<AccountView> {
  if (!(OAUTH_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`unknown sign-in provider "${provider}"`);
  }
  const { data, error } = await cloudClient().auth.signInWithOAuth({
    provider: provider as OAuthProvider,
    options: { redirectTo: AUTH_CALLBACK_URL, skipBrowserRedirect: true },
  });
  if (error !== null) throw error;
  await listenForCallback();
  await shell.openExternal(data.url);
  return refreshView();
}

// ---------------------------------------------------------------------------
// Requests from windows
// ---------------------------------------------------------------------------

async function handle(request: AccountRequest): Promise<AccountView> {
  switch (request.op) {
    case "view":
      // A retry after "unavailable" should actually retry.
      if (!view.available) providers = null;
      return refreshView();

    case "signInWith":
      return signInWith(request.provider);

    case "cancelBrowserSignIn":
      stopListening();
      return refreshView();

    case "sendEmailCode": {
      const email = request.email.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("that does not look like an email address");
      // The email carries a code where the project's template includes one
      // (supabase/templates/sign-in-code.html), and always a link. Custom
      // templates need custom SMTP on a hosted project, so until that exists
      // the link is the only way in: listen for it, so clicking it on this PC
      // finishes the sign-in the same way OAuth does.
      await listenForCallback();
      const { error } = await cloudClient().auth.signInWithOtp({
        email,
        options: { shouldCreateUser: true, emailRedirectTo: AUTH_CALLBACK_URL },
      });
      if (error !== null) {
        stopListening();
        throw error;
      }
      return refreshView();
    }

    case "verifyEmailCode": {
      const { error } = await cloudClient().auth.verifyOtp({
        email: request.email.trim(),
        token: request.code.replace(/\s+/g, ""),
        type: "email",
      });
      if (error !== null) throw error;
      // Signed in by code: the link in the same email is no longer needed.
      stopListening();
      return refreshView();
    }

    case "saveProfile": {
      const name = request.displayName.trim();
      if (name.length < 2 || name.length > 40) throw new Error("a display name is 2 to 40 characters");
      if (view.userId === null) throw new Error("not signed in");
      const { error } = await cloudClient()
        .from("profiles")
        .update({ display_name: name, onboarded: true })
        .eq("id", view.userId);
      if (error !== null) throw error;
      return refreshView();
    }

    case "signOut": {
      // Local scope: signing out here should not sign out the rig as well.
      const { error } = await cloudClient().auth.signOut({ scope: "local" });
      if (error !== null) throw error;
      return refreshView();
    }
  }
}

export function installAccount(): void {
  ipcMain.handle(ACCOUNT_CHANNEL, async (_event, request: AccountRequest) => {
    try {
      return { ok: true, value: await handle(request) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Deferred a tick: supabase-js holds a lock while it runs this callback, and
  // calling back into auth from inside it deadlocks.
  cloudClient().auth.onAuthStateChange(() => {
    setTimeout(() => void refreshView(), 0);
  });

  void refreshView();
}
