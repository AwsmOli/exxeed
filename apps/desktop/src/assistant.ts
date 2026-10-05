/**
 * The assistant connection — the MCP server's lifecycle, and its row in
 * Preferences.
 *
 * Everything an assistant can ask is in @exxeed/assistant, which knows nothing
 * of Electron. This file is the part that does: it starts and stops the server
 * as the setting changes, makes the token, and answers the Preferences window.
 *
 * Settings are written with `updateQuietly`. The session listens for settings
 * changes and rebuilds itself on every one, and switching the assistant on
 * mid-stint should not cost a reload of the engine and its audio.
 */

import { randomBytes } from "node:crypto";

import { ipcMain } from "electron";

import { startAssistantServer, type AssistantServer, type AssistantState } from "@exxeed/assistant";
import {
  ASSISTANT_CHANNEL,
  type AssistantRequest,
  type AssistantSettings,
  type AssistantView,
} from "@exxeed/overlays";

import type { SettingsStore } from "./settings.js";

const newToken = (): string => randomBytes(24).toString("base64url");

const describe = (error: unknown, port: number): string =>
  (error as NodeJS.ErrnoException).code === "EADDRINUSE"
    ? `Port ${port} is in use by something else.`
    : error instanceof Error
      ? error.message
      : String(error);

export class AssistantService {
  readonly #store: SettingsStore;
  readonly #state: AssistantState;
  #server: AssistantServer | null = null;
  /** What the running server was started with, to tell a change from a no-op. */
  #servedToken: string | null = null;
  #error: string | null = null;
  /** One start or stop at a time: two overlapping would fight over the port. */
  #queue: Promise<void> = Promise.resolve();

  constructor(store: SettingsStore, state: AssistantState) {
    this.#store = store;
    this.#state = state;
  }

  #settings(): AssistantSettings {
    return this.#store.get().assistant;
  }

  view(): AssistantView {
    const s = this.#settings();
    return {
      enabled: s.enabled,
      running: this.#server !== null,
      url: this.#server?.url ?? null,
      token: s.enabled ? s.token : null,
      error: this.#error,
    };
  }

  /** Make the server match the settings. Safe to call at any time, any number of times. */
  sync(): Promise<void> {
    this.#queue = this.#queue.then(() => this.#apply());
    return this.#queue;
  }

  async #apply(): Promise<void> {
    const s = this.#settings();
    const wanted = s.enabled && s.token !== null;

    if (this.#server !== null && (!wanted || s.port !== this.#server.port || s.token !== this.#servedToken)) {
      await this.#server.close();
      this.#server = null;
      this.#servedToken = null;
      process.stdout.write("assistant: stopped\n");
    }
    if (!wanted) {
      this.#error = null;
      return;
    }
    if (this.#server !== null || s.token === null) return;

    try {
      this.#server = await startAssistantServer({
        state: this.#state,
        token: s.token,
        port: s.port,
        onCall: (name, ok) => process.stdout.write(`assistant: ${name}${ok ? "" : " (no answer)"}\n`),
      });
      this.#servedToken = s.token;
      this.#error = null;
      process.stdout.write(`assistant: listening on ${this.#server.url}\n`);
    } catch (error) {
      this.#error = describe(error, s.port);
      process.stderr.write(`assistant: could not start — ${this.#error}\n`);
    }
  }

  async #handle(request: AssistantRequest): Promise<AssistantView> {
    const s = this.#settings();
    if (request.kind === "setEnabled") {
      this.#store.updateQuietly({
        // The token is made on first use and then kept, so switching off and on
        // again does not strand an assistant that was already set up.
        assistant: { ...s, enabled: request.value, token: s.token ?? newToken() },
      });
    } else if (request.kind === "newToken") {
      this.#store.updateQuietly({ assistant: { ...s, token: newToken() } });
    }
    await this.sync();
    return this.view();
  }

  installIpc(): void {
    ipcMain.handle(ASSISTANT_CHANNEL, (_event, request: AssistantRequest) => this.#handle(request));
  }

  close(): Promise<void> {
    this.#queue = this.#queue.then(async () => {
      await this.#server?.close();
      this.#server = null;
    });
    return this.#queue;
  }
}
