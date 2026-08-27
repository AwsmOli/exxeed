# Testing on Windows — M0b

Everything platform-neutral is developed and tested on any machine against
recorded laps (§9). This is the part that cannot be: connecting to the live
iRacing SDK, measuring the steering sign convention, and recording a real lap.

`@irsdk-node/native` ships prebuilds for `win32-x64` and `win32-arm64` only.
There is **no** darwin build — and off Windows its installer quietly substitutes a
**mock** that returns fabricated telemetry rather than failing, which is why
`IRacingAdapter` guards on platform and throws instead.

**The deliverable of this whole exercise is one `.ndjson` recording.** It unblocks
M1 (corner detection, centreline), M2's real note sets, and rebaselining the
golden timeline.

---

## 1. Setup

No Visual Studio build tools needed. The native addon is N-API built with
`prebuildify --napi --electron-compat`, so there is no `electron-rebuild` step —
that was the deciding reason for choosing this SDK over the alternatives (§3).

```powershell
git clone https://github.com/AwsmOli/exxeed.git
cd exxeed
corepack enable
pnpm install
```

Node 20+ required.

`corepack enable` matters more than it looks. The repo pins `pnpm@9.12.3` via
`packageManager`, and **pnpm 10 and later refuse to run dependency build scripts
by default**. Electron's postinstall is what downloads its ~100 MB binary, so a
newer pnpm silently skips it and the app then fails with *"Electron failed to
install correctly"*.

The allow-list lives in **two** places on purpose. pnpm 9 reads
`pnpm.onlyBuiltDependencies` in `package.json`; pnpm 10 ignores that field
entirely — it warns *"The 'pnpm' field in package.json is no longer read by
pnpm"* and carries on installing an Electron that cannot run — so the same list
is mirrored into `pnpm-workspace.yaml`. Keep them in step if you add a package
that needs a build script.

Check what actually ran:

```powershell
pnpm --version    # expect 9.12.3
```

## 2. Sanity check before touching the sim

```powershell
pnpm test        # should pass; nothing here needs iRacing
pnpm typecheck
pnpm lint
```

Then confirm the real addon loaded rather than the mock. `@irsdk-node/native` is
a transitive dependency, and pnpm does not hoist it, so this has to run from a
package that actually depends on `irsdk-node` — from the repo root it fails with
`MODULE_NOT_FOUND`, which is a resolution error and not the mock:

```powershell
cd packages\telemetry
node -e "import('irsdk-node').then(m => console.log('IRacingSDK:', typeof m.IRacingSDK))"
cd ..\..
```

`function` means the real SDK. The mock substitution only happens off Windows,
where `IRacingAdapter` refuses to run anyway — so on Windows the check that
actually matters is §4 showing values that move.

## 3. Connect

Start iRacing, get in a car, go on track. Then:

```powershell
$env:EXXEED_OVERLAY="1"
pnpm dev
```

No other configuration — `IRacingAdapter` is selected automatically on `win32`.
If the sim is not running you get *"iRacing SDK did not start — is the sim
running?"* rather than silence.

> **Run the sim in borderless windowed, not exclusive fullscreen.** Transparent
> overlays are not supported over exclusive fullscreen. Windows 10/11 Fullscreen
> Optimizations often converts DX11 exclusive fullscreen to a composited path, so
> it may appear to work anyway — borderless windowed is the supported setup.

`Ctrl+Shift+E` unlocks the overlay so it can be dragged, and locks it again. The
position is remembered.

## 4. Check the channels

The readout shows §11's M0 channel list. Two of them are the point of this trip:

- **`SteeringWheelAngle`** — shown with an explicit sign.
- **`Lat / Lon`** — if this reads **"not populated"**, say so. §4.1.1's centreline
  depends on it, and the dead-reckoning fallback accumulates drift and needs a
  closure correction at start/finish.

## 5. Measure the steering sign

§12: *never assume it.* Get it backwards and every corner's `direction` inverts
silently, with no crash to tell you — corner detection produces a map that is
internally consistent, passes every test, and calls every right-hander a left.

Drive a **known right-hander**, hold the wheel, read the sign off
`SteeringWheelAngle`. Then in `packages/telemetry/src/steering.ts`:

```ts
export const STEER_SIGN_MEASURED = true;    // was false
export const STEER_SIGN_RIGHT: 1 | -1 = 1;  // or -1 — whatever you actually saw
```

Until that flag is true, `directionFromSteer()` throws by design: corner detection
refuses to emit a track map from an assumed sign.

The recording captures `steerRad` too, so this can also be confirmed offline
afterwards rather than taken on trust from a number read at speed.

## 6. Record a lap

Recording is always-on (§9) — every session writes to `data/recordings/`. Drive a
clean lap of **Okayama** (short, and M1's *done when* is its corners coming out
right without hand-editing).

Recordings are grouped by track then car, and the header line repeats it so a
file is self-describing on its own:

```
data/recordings/<track>/<car>/<timestamp>.ndjson
data/recordings/okayama-full/mx5-mx52016/2026-08-27T20-36-36-215Z.ndjson
```

The ids come from the sim's own `TrackName` and `CarPath`, not the display
names, which get re-branded between seasons. A session the sim would not
identify lands in `unknown/` rather than being dropped. The app prints the path
it chose at startup.

`data/recordings/` is gitignored, so bring the file back deliberately:

```powershell
git add -f data/recordings/<track>/<car>/<the-lap>.ndjson
```

or copy it across by hand.

## Troubleshooting

### "Electron failed to install correctly"

Electron's binary was not downloaded — `node_modules/electron/path.txt` is
missing. In order of likelihood:

1. **A newer pnpm skipped the build scripts.** Check `pnpm --version`. If it is
   not 9.12.3, `corepack enable` did not take effect. Either fix that, or approve
   the builds explicitly:

   ```powershell
   pnpm approve-builds       # pnpm 10+
   pnpm rebuild electron
   ```

2. **The download failed** — it is ~100 MB from GitHub releases, so a corporate
   proxy, firewall or antivirus can eat it. Retry, and if you are behind a proxy
   set `ELECTRON_GET_USE_PROXY=1` plus the usual `HTTPS_PROXY`.

   The zip can arrive intact and still not unpack. Check the cache and the
   unpacked directory separately — a `dist/` holding only
   `LICENSES.chromium.html` means extraction stopped after the first entry, and
   re-running the postinstall can exit 0 without fixing it:

   ```powershell
   ls $env:LOCALAPPDATA\electron\Cache          # the downloaded zip
   ls node_modules\.pnpm\electron@*\node_modules\electron\dist   # should hold electron.exe
   ```

   Unpacking it by hand is enough to recover, since `path.txt` is all the
   `electron` package looks for:

   ```powershell
   Expand-Archive $env:LOCALAPPDATA\electron\Cache\*\electron-v*-win32-x64.zip -DestinationPath <that dist path>
   "electron.exe" | Out-File -NoNewline -Encoding ascii <...>\electron\path.txt
   ```

3. **A half-finished install got cached.** Clear it and start clean:

   ```powershell
   Remove-Item -Recurse -Force node_modules
   pnpm store prune
   pnpm install
   ```

Confirm it is actually fixed before moving on. Run this from `apps/desktop`, not
the repo root — Electron is that package's devDependency, and from the root the
same command fails for an unrelated reason:

```powershell
cd apps\desktop
node -e "console.log(require('electron'))"    # prints a path to the binary
cd ..\..
```

Note that **only `apps/desktop` needs Electron**. If it stays broken, the note
engine, the schemas and the replay harness do not depend on it — `pnpm test` and
the replay CLI still work, and you can read telemetry that way while sorting it
out.

## What this does not cover

Callout content. The demo note set is a two-corner Spa stub and will mean nothing
at Okayama; `$env:EXXEED_NOTES="spa-gt3-fixture"` only demonstrates that the audio
path fires. Real note sets need the track map that this recording produces, and
judging whether a callout *feels* early or late needs real speech, which is
blocked on picking a voice provider (§13, open question 4).
