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
install correctly"*. `package.json` allow-lists the three packages that need
build scripts under `pnpm.onlyBuiltDependencies`, which covers newer pnpm too —
but running the pinned version is still the path with fewest surprises.

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

Then confirm the real addon loaded rather than the mock:

```powershell
node -e "console.log(require('@irsdk-node/native'))"
```

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

`data/recordings/` is gitignored, so bring the file back deliberately:

```powershell
git add -f data/recordings/<the-lap>.ndjson
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
