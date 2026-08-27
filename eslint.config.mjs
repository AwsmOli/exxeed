// @ts-check
//
// ESLint flat config. This is the one .js-family file in the repo; ESLint loads
// its config before any TypeScript tooling is available, so it cannot be .ts.
// Everything under src/ and test/ is TypeScript — see SPEC.md §3.

import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * SPEC.md §3: "packages/core must stay pure. No I/O, no Electron, no native
 * modules. Plain objects in, plain objects out. This is what makes the engine
 * testable without the sim and the backend swap trivial. Enforce with a lint
 * rule."
 *
 * This is that lint rule. It is the reason the note engine can be developed and
 * tested on a machine that cannot run iRacing at all.
 */
const CORE_FORBIDDEN_IMPORTS = [
  { name: "fs", message: "packages/core must stay pure — no I/O. See SPEC.md §3." },
  { name: "node:fs", message: "packages/core must stay pure — no I/O. See SPEC.md §3." },
  { name: "fs/promises", message: "packages/core must stay pure — no I/O. See SPEC.md §3." },
  { name: "node:fs/promises", message: "packages/core must stay pure — no I/O. See SPEC.md §3." },
  { name: "path", message: "packages/core must stay pure — no path handling. See SPEC.md §3." },
  { name: "node:path", message: "packages/core must stay pure — no path handling. See SPEC.md §3." },
  { name: "electron", message: "packages/core must stay pure — no Electron. See SPEC.md §3." },
  { name: "irsdk-node", message: "packages/core must stay pure — no sim SDK. See SPEC.md §3." },
  { name: "@exxeed/telemetry", message: "packages/core is the bottom of the stack; telemetry depends on core, not the reverse." },
  { name: "@exxeed/repo", message: "packages/core must not know how artefacts are stored. See SPEC.md §8." },
];

export default tseslint.config(
  {
    // ESLint does not read .gitignore, so anything ignored there that contains
    // JavaScript has to be repeated here — the Python venv vendors some.
    ignores: [
      "**/dist/**",
      "**/.tsbuild/**",
      "**/node_modules/**",
      "**/*.d.ts",
      ".venv/**",
      "voices/**",
      "data/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // SPEC.md §3: no `any` that isn't immediately narrowed at a boundary.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // The readout's renderer script. It lives in a file rather than inline in
    // index.html because the page CSP is `default-src 'self'`, which refuses
    // inline script — so this is browser code, not Node code.
    files: ["apps/desktop/static/**/*.js"],
    languageOptions: {
      globals: {
        window: "readonly",
        document: "readonly",
        location: "readonly",
        console: "readonly",
        URLSearchParams: "readonly",
        AudioContext: "readonly",
        Uint8Array: "readonly",
        Path2D: "readonly",
        requestAnimationFrame: "readonly",
        Math: "readonly",
      },
    },
  },
  {
    files: ["packages/core/**/*.ts"],
    rules: {
      "no-restricted-imports": "off",
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: CORE_FORBIDDEN_IMPORTS,
          patterns: [
            {
              group: ["@irsdk-node/*", "node:*"],
              message:
                "packages/core must stay pure — no Node built-ins, no sim SDK. See SPEC.md §3.",
            },
          ],
        },
      ],
    },
  },
);
