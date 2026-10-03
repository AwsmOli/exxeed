// Build an installable Exxeed.
//
//   pnpm --filter @exxeed/desktop package          the Windows installer (NSIS, x64)
//   pnpm --filter @exxeed/desktop package mac      an unpacked macOS app, to try the
//                                                  packaged build on a Mac
//
// The app is a pnpm monorepo of TypeScript packages that link to each other,
// which electron-builder does not package well. So this does it in two steps:
//
//  1. Stage a plain app in release/app: the main process bundled into one file
//     with esbuild (every @exxeed package and every pure-JS dependency inside
//     it), the preload script, the static pages, and a package.json naming
//     only the two native modules — koffi (Windows' foreground window) and
//     irsdk-node (the sim). Those are installed with npm for the target
//     platform, so a Windows build made on a Mac gets the Windows binaries.
//
//  2. Hand that folder to electron-builder for the installer.
//
// Output goes to apps/desktop/release/<target>/.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build as bundle } from "esbuild";
import { build as builder, Platform } from "electron-builder";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, "..");
const repo = join(desktop, "..", "..");
const require = createRequire(import.meta.url);

const target = process.argv[2] === "mac" ? "mac" : "win";
const stage = join(desktop, "release", "app");
const out = join(desktop, "release", target);

const desktopPkg = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));
const rootPkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const electronVersion = require(join(desktop, "node_modules", "electron", "package.json")).version;
const version = process.env.EXXEED_VERSION ?? (rootPkg.version === "0.0.0" ? "0.1.0" : rootPkg.version);

/** A dependency's version range from a package.json, whichever list it is in. */
const rangeOf = (pkg, name) =>
  pkg.dependencies?.[name] ?? pkg.optionalDependencies?.[name] ?? pkg.peerDependencies?.[name];

/** The native modules, and the versions the app is built against. */
const telemetryPkg = JSON.parse(readFileSync(join(repo, "packages", "telemetry", "package.json"), "utf8"));
const NATIVE = {
  koffi: rangeOf(desktopPkg, "koffi"),
  "irsdk-node": rangeOf(telemetryPkg, "irsdk-node"),
};
for (const [name, range] of Object.entries(NATIVE)) {
  if (typeof range !== "string") throw new Error(`no version for ${name} in the workspace's package.json files`);
}

const step = (text) => process.stdout.write(`\n— ${text}\n`);

// 1a. Compile, as `pnpm build` does (vendored browser libraries, then tsc).
step("compiling");
execFileSync("pnpm", ["run", "build"], { cwd: desktop, stdio: "inherit" });

rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "dist"), { recursive: true });

// 1b. The main process as one ES module. CommonJS dependencies inside it call
// require(), which an ES module does not have, so one is made for them.
step("bundling the main process");
await bundle({
  entryPoints: [join(desktop, "dist", "main.js")],
  outfile: join(stage, "dist", "main.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // Electron is the runtime; the native modules are installed beside the bundle.
  // ws's optional speed-ups are native too, and it runs without them.
  external: ["electron", ...Object.keys(NATIVE), "bufferutil", "utf-8-validate"],
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: "warning",
});
cpSync(join(desktop, "dist", "preload.mjs"), join(stage, "dist", "preload.mjs"));

// 1c. The pages, styles, fonts and vendored libraries, as the app loads them (../static).
cpSync(join(desktop, "static"), join(stage, "static"), { recursive: true });

// 1d. A package.json for the packaged app: its name and version, and only the
// native modules as dependencies — everything else is in the bundle.
writeFileSync(
  join(stage, "package.json"),
  `${JSON.stringify(
    {
      name: "exxeed",
      productName: "Exxeed",
      version,
      description: "Track coach for iRacing: it talks you round a new circuit while you drive.",
      author: "blkPixel",
      license: rootPkg.license,
      main: "dist/main.js",
      type: "module",
      dependencies: NATIVE,
    },
    null,
    2,
  )}\n`,
);

// 1e. The native modules, installed for the target rather than for this
// machine. --ignore-scripts: both ship prebuilt binaries, and their install
// scripts would otherwise try to compile for the machine doing the build.
step(`installing native modules for ${target === "win" ? "Windows x64" : "macOS"}`);
const platform = target === "win" ? ["--os=win32", "--cpu=x64"] : [`--os=darwin`, `--cpu=${process.arch}`];
execFileSync("npm", ["install", "--omit=dev", "--no-package-lock", "--no-audit", "--no-fund", "--ignore-scripts", ...platform], {
  cwd: stage,
  stdio: "inherit",
});

// Every native module must be there for the target: a Windows build without
// irsdk-node would install and run, and never see the sim.
const mustHave =
  target === "win"
    ? ["koffi", "@koromix/koffi-win32-x64", "irsdk-node", "@irsdk-node/native/prebuilds/win32-x64"]
    : ["koffi"];
for (const path of mustHave) {
  if (!existsSync(join(stage, "node_modules", path))) throw new Error(`the staged app is missing node_modules/${path}`);
}

// The built-in test lap, read from the app's resources (paths.ts, main.ts FIXTURE).
const fixture = join(repo, "packages", "telemetry", "test", "fixtures", "synthetic-3laps.ndjson");
if (!existsSync(fixture)) throw new Error(`missing ${fixture}`);

// 2. The installer.
step(`building the ${target === "win" ? "Windows installer" : "macOS app"}`);
await builder({
  projectDir: stage,
  targets: target === "win" ? Platform.WINDOWS.createTarget(["nsis"], 1) : Platform.MAC.createTarget(["dir"]),
  config: {
    appId: "com.blkpixel.exxeed",
    productName: "Exxeed",
    copyright: "Copyright © blkPixel",
    electronVersion,
    directories: { output: out, buildResources: join(desktop, "build") },
    files: ["dist/**", "static/**", "package.json", "node_modules/**"],
    // Native binaries cannot be loaded from inside the asar archive.
    asarUnpack: ["node_modules/koffi/**", "node_modules/@koromix/**", "node_modules/@irsdk-node/**"],
    extraResources: [{ from: fixture, to: "fixtures/synthetic-3laps.ndjson" }],
    // The app's own Node version runs it; nothing to rebuild for Electron.
    npmRebuild: false,
    win: {
      icon: join(desktop, "build", "icon.png"),
      target: [{ target: "nsis", arch: ["x64"] }],
      // Stamping the exe with its icon and version runs rcedit under Wine on a
      // Mac. Set EXXEED_NO_WINE=1 to skip it where Wine is not installed.
      signAndEditExecutable: process.env.EXXEED_NO_WINE !== "1",
    },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: "Exxeed",
      runAfterFinish: true,
      artifactName: "Exxeed-Setup-${version}.${ext}",
      installerIcon: join(desktop, "build", "icon.ico"),
      uninstallerIcon: join(desktop, "build", "icon.ico"),
      // Settings, packs, voices and recordings live in %APPDATA%\Exxeed and are
      // the user's: an uninstall leaves them unless they ask otherwise.
      deleteAppDataOnUninstall: false,
    },
    mac: {
      icon: join(desktop, "build", "icon.png"),
      target: [{ target: "dir", arch: [process.arch] }],
      identity: null,
    },
  },
});

step(`done — ${out}`);
