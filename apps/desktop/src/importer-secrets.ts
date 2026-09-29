/**
 * The importer's account: whichever model converts transcripts, and its keys.
 *
 * Kept out of settings.json on purpose. That file is plain JSON a person is
 * invited to open in Notepad (settings.ts), and it would be the obvious place to
 * find an API key. This one is encrypted with the OS keychain through
 * `safeStorage` — DPAPI on Windows — so it is readable only by this user on
 * this machine. Where the OS offers no encryption the file is refused rather
 * than written in the clear.
 *
 * Only main ever reads it. The window gets `hasX` flags back, never a secret,
 * so nothing stored here can end up in a renderer's memory or devtools.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { app, safeStorage } from "electron";

import type { ProviderId } from "@exxeed/importer";

export interface ImporterSecrets {
  readonly ai: {
    readonly provider: ProviderId;
    readonly model: string;
    readonly baseUrl: string;
    /** Per provider, so switching between two does not lose either key. */
    readonly keys: Readonly<Partial<Record<ProviderId, string>>>;
  };
}

const DEFAULTS: ImporterSecrets = {
  ai: { provider: "anthropic", model: "claude-opus-5-5", baseUrl: "", keys: {} },
};

const path = (): string => join(app.getPath("userData"), "importer-accounts.bin");

export function readSecrets(): ImporterSecrets {
  if (!safeStorage.isEncryptionAvailable()) return DEFAULTS;
  try {
    const raw = JSON.parse(safeStorage.decryptString(readFileSync(path()))) as Partial<ImporterSecrets>;
    return { ai: { ...DEFAULTS.ai, ...raw.ai } };
  } catch {
    return DEFAULTS;
  }
}

export function writeSecrets(secrets: ImporterSecrets): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("this system offers no secure storage, so accounts cannot be saved");
  }
  writeFileSync(path(), safeStorage.encryptString(JSON.stringify(secrets)));
}
