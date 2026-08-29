import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pkg = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  // Tests run against TypeScript source, not built output, so `pnpm test` needs
  // no build step. Production resolution goes through each package's `exports`
  // field to dist/ instead.
  resolve: {
    alias: {
      "@exxeed/core": pkg("core"),
      "@exxeed/telemetry": pkg("telemetry"),
      "@exxeed/repo": pkg("repo"),
      "@exxeed/tts": pkg("tts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "tools/*/test/**/*.test.ts"],
  },
});
