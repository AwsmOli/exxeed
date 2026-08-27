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

## What this does not cover

Callout content. The demo note set is a two-corner Spa stub and will mean nothing
at Okayama; `$env:EXXEED_NOTES="spa-gt3-fixture"` only demonstrates that the audio
path fires. Real note sets need the track map that this recording produces, and
judging whether a callout *feels* early or late needs real speech, which is
blocked on picking a voice provider (§13, open question 4).
