// Copy the few browser libraries the renderer uses into static/vendor.
//
// The renderer is plain ES modules with no bundler (see the Vue question in
// TODO M3), so a library reaches it as one self-contained .mjs file next to
// the pages. Copied at build time rather than committed: they are other
// people's release artefacts, and node_modules has the exact versions the
// lockfile pins.

import { copyFileSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "static", "vendor");

// The package's own node_modules link, which pnpm always creates. Not
// require.resolve("x/package.json"): DOMPurify's exports map hides it.
const packageDir = (name) => join(here, "..", "node_modules", name);

const files = [
  // Markdown for Content pages' descriptions (M8).
  [join(packageDir("marked"), "lib", "marked.esm.js"), "marked.esm.js"],
  // …and the sanitiser that runs over its output, because a description is a
  // stranger's text inside the app.
  [join(packageDir("dompurify"), "dist", "purify.es.mjs"), "purify.es.mjs"],
];

mkdirSync(out, { recursive: true });
for (const [from, to] of files) copyFileSync(from, join(out, to));

// Monaco, the editor inside VS Code, for the theme editor (M9). Its prebuilt
// AMD build runs with no bundler: a loader script, the editor, its worker and
// the JSON language. Only those are copied — the TypeScript, CSS and HTML
// language services are most of its 13 MB and nothing here edits them.
const monaco = join(packageDir("monaco-editor"), "min", "vs");
const monacoOut = join(out, "monaco", "vs");
rmSync(join(out, "monaco"), { recursive: true, force: true });
mkdirSync(join(monacoOut, "language"), { recursive: true });
copyFileSync(join(monaco, "loader.js"), join(monacoOut, "loader.js"));
for (const dir of ["editor", "base", join("language", "json")]) {
  cpSync(join(monaco, dir), join(monacoOut, dir), { recursive: true });
}
