// Copy the few browser libraries the renderer uses into static/vendor.
//
// The renderer is plain ES modules with no bundler (see the Vue question in
// TODO M3), so a library reaches it as one self-contained .mjs file next to
// the pages. Copied at build time rather than committed: they are other
// people's release artefacts, and node_modules has the exact versions the
// lockfile pins.

import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";

import { build } from "esbuild";
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
// AMD build is deprecated and its workers no longer load under it, so the ES
// module build is bundled here with esbuild: the editor with the three
// languages a theme is written in — JSON, CSS and HTML (templates) — as one
// module, its stylesheet and font beside it, and a worker per language.
// Everything else (TypeScript's service, the other grammars) is left out:
// it is most of the package, and nothing here edits it.
const monacoEsm = join(packageDir("monaco-editor"), "esm", "vs");
const monacoOut = join(out, "monaco");
rmSync(monacoOut, { recursive: true, force: true });
mkdirSync(monacoOut, { recursive: true });

// The package's own entry, minus what is not needed: its import list is the
// source of truth for which editor features exist, so it is filtered rather
// than copied out by hand and left to drift on the next upgrade.
const main = readFileSync(join(monacoEsm, "editor", "editor.main.js"), "utf8");
const entry = main
  .split("\n")
  .filter((line) => {
    if (line.includes("languages/definitions/")) return /definitions\/(css|html)\//.test(line);
    return !/features_typescript|features\/typescript|monaco-lsp-client|as lsp\b|as typescript\b/.test(line);
  })
  .join("\n");

await build({
  stdin: { contents: entry, resolveDir: join(monacoEsm, "editor"), sourcefile: "monaco-entry.js", loader: "js" },
  bundle: true,
  format: "esm",
  minify: true,
  outfile: join(monacoOut, "monaco.mjs"),
  // The icon font its stylesheet points at, copied beside it.
  loader: { ".ttf": "file" },
  assetNames: "[name]",
  logLevel: "warning",
});

// The workers, named as the bundle asks for them (`new URL("json.worker.js",
// import.meta.url)`), so they sit beside monaco.mjs.
await build({
  entryPoints: {
    "editor.worker": join(monacoEsm, "editor", "editor.worker.js"),
    "json.worker": join(monacoEsm, "language", "json", "json.worker.js"),
    "css.worker": join(monacoEsm, "language", "css", "css.worker.js"),
    "html.worker": join(monacoEsm, "language", "html", "html.worker.js"),
  },
  bundle: true,
  format: "esm",
  minify: true,
  outdir: monacoOut,
  logLevel: "warning",
});
