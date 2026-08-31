# Exxeed — Build Spec

> The product name is **Exxeed**. "Pacenote" is kept as the domain term for the
> note artefacts — `NoteSet`, the note engine, a note's `text` — because that is
> what they are, and the spec uses it that way throughout.
>
> This document is the brief for building v1. It states decisions, not options.
> Where something is genuinely undecided it is listed under **Open questions** at
> the end — treat everything else as settled and build it.

---

## 1. What this is

A desktop app for iRacing that tells a driver **where** to brake, in terms they can
see out of the windscreen, at the moment they need to hear it.

```
"Brake at the hundred board"    → fires ~1.7s before the braking point
"Kerb — throttle"               → fires at the apex
"Stay inside for the next one"  → fires on exit
```

### Why this doesn't already exist

Existing telemetry coaches (Track Titan, Trophi.ai) are **delta coaches**. They
compare your lap to a reference and report the difference: *"brake 10m later."*
That is only useful once you already know roughly where to brake.

The reference lap does contain the braking point — as *"2,340 metres into the
lap."* Useless to a human at 250 km/h. The missing piece is the translation from
**lap distance** into a **visual landmark**, and that translation currently exists
only inside YouTube lap guides, which you have to watch and re-watch while
alternating with driving.

So the product is: extract that translation once, then deliver it by voice at the
right instant, and **stop saying it once the driver has learned it.**

> v1 does that last part manually: a driver picks a shorter note set once a track
> is familiar, rather than the engine deciding for them. §6.5 has the reasoning.

### The two data sources, and what each is for

| Source | Provides |
|---|---|
| Telemetry | **Where** — precise lap distance for brake onset, apex, throttle-on |
| Video / transcript | **What to call it** — "the 100 board", "the bridge", "where the kerb goes red" |

Neither is sufficient alone. This also resolves the car-class problem: the
*landmark* is a fixed physical object that never moves, but *which* landmark is
correct changes per car. A GT3 brakes at the 100 board where an LMP2 brakes at the
50 and an MX-5 at the 150. One landmark inventory per track, many note sets
selecting from it.

### The two halves

The product splits cleanly along a build-time / run-time line, and keeping that
line sharp is the main architectural discipline in this document.

```
GENERATION (offline, slow, expensive, AI in the loop)
  recorded lap ──► TrackMap + centreline + LandmarkInventory
  YouTube video ──► NoteSet ──► human review (§7.4) ──► AudioPack
                                        │
                                        ▼
RUNTIME (online, 60 Hz, dumb, deterministic)
  telemetry + config ──► trigger ──► speak
```

**The runtime is deliberately stupid.** It performs no analysis, calls no model,
needs no network, and makes no decisions that aren't in the config. It reads
pre-computed artefacts and fires pre-rendered audio. That is what makes it fast,
offline-capable, testable off a recording (§9), and free to run — the AI cost is
paid once per video, never per user and never per lap.

One caution on the mental model: it is tempting to think of the output as *"the
map"*, singular. It isn't — generation produces **two independent things with
different lifecycles**:

- **`TrackMap` + `LandmarkInventory`** — the track. Car-independent, generated
  once, shared by every note set for that circuit.
- **`NoteSet` + `AudioPack`** — what to say. Per car class, per source video, many
  per track.

Collapsing them into one file means re-deriving corner geometry every time someone
adds a video, and losing the ability to hold several coaches' note sets for the
same circuit. §4.0 defines the keys that keep them apart.

---

## 2. v1 scope

**In scope**

- iRacing only
- Local-first: all data on disk, no server, no accounts — but every read goes
  through a repository interface shaped for **Supabase**, so the backend drops in
  later without touching callers (§8)
- Runtime note engine: trigger, schedule, speak
- Track map generation from a recorded lap
- Two overlays: input trace vs reference lap, and a delta bar
- Video ingest pipeline as a **separate offline package**, built in parallel
- Hand-authored note sets for two tracks to validate the runtime

**Explicitly out of scope for v1**

- Any other sim (the adapter interface exists; only the iRacing implementation does)
- Accounts, sharing, community submission, moderation
- Note-set merging — a user picks one set, full stop
- Automatic fading (§6.5). The goal is met by picking a shorter note set.
- Voice packs beyond one voice
- Setup/telemetry analysis features

**One addition to the overlay list:** build a **dev callout overlay** showing the
current corner, the next queued note, its computed trigger distance and whether it
fired. It is not a shipping feature — it is the only way to see what the engine is
doing while sitting in the car. Gate it behind a debug flag.

---

## 3. Stack

| Concern | Choice | Notes |
|---|---|---|
| Runtime | Node 20+ | |
| Language | **TypeScript, strict, everywhere** | See below — no exceptions |
| Shell | Electron | Windows only — iRacing is Windows only |
| iRacing SDK | [`irsdk-node`](https://irsdk-node.bengsfort.dev/) v4.4.0 | See below |
| `.ibt` parsing | [`ibt-telemetry`](https://www.npmjs.com/package/ibt-telemetry) — **unmaintained** | Only if importing saved files; live SDK is the primary path |
| Overlay UI | Vue 3 (`<script setup>`) + Canvas | Traces are Canvas, not SVG or DOM — they redraw at 60fps. See §7.0 for reactivity rules |
| Audio | WAV via preloaded buffer | **Not MP3** — decode latency at trigger time is unacceptable |
| Backend (v2) | Supabase — Postgres + Storage + Auth | Not built in v1, but the repository layer targets it (§8.1) |
| Monorepo | pnpm workspaces | |
| Tests | Vitest | |

### TypeScript — non-negotiable

Every package, every file, including build scripts, the replay harness, the ingest
CLI and Vue SFCs (`<script setup lang="ts">`). No `.js` source files, no
`allowJs`, no `// @ts-nocheck`, no `any` that isn't immediately narrowed at a
boundary. Untyped third-party modules get a hand-written `.d.ts` in
`/types/vendor/`, not an `any` cast at the call site.

Baseline `tsconfig.json` compiler options — all of these on:

```jsonc
{
  "strict": true,
  "noUncheckedIndexedAccess": true,   // see below — this one matters here
  "exactOptionalPropertyTypes": true,
  "noImplicitOverride": true,
  "noFallthroughCasesInSwitch": true,
  "verbatimModuleSyntax": true,
  "isolatedModules": true
}
```

`noUncheckedIndexedAccess` is called out specifically because this codebase indexes
arrays by computed position constantly — `channels.elapsedS[pctIndex]`,
`map.corners[cornerIndex]`, `ref.perCorner[i]`. Every one of those can be
`undefined` at runtime (off-by-one at the grid edge, a corner index from a note set
cut against a different `mapVersion`). Without this flag the compiler will let all
of them through and you'll find out in the car.

### Branded units — make §3's unit rule compiler-enforced

The "SI internally, convert at render" rule is a convention until you brand it,
and then it's a type error:

```ts
declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };

type Pct     = Brand<number, "Pct">;      // 0..1 lap position
type Metres  = Brand<number, "Metres">;
type Mps     = Brand<number, "Mps">;
type Seconds = Brand<number, "Seconds">;

const pct    = (n: number) => n as Pct;
const metres = (n: number) => n as Metres;
```

Signatures then read `aheadM(from: Pct, to: Pct, length: Metres): Metres`, and
handing a kph number to something expecting `Mps` stops compiling. Given how many
of §12's pitfalls are unit and coordinate mistakes, this pays for itself in the
first week. Keep the constructors at I/O boundaries only — adapter, repo, render.

### On `irsdk-node`

Prefer it specifically because `@irsdk-node/native` is an **N-API** addon built
with `prebuildify --napi --electron-compat`. That means **no `electron-rebuild`
step** — the single biggest source of pain with Electron + native modules.
Prebuilds ship for `win32-x64` and `win32-arm64` only, which is fine.

`@irsdk-node/types` exists as a separate package for renderer processes, where the
main library can't be imported.

**Fallbacks are worse than they look.** `node-irsdk` and `iracing-sdk-js` are
*not* pure-JS — both are NAN-based native addons with the full rebuild burden.
`node-irsdk`'s last release was 2019; `iracing-sdk-js` declares
`engines.node: ">=21"`, which conflicts with the Node 20 target here. If a
fallback is genuinely needed, use `node-irsdk-2023` (the maintained fork), and
expect to deal with `electron-rebuild`.

`ibtparse` (github.com/rcmx/ibtparse) is **not installable** — three commits, and
the package it names doesn't exist on npm. If `.ibt` import matters, vendor its
source as a reference implementation. `ibt-telemetry` works but its last release
was 2021.

### Units — one rule

**All internal data and all engine math are SI: metres, metres/second, radians,
seconds.** `LapDistPct` stays 0..1. Conversion to km/h happens **only** in overlay
render code. Do not store kph anywhere.

> The iRacing SDK reports `LapDistPct` with a unit string of `"%"` but the value
> is genuinely 0..1. Leave a comment saying so, or someone will "fix" it by
> dividing by 100.

Confirmed channel semantics: `Speed` m/s · `SteeringWheelAngle` radians ·
`Throttle` / `Brake` 0..1 · `Gear` −1 reverse, 0 neutral, 1..n.

### Repo layout

```
/apps/desktop          Electron main + preload
/packages/core         Pure logic: schemas, corner detection, trigger engine,
                       scheduler, fading. NO fs, NO electron, NO sdk imports.
/packages/telemetry    Sim adapters. IRacingAdapter implements TelemetrySource.
/packages/repo         Repository interfaces + local-file implementations
/packages/overlays     Renderer UI
/tools/replay          Replay harness (see §9)
/services/ingest       Video pipeline — standalone Node CLI, never bundled
/data                  Track maps, landmarks, note sets, audio, reference laps
```

**`packages/core` must stay pure.** No I/O, no Electron, no native modules. Plain
objects in, plain objects out. This is what makes the engine testable without the
sim and the backend swap trivial. Enforce with a lint rule.

---

## 4. Data model

### 4.0 TrackRef and TrackKey — define once, use everywhere

Two distinct keys. Confusing them silently invalidates data.

```ts
/** Identifies the physical track+layout. Stable across map regeneration. */
type TrackKey = { sim: "iracing"; trackId: number; configId: string };

/** Identifies a specific corner-numbering of that track. */
type TrackRef = TrackKey & { mapVersion: number };
```

Anything holding **corner indices** is keyed by `TrackRef`. Anything holding raw
telemetry is keyed by `TrackKey` — re-cutting a track map must not invalidate
recorded laps.

**Never key on track display name.** Not stable, not unique.

| Artefact | Key | Changes when |
|---|---|---|
| `TrackMap` | `TrackRef` | iRacing repaves or changes a layout |
| `LandmarkInventory` | `TrackRef` | rarely, once built |
| `ReferenceLap` | `TrackKey` + `carId` | a faster lap is recorded |
| `NoteSet` | `TrackKey` + carClass + source | per video, many per track — holds lap positions, not corner indices (§4.4) |
| `AudioPack` | noteSetId + voiceId | notes or voice change |

### 4.1 TrackMap

```jsonc
{
  "schema": 1,
  "trackRef": { "sim": "iracing", "trackId": 266,
                "configId": "grand_prix", "mapVersion": 3 },
  "trackName": "Circuit de Spa-Francorchamps",
  "configName": "Grand Prix",
  "lengthM": 7004,
  "generatedFrom": {
    "source": "telemetry",
    "baselineCarId": 173,          // apexPct is mildly car-dependent — record it
    "lapHash": "sha256:…"
  },
  "corners": [
    {
      "index": 1,
      "names": ["La Source"],       // aliases the LLM may match against
      "entryPct": 0.0121,
      "apexPct":  0.0180,
      "exitPct":  0.0242,
      "direction": "right",
      "severity": 5                 // 1 (flat kink) … 6 (hairpin)
    }
  ],

  // 2D centreline, same pct grid as ReferenceLap. Metres, arbitrary origin.
  // Required — without it there is nothing to draw the editor's map from (§7.4).
  "centreline": {
    "gridSize": 2000,
    "x": [ … 2000 floats … ],
    "y": [ … ]
  }
}
```

### 4.1.1 Deriving the centreline

> **Settled at M0b: `Lat`/`Lon` are not usable.** They read a constant zero for
> the whole session — 1 distinct pair across 4,364 frames of the Daytona
> reference lap. The equirectangular route below is therefore **not** the one
> taken; dead reckoning is. Kept here because it is still the right approach if
> the channels ever start reporting, and because knowing it was tried and
> rejected is worth more than a clean page.

The SDK exposes `Lat` and `Lon` in degrees. If they were populated, you would
project them to a local planar frame about the track's mean latitude during map
generation:

```ts
const R = 6_378_137;                       // WGS84 equatorial radius, metres
const x = R * toRad(lon - lon0) * Math.cos(toRad(lat0));
const y = R * toRad(lat - lat0);
```

Equirectangular is accurate to well under a metre over a 7 km circuit, which is
far below what a schematic map needs.

**What is actually implemented** is the dead-reckoning alternative: integrate
`VelocityX` / `VelocityY` against `YawNorth`. It accumulates drift and needs a
closure correction at start/finish, as predicted — the Daytona lap closes to
21.6 m over a 5,701 m path, 0.4%, which is then distributed along the lap in
proportion to *distance travelled* rather than sample index. That distinction
matters: samples bunch up where the car is slow, so an index-weighted correction
would push the corners around and leave the straights alone.

Dead reckoning brings a hazard the Lat/Lon route does not. **The handedness of
`YawNorth` cannot be assumed, and closure will not tell you it is wrong** —
negating the yaw very nearly mirrors the path, and a mirrored loop closes just as
well as the correct one. A mirrored map is silently wrong in the §12 sense: it
draws a plausible circuit with every left turned into a right, and nothing
downstream can tell.

So the yaw sign is chosen by checking the drawn curvature against the steering
input, whose own convention was measured on a real lap (§5). Refuse to emit a
centreline when the two agree less than 80% of the time in either yaw sense.

Note what that does and does not buy: it derives the yaw sign *from* the steering
sign, so it cannot catch a steering sign that is itself wrong. The independent
confirmation is the drawn map — Daytona's banking comes out left-handed, which is
correct for the circuit, and a flipped constant would mirror it visibly.

Either way, resample onto the same pct grid as everything else, so the map, the
corners, the landmarks and the traces all share one index space.

This comes free from the lap you already record in **M1**, so generate it there
rather than bolting it on later.

`minSpeed` deliberately **does not** live here — it is car-dependent and belongs
on `ReferenceLap`. `apexPct` is derived from a baseline car but is
geometry-dominated and stable enough to share; `baselineCarId` records which.

### 4.2 LandmarkInventory

**Not a runtime artefact.** The engine never loads one: a note is a point and a
message (§4.4), and a landmark reference in the *words* — "brake at the hundred
board" — is just a string. This exists so §10 stage 3 can hand the model a closed
set of ids instead of letting it invent a reference to something that is not there.

Which means it is not needed to hand-author a note set, and building one is not a
prerequisite for anything before M5.

The asset that is genuinely hard to acquire, when you do need it. Build it
carefully.

```jsonc
{
  "trackRef": { "sim": "iracing", "trackId": 266,
                "configId": "grand_prix", "mapVersion": 3 },
  "landmarks": [
    { "id": "t1_board_100", "cornerIndex": 1, "type": "distance_board",
      "label": "hundred board", "pct": 0.99781, "confidence": 0.9, "verified": true },
    { "id": "t1_kerb_in",    "cornerIndex": 1, "type": "kerb",
      "label": "inside kerb",  "pct": 0.01750, "confidence": 0.7, "verified": false }
  ]
}
```

> Note `t1_board_100` sits at pct **0.99781** — 100 m before La Source's entry at
> 84.7 m puts it *behind the start/finish line*. Landmarks routinely wrap. Every
> distance calculation must handle it (§4.6).

`type` ∈ `distance_board | bridge | marshal_post | kerb | surface_change | sign |
building | treeline | gantry`

Every note points at a landmark by `id`. Correct the landmark's position once and
every note set for that track corrects itself.

### 4.3 ReferenceLap

**Resample to a fixed `LapDistPct` grid.** The single most useful decision in the
data model: comparison, delta and overlay rendering become array indexing with no
time alignment.

```jsonc
{
  "trackKey": { "sim": "iracing", "trackId": 266, "configId": "grand_prix" },
  "carId": 173,
  "lapTimeS": 138.42,
  "gridSize": 2000,                 // samples evenly spaced in pct
  "channels": {
    "speedMps":  [ … 2000 floats … ],
    "throttle":  [ … ],             // 0..1
    "brake":     [ … ],             // 0..1
    "gear":      [ … ],
    "steerRad":  [ … ],
    "elapsedS":  [ … ]              // elapsed lap time at each pct — used for delta
  },

  // Derived per corner. Depends on corner numbering, so it records which
  // mapVersion it was computed against; recompute if stale.
  "derivedForMapVersion": 3,
  "perCorner": {
    "1": { "brakeOnsetPct": 0.99612, "throttleOnPct": 0.01931, "minSpeedMps": 17.2 }
  }
}
```

### 4.4 NoteSet

**A note is a point on the track and something to say there.** That is the entire
model. There is no phase, no corner index, no anchor union.

```jsonc
{
  "id": "daytona-mx5-draft",
  // TrackKey, not TrackRef — see below.
  "trackKey": { "sim": "iracing", "trackId": 192, "configId": "road_course" },
  "lengthM": 5687.3,
  "carClass": "mx5",
  "source": { "type": "manual" },
  "status": "draft",                // draft | review | published
  "createdAt": "2026-08-27T00:00:00Z",
  "notes": [
    {
      "id": "t1",
      "pct": 0.0613,                // where this is relevant. That is the anchor.
      "text":      "Brake, turn 1, left, second out",
      "textShort": "Left",
      "priority": 1,                // 1 = highest
      "leadAdjustS": 0,             // author's timing fix for THIS note (§6.1)
      "dirty": true,                // text edited since the audio was rendered
      "audio":      { "file": "…/t1.wav",       "durationMs": 2140 },
      "audioShort": { "file": "…/t1_short.wav", "durationMs": 940 }
    }
  ]
}
```

**Why there is no phase.** The engine does not need to know whether a message is
about braking, throttle, a bump, or where the pit entry is. It needs to know
*where* and it needs the words. A phase taxonomy buys nothing at runtime and
excludes everything that is not a corner phase.

**Merge, do not split.** If the throttle application at a corner is worth
mentioning, it belongs in that corner's message — not a second callout 250 m
later. Two lines per corner is more than a driver can use, and the input traces
(§7.1) carry the detail they want to check afterwards. The voice carries what
they need now. On Daytona this is the difference between 12 callouts a lap and 6.

**Why `pct` and not a corner reference.** A lap position is a physical property of
the tarmac. Corner numbering is a derived artefact that a `corners.override.json`
can renumber (§5.2). Anchoring to the derived thing would be the fragile choice,
not the stable one.

That is also why a NoteSet is keyed by **`TrackKey`, not `TrackRef`** — the same
reasoning §4.0 applies to `ReferenceLap`. Re-cutting a track map cannot invalidate
a note set, because a note set holds no corner indices.

**`lengthM` is carried on the set** rather than looked up. It is the only piece of
geometry the runtime needs and it cannot change for a given `TrackKey`. Carrying
it makes a note set self-sufficient: **the runtime loads one artefact plus its
audio.** No `TrackMap`, no `LandmarkInventory` — those are authoring inputs (§5,
§10), not runtime ones.

Both `audio` and `audioShort` are required — the scheduler's short-form fallback
(§6.3) needs a real duration to compute lead distance, so both must be rendered
and measured.

```ts
type NoteSetSummary = {
  id: string; trackKey: TrackKey; carClass: string;
  title: string; channel: string; sourceUrl: string;
  noteCount: number; status: "draft" | "review" | "published";
  createdAt: string;
};
```

### 4.5 AudioPack

```jsonc
{
  "noteSetId": "spa-gt3-abc123",
  "voiceId": "en_amy",
  "format": "wav/pcm_s16le/22050",
  "files": {
    "t1_brake":       { "path": "…/t1_brake.wav",       "durationMs": 1240, "bytes": 54_680 },
    "t1_brake_short": { "path": "…/t1_brake_short.wav", "durationMs": 720,  "bytes": 31_760 }
  },
  "totalBytes": 4_210_998
}
```

All files for the loaded track are read into memory at session start. Never touch
disk at trigger time.

### 4.6 Shared pct helpers — use these, never raw subtraction

```ts
const wrapPct = (p: number) => ((p % 1) + 1) % 1;

/** Distance ahead from `from` to `to`, always 0..lengthM. */
const aheadM = (from: number, to: number, lengthM: number) =>
  wrapPct(to - from) * lengthM;

/** Signed shortest distance, −lengthM/2 .. +lengthM/2. Positive = `a` is later. */
const deltaM = (a: number, b: number, lengthM: number) =>
  (((a - b + 1.5) % 1) - 0.5) * lengthM;
```

Every distance comparison in the codebase goes through one of these. Plain
`|a - b|` on percentages is a bug, and it will only show up at the one corner
nearest start/finish.

### 4.7 There is nothing to resolve

A note carries its own `pct`. That is the event position — no phase table, no
landmark lookup, no anchor union to discriminate, and no failure mode where a note
cannot be placed. A note set is loadable or it is not.

What this deleted, and why none of it is missed:

- **`PHASE_PCT`** mapped a phase onto entry, apex or exit. The author decides where
  the callout belongs; a table cannot know better.
- **Landmark anchors.** The `LandmarkInventory` (§4.2) is not on the runtime path
  at all. It exists so §10 stage 3 can hand the model a closed set of ids rather
  than letting it free-text a corner reference. **A landmark reference in the
  words needs no landmark record** — "brake at the hundred board" is a string.
- **The unresolvable-note case**, and with it every caller that had to decide what
  to do about one.

Corner geometry still matters at *authoring* time — that is how you decide a note
belongs at 0.0613 — and the editor (§7.4) still draws corners from the `TrackMap`.
The runtime never opens it.

---

## 5. Corner detection

Input: one clean lap resampled onto the pct grid.

```
1. Smooth steerRad with a moving average over ~0.2% of lap length.
2. mask[i] = |steerSmooth[i]| > adaptiveThreshold
   adaptiveThreshold = 0.15 * percentile(|steerSmooth|, 98)
3. Group contiguous mask regions.
   - merge two regions separated by a gap < 30 m
   - discard regions shorter than 20 m
4. Per region:
     entryPct  = region start
     exitPct   = region end
     apexPct   = argmin(speedMps) within region
     direction = signOf(mean(steerSmooth))
     severity  = bucket(min speedMps, max |steerSmooth|)  → 1..6
5. Number sequentially from start/finish.
```

**Pin the steering sign convention empirically in M0 and write it down.** The SDK
gives `SteeringWheelAngle` in radians but the spec of which sign means left is not
something to assume — get it backwards and every corner's `direction` inverts
silently, with no crash to tell you. Drive a known right-hander, read the sign,
hardcode it as a named constant in the adapter, and cover it with a test.

### 5.1 Braking onset — one definition, one function

Both the reference lap and the live driver must use the **same** function, or
§6.5's error metric compares different quantities:

```ts
/** Earliest sample of the contiguous brake>0.15 region that ends at or before entryPct.
 *  Search window: 300 m before entryPct, wraparound-safe. */
function brakeOnsetPct(lap, entryPct, lengthM): number | null
```

Note this is the **onset**, not the first sample found scanning backwards — a
driver is still hard on the brakes at corner entry, so a naive backwards scan
returns something ≈ `entryPct` and the metric becomes meaningless.

The parallel metric for throttle:

```ts
/** First sample after apexPct where throttle > 0.5. */
function throttleOnPct(lap, apexPct, lengthM): number | null
```

Both write into `ReferenceLap.perCorner` (§4.3).

### 5.2 Known failure modes

Chicanes split into two corners. Long constant-radius corners are fine. Fast kinks
fall below threshold and get missed — and one extreme hairpin raises the P98
threshold enough to hide them.

Do not try to solve these algorithmically. Ship a per-track
`corners.override.json` that can merge, split, rename or insert corners by hand,
applied after detection. Ten minutes per track beats a week of tuning.

---

## 6. The note engine

Lives in `packages/core`. Pure functions plus a small state machine. No I/O.

### 6.1 Trigger

Do **not** precompute a static trigger percentage — it moves with speed. Each
tick, compute distance remaining to the event and compare:

```ts
/** Single source of truth for lead time. Scheduler (§6.3) uses it too. */
function leadSecondsFor(note, variant, profile): Seconds {
  const raw = variant.durationMs / 1000
            + REACTION_BUFFER_S
            + (note.leadAdjustS ?? 0)    // author's fix, travels with the note set
            + profile.leadAdjustS;       // user preference, applies to everything
  // Never let adjustments push the callout to finish after its own event.
  return Math.max(raw, variant.durationMs / 1000 + 0.1) as Seconds;
}

const dAhead = aheadM(currentPct, eventPct, lengthM);
const leadM  = speedMps * leadSecondsFor(note, note.audio, profile);

if (state === ARMED && dAhead <= leadM) fire(note);
```

`REACTION_BUFFER_S = 1.0`.

**This constant, not the word count, is what sets how much air a callout has.**
The lead is derived from the clip duration, so shortening the text moves the
trigger later by the same amount it shortens the speech and the gap before the
event barely moves — measured at Daytona, halving every clip changed it by
0.02-0.08 s. If a callout feels rushed, raise the buffer or the note's
`leadAdjustS`; rewriting it shorter will not help.

**Adjustments are in seconds, not metres.** "It's a little late" is a complaint
about reaction time, and reaction time is what has to scale with speed — the same
way the rest of the lead does. A metre offset would be right at one speed and
wrong everywhere else.

**Two adjustment layers, deliberately separate.** `note.leadAdjustS` is the author
saying *this note is mistimed* and ships inside the note set for everyone.
`profile.leadAdjustS` is one driver saying *I like more warning than most* and
never leaves their machine. They add. Conflating them means one person's
preference gets baked into a shared note set.

> A third cause of bad timing is neither of these: the **anchor** is in the wrong
> place — a misplaced landmark, or the event genuinely belongs elsewhere. That is
> fixed with `anchor.offsetM`, which moves the event. Moving the event and
> changing the lead feel identical to a driver on one lap and diverge completely
> across speeds, so the editor must keep them visibly distinct (§7.4).

At 250 km/h (69 m/s) a 2.0 s callout plus buffer triggers **207 m early**. On a
short track that can land before the previous corner — hence the scheduler.

### 6.2 Per-note state machine — this is where the S/F bug lives

The obvious design — a `firedThisLap` set cleared at the start/finish line — is
**wrong**, and it fails exactly at the corners nearest S/F.

Worked example, Spa. The failure needs the **trigger on one side of the line and
the event on the other**, so anchor to turn 1's *entry* at pct 0.0121 — 84.7 m
into the lap. A 1.24 s callout at 69 m/s needs 155 m of lead, so it fires at pct
0.99003, before the line. The car then crosses start/finish, the set is cleared,
and `dAhead` is 84.7 m against a 155 m lead — so it **fires again**, in the same
approach, a beat before the corner.

> Note the anchor that does *not* reproduce it. A note on the 100 board itself, at
> pct 0.99781, has its event *before* the line: by the time the set is cleared the
> event is 6,988 m behind and even the broken design cannot re-fire. Getting this
> the wrong way round means writing a regression test that passes against the bug
> — verify any such test by actually implementing `firedThisLap` and watching it
> fail.

Use a per-note state machine keyed by note id, with no lap concept at all:

```
ARMED  --[ dAhead <= leadM ]-->  SPENT      (fire, or drop — both go to SPENT)
SPENT  --[ dAhead > lengthM/2 ]-->  ARMED   (event is now half a lap away)
```

Re-arming on "more than half a lap away" is unconditionally correct, needs no lap
counter, and survives resets, tows and pit exits. Initialise every note to `SPENT`
so nothing fires on the out-lap before the car has gone round once.

**A dropped note transitions to SPENT too.** Otherwise it re-enters the trigger
test every tick for the rest of its window and floods the log.

### 6.3 Scheduler

One audio channel. Queue, max depth 2.

**Fit test.** At the moment a note would start playing:

```
fits(note, variant) = aheadM(currentPct, eventPct, lengthM)
                      >= speedMps * leadSecondsFor(note, variant, profile)
```

**Dequeue policy, in order:**

1. If the channel is idle and `fits(note, audio)` → play full form.
2. Else if `fits(note, audioShort)` → play short form.
3. Else **drop**, and log `reason: no_fit_after_short`. This applies to
   **every** priority including 1. A braking cue that arrives after the braking
   point is worse than silence — it makes the driver flinch mid-corner.

**Admission policy when the queue is full (depth 2):**

- Compare the incoming note's priority against the queued notes'.
- If the incoming note has strictly higher priority (lower number) than the worst
  queued note, evict that queued note (`reason: evicted`) and admit.
- Otherwise drop the incoming note (`reason: queue_full`).
- **Ties break by event position: the note whose event comes sooner wins.** Two
  priority-1 notes are therefore always resolved.

Both the evicted and the dropped note go to `SPENT`.

### 6.4 Suppression

Say nothing when any of these hold. Real channel names, verified against the SDK
header vendored in `@irsdk-node/native`:

| Condition | Channel |
|---|---|
| Not in the car / not on track | `IsOnTrack` (bool) |
| In the pit lane | `OnPitRoad` (bool) |
| In the garage | `IsInGarage` (bool) |
| Off track | `PlayerTrackSurface == OffTrack` |
| Being towed | `PlayerCarTowTime > 0` |
| Reset to pits | `EnterExitReset` changed |
| Crawling | `Speed < 8.3` (30 km/h) |

`PlayerTrackSurface` is `irsdk_TrkLoc`:
`NotInWorld = -1, OffTrack = 0, InPitStall = 1, AproachingPits = 2, OnTrack = 3`.
(The misspelling of "Approaching" is the SDK's own — match it exactly.)

There is no clean "four wheels off" channel. `PlayerTrackSurface == OffTrack` is
the closest available proxy; hold suppression for 2 s after it clears.

Also suppress on the out-lap: require one completed lap since `IsOnTrack` went
true before arming anything.

### 6.5 Fading — deferred, and how the goal is met instead

**Not built in v1.** The goal stands and the mechanism changed: a driver swaps
note sets by hand instead of the engine deciding for them.

The original design measured the driver's brake onset against a reference lap and
muted a callout after three good laps, with hysteresis. It is still the right idea
eventually. Three things made it the wrong thing to build first:

- **It is opaque when it misfires.** A callout that stops has no way to say why,
  and a driver mid-session cannot tell "you have got this" from "something
  broke". Every other silence in this system is explainable (§6.4); this one
  would not be.
- **It cannot be tuned before there is experience to tune against.** The 15 m
  threshold and the three-lap window are guesses, and the honest way to pick them
  is to have driven with callouts for a while — which needs the rest of the
  system finished first.
- **It depends on the reference being the right reference.** §13.3.1 already
  notes that against an alien lap most drivers never match anything and nothing
  ever fades. That is a whole open question standing under a feature.

**What replaces it:** more than one note set per track and car — a full one, and a
shorter one naming only the corners that stay hard — chosen from preferences. The
driver decides what they have learned, which is the one judgement they are better
placed to make than the telemetry is.

The cost, accepted deliberately: the text and the audio are duplicated across
sets, so editing a callout means editing it everywhere it appears. If that becomes
the thing that hurts, the smaller fix is a level on each note and a setting that
picks how far down to play — one set, one audio pack, one place to edit. Worth
reaching for only once the duplication is actually painful.

`fadeable` is gone from `Note`, since there is nothing to opt out of.

---

## 7. Overlays

Electron windows: `transparent: true, frame: false, alwaysOnTop: true,
skipTaskbar: true, resizable: false`, plus
`win.setAlwaysOnTop(true, "screen-saver")` and
`win.setIgnoreMouseEvents(true, { forward: true })` — the latter toggled off when
the user enters layout-edit mode.

> **Document this prominently:** transparent overlays are **not supported** over
> **exclusive fullscreen**. The sim should run borderless windowed. Word it
> "unsupported", not "impossible" — Windows 10/11 Fullscreen Optimizations often
> converts DX11 exclusive fullscreen to a composited path, so some users will
> report it working anyway and you don't want to argue with them.
>
> Put this in the first-run flow, not the FAQ. It is the number one support
> question for every overlay app in existence.

**Timing-critical work runs in the main process, never a renderer.** Renderers get
throttled when occluded or backgrounded, which will silently destroy callout
timing. Main owns the telemetry loop, the note engine and audio, and pushes a
compact state frame to renderers over IPC at 60 Hz. Never send raw telemetry
across IPC.

### 7.0 Vue reactivity rules for 60 Hz data

Vue's reactivity is proxy-based, and wrapping a state frame that replaces itself
sixty times a second is pure overhead — every field gets a proxy, every read goes
through a trap, and none of it buys anything because the whole object is discarded
on the next frame.

- Hold the incoming telemetry frame in a **`shallowRef`**, and replace it wholesale
  rather than mutating fields. No deep reactivity, one dependency notification per
  frame.
- Put the reference-lap channel arrays behind **`markRaw`**. They are 2000-element
  typed arrays that never change during a session; making them reactive is a
  measurable waste on load.
- **Canvas components must not re-render on telemetry at all.** Subscribe to the
  IPC channel directly in `onMounted`, draw inside a `requestAnimationFrame` loop,
  and let Vue own only the mount/unmount lifecycle. Do not route trace data
  through props or a template — a Vue update cycle per frame is a bug, not an
  optimisation target.
- Reserve normal reactivity for what actually changes at human speed: the note-set
  picker, the layout editor, settings.

The dev callout overlay (§7.3) is the exception — it changes a few times a second
at most, so ordinary reactive state is fine there.

### 7.1 Input trace vs reference

Canvas. X axis is `LapDistPct` over a rolling window (±8% of lap around current
position). Two traces each for throttle and brake — yours live, the reference
ghosted behind. Both are on the same pct grid, so this is a direct index lookup
with no alignment logic. Convert m/s → km/h here and nowhere else.

Mark corner entry/apex/exit as faint vertical guides, and mark the reference
`brakeOnsetPct`. Seeing your brake trace start after the reference marker is the
single most legible piece of feedback in the app.

### 7.2 Delta bar

Because the reference stores `elapsedS` per pct index:

```ts
delta = currentElapsedS - reference.channels.elapsedS[pctIndex];
```

### 7.3 Dev callout overlay (debug flag)

Current corner, next queued note, its `dAhead` vs `leadM`, note state
(ARMED/SPENT), and fire and drop events with reasons. The drops matter more than
the fires: every other silence in this system is explainable, so the one thing
the overlay has to answer is "why did it not say anything". Ugly is fine.

---

### 7.4 Note editor — the authoring surface

A **normal application window**, not an overlay. None of §7.0's hot-path rules
apply here; use ordinary Vue reactivity and **SVG, not Canvas** — this view is
interactive, changes at human speed, and needs hit-testing on every element.

> **Build this once and use it twice.** This is the same UI as ingest stage 5
> (§10). Reviewing an AI-generated note set and hand-authoring one from scratch
> are the same activity with a different starting point. Do not build two things.

#### Layout

The track drawn from `TrackMap.centreline` (§4.1.1), fit to the viewport, with:

- **Corner arcs** along the centreline from `entryPct` to `exitPct`, tinted by how
  well covered they are — corners with no note at all are the ones to look at.
- **Landmark ticks** perpendicular to the centreline, labelled on hover.
- **Note pills** anchored beside their corner showing `text`, so the whole lap's
  script is readable at a glance without clicking anything. That was the ask, and
  it's also the fastest way to spot a corner the model skipped.
- A **side panel** listing notes in track order, each with text, `pct`, priority,
  audio duration, confidence, and a play button. Track order, not corner order:
  notes are points on a lap and some of them — pit entry, a bump, traffic — belong
  to no corner at all.

**Double-click a note pill to edit its text inline.** Escape cancels, Enter
commits.

#### Trigger windows — the feature that makes this worth building

For each note, shade the arc of track over which it will be speaking. Because
`ReferenceLap` gives speed at every pct, this is computable exactly: walk backwards
from `eventPct`, accumulating time against the reference speed profile until it
reaches `leadSecondsFor(note, …)`. The arc start is where the voice begins.

This turns three otherwise-invisible problems into things you can see:

1. **Overlaps.** Two shaded arcs crossing is exactly the collision §6.3 resolves by
   dropping a note at runtime. Render it as a conflict marker and the author fixes
   it at authoring time instead of discovering it mid-corner.
2. **Callouts that start before the previous corner.** At 250 km/h a 2 s callout
   spans 207 m. On a short track the arc visibly reaches back past the last apex.
3. **The cost of a longer sentence.** Editing the text re-renders the arc, so
   "brake at the hundred metre board on the right" visibly eats another 40 m of
   track compared to "brake, hundred board".

#### Fine-tuning timing

Two controls, kept visually distinct because they diverge across speeds (§6.1):

| Control | Moves | Use when |
|---|---|---|
| **Lead** (`leadAdjustS`) | the start of the shaded arc | the callout is right but arrives a little early or late |
| **Anchor** (`anchor.offsetM`) | the *event* — arc and endpoint together | the braking point itself is in the wrong place |

Drag the arc's leading edge to set lead; drag the endpoint marker to set anchor
offset. Show both as numbers too — ±0.05 s and ±5 m steps — because dragging is
for exploring and typing is for repeating.

**Correct for the constant-speed approximation automatically.** The runtime
computes `leadM = speedMps × leadS` using *instantaneous* speed, which assumes the
car holds that speed for the whole callout. For a brake cue that's near enough —
the car is at steady speed right up to the braking point. For a **throttle or exit
cue the car is accelerating**, so it covers more ground than the estimate and the
cue lands late.

The editor knows the true answer because it has the speed profile. Compute the
error between the integrated window and the runtime's approximation, and offer it
as a suggested `leadAdjustS` the author can accept with one click. This is the
single most common source of "it's a little late" on corner exits, and it is
mechanical to fix.

#### Editing text invalidates audio

Changing `text` makes the rendered WAV stale, and its duration is an input to the
trigger — so a stale note is not merely mispronounced, it is mistimed.

- Mark edited notes `dirty` and render them visibly unfinished.
- Use a fast local TTS for immediate preview so the author can hear it and judge
  length; final render goes through stage 6 (§10) with `ffprobe`d durations.
- Never let a note set reach `status: "published"` with a dirty note in it.
- Show `durationMs` in the panel. It is not a detail — it is what sets lead
  distance, and authors need to feel the cost of an extra word.

#### Other interactions

- **Play** a note's audio in isolation, and **play the corner** — all its notes in
  fire order with real gaps, at reference-lap speed.
- **Jump to source**: open the source video at `sourceTs` (§4.4). During review of
  an AI-generated set this is the single most-used control — every questionable
  note gets checked against what the coach actually said.
- **Flag queue**: notes failing stage 4 validation (§10) or below a confidence
  threshold are listed for triage, so review starts with what's likely wrong
  rather than corner 1.
- **Add a note** by clicking a point on the centreline. That click *is* the note's
  `pct` — nothing to pre-fill but the position, and the text starts empty.

#### Milestone

Belongs with **M5**, since it is stage 5 of the ingest pipeline. M2's two
hand-authored note sets can be raw JSON — two tracks is not enough to justify
building a UI first, and authoring them by hand is a useful way to feel where the
schema is awkward.

---

## 8. Repository layer

Local now, HTTP later, without rewriting callers.

```ts
interface TrackMapRepository {
  get(ref: TrackRef): Promise<TrackMap | null>;
  put(map: TrackMap): Promise<void>;
}

interface NoteSetRepository {
  listForTrack(ref: TrackRef, carClass?: string): Promise<NoteSetSummary[]>;
  get(id: string): Promise<NoteSet | null>;
}

// also: LandmarkRepository, ReferenceLapRepository (keyed by TrackKey),
//       AudioRepository
```

v1 ships `LocalFile*` implementations reading `/data`. v2 adds `Supabase*`.
**Nothing outside `packages/repo` may touch the filesystem or the network for
these artefacts.** Content is addressed by the same keys the backend will use, so
the swap is a DI change and nothing else.

### 8.1 Supabase — the v2 target

Postgres + PostgREST + Storage + Auth covers everything this needs. Split by size,
not by habit:

| Artefact | Where | Why |
|---|---|---|
| `TrackMap` | Postgres, `jsonb` | small (a few KB), queried by key |
| `LandmarkInventory` | Postgres, `jsonb` | small |
| `NoteSet` | Postgres, `jsonb` | ~20–50 KB, needs filtering and listing |
| `ReferenceLap` | **Storage** + metadata row | 2000 × 6 floats ≈ 96 KB as JSON, 48 KB as `Float32Array`. Store binary, not `jsonb` |
| `AudioPack` | **Storage** + metadata row | WAV files, CDN-served |

```sql
-- documents keyed by TrackRef
create table track_maps (
  sim text not null, track_id int not null,
  config_id text not null, map_version int not null,
  length_m real not null, data jsonb not null,
  primary key (sim, track_id, config_id, map_version)
);

create table note_sets (
  id text primary key,
  sim text not null, track_id int not null,
  config_id text not null, map_version int not null,
  car_class text not null,
  status text not null check (status in ('draft','review','published')),
  source_video_id text, source_url text, source_channel text, source_title text,
  data jsonb not null,
  created_by uuid references auth.users, created_at timestamptz default now()
);
create index on note_sets (sim, track_id, config_id, map_version, car_class)
  where status = 'published';

-- reference_laps keyed by TrackKey + car (NO map_version — see §4.0)
create table reference_laps (
  sim text not null, track_id int not null, config_id text not null,
  car_id int not null,
  lap_time_s real not null, grid_size int not null,
  storage_path text not null,          -- Float32Array blob in Storage
  derived_for_map_version int, per_corner jsonb,
  primary key (sim, track_id, config_id, car_id)
);
```

Storage layout: `audio/{noteSetId}/{voiceId}/{noteId}.wav` and
`reflaps/{sim}/{trackId}/{configId}/{carId}.bin`.

**Row Level Security, on from the first migration.** Published note sets readable
by anyone; drafts readable and writable only by `created_by`. Track maps and
landmark inventories are read-only to clients — writes come from the ingest CLI
under the service role. Turning RLS on later, after data exists, is how people
ship public write access by accident.

**The Electron app gets the anon key and nothing else.** The service role key
never ships in the client — it bypasses RLS entirely, and an Electron bundle is a
zip file anyone can open. Only the ingest CLI, running on your machine or a server
you control, holds it.

**Don't put the ingest pipeline in Edge Functions.** Stages 3 and 6 make LLM and
TTS calls that run for minutes; Edge Functions are the wrong shape for that. Keep
`services/ingest` as the standalone Node CLI it already is and let it write to
Supabase directly.

**Generate the DB types, then wrap them.** Run
`supabase gen types typescript --local > packages/repo/src/db.generated.ts` as
part of the build. Those generated row types stay **inside** `packages/repo` —
they're a database shape, not a domain shape, and `packages/core` must never
import them. The repo layer maps rows to the §4 domain types at the boundary.

**Cache to disk, and mean it.** The Supabase repositories wrap the local-file ones
as a write-through cache. Everything for the loaded track is fetched and pinned at
session start, so a network blip mid-stint cannot silently stop the callouts.
Offline with a previously-driven track must keep working — that isn't a nice-to-
have, it's someone in the middle of a race.

---

## 9. Testing — build the replay harness first

**You cannot iterate on callout timing by driving laps.** Highest-leverage thing
in the build, so it comes *before* the note engine, not after.

1. Record every telemetry frame to NDJSON during any session, always, cheaply.
2. `tools/replay` pipes a recording through the note engine on a virtual clock at
   1x or 100x and emits a timeline. Worked example, Spa, `t1_brake` = 1240 ms:

```
lap 3  pct 0.9812  spd 241kph  FIRE t1_brake     lead 117m  dAhead 116m
lap 3  pct 0.0144  spd  64kph  FIRE t1_throttle  lead  25m  dAhead  25m
lap 3  pct 0.0203  spd  98kph  DROP t1_line      reason: no_fit_after_short
```

3. Golden-file tests assert exact fire points for a checked-in recording. Any
change to the trigger math that moves a fire point shows up as a diff.

**The recording has to contain more than one lap.** §6.4 stays quiet until one lap
has completed since `IsOnTrack` went true, so a single extracted lap suppresses
as `out_lap` from the first frame to the last and the engine says nothing at all.
That makes it a fine source for a track map and a useless one for a callout
timeline — check in two or three laps, not the one clean one.

**Verify a regression test by breaking the code.** Both of the engine bugs found
so far survived their first test: the S/F test passed against the naive
`firedThisLap` design because it used the wrong anchor, and neither the
past-the-event nor the rewound-clock bug was caught by unit tests at all — both
turned up on replaying a timeline. A test written from a spec listing proves
nothing until the listing has been implemented wrongly and seen to fail.

**Required tests, not optional:**

- The S/F double-fire case from §6.2 — a note whose **trigger falls before the
  line and whose event falls after it** must fire exactly once. At Spa that is a
  brake cue anchored to turn 1's entry (pct 0.0121), fired from around pct 0.995.
  A note anchored at pct 0.998 does *not* exercise this: its event is before the
  line, and the test passes against the naive design too.
- `deltaM` across the wrap boundary in both directions.
- `brakeOnsetPct` returns the onset, not a sample near corner entry.
- Corner detection against a checked-in lap with a hand-verified corner list.
- Two priority-1 notes contending for a full queue resolve deterministically.

---

## 10. Video ingest pipeline

`services/ingest` — standalone Node CLI, runs offline, never bundled into the app.
Never call an LLM from the client.

Built as a funnel so bad submissions die cheaply. Most public YouTube laps are
silent hotlaps with music over them and are worth nothing.

| Stage | Does | Cost |
|---|---|---|
| 0 Normalise | Extract YouTube video ID, dedupe against processed set | free |
| 1 Metadata | YouTube Data API: duration, captions present, title, channel. Reject > 45 min or no audio | free |
| 2 Triage | First ~500 words of transcript → Gemini Flash-Lite → `{ isInstructional, trackGuess, carClassGuess, confidence }`. Reject non-instructional | ~$0.0005 |
| 3 Extract | Full transcript + corner list + landmark inventory as enums → structured note JSON | ~$0.005 |
| 4 Validate | Cross-check against reference lap telemetry (below) | free |
| 5 Review | Human pass in a small local UI, with `sourceTs` links back to the video | time |
| 6 Render | TTS for `text` **and** `textShort` → `ffprobe` both → write `AudioPack`, publish note set | ~$0.04/track |

Average cost per *submitted* video lands under a cent because most die at stage 1
or 2.

### Prompting rules for stage 3

- Pass the corner list and the landmark inventory **as enums**. Require every note
  to name a `cornerIndex` from that set, or emit `null`. This eliminates fuzzy
  string matching entirely and gives you a clean unassigned bucket for review.
  Note that the corner index is a *stage 3 output only*: the pipeline resolves it
  to a `pct` before writing the note (§4.4), so nothing downstream carries it.
- **One note per corner.** If the throttle application or the gear is worth
  saying, it goes in that corner's message. Do not emit an approach note and an
  apex note and an exit note for the same corner — that is three lines where a
  driver can use one (§4.4).
- Give the model the lap start and end timestamps in the video. For a continuous
  onboard lap, video time maps monotonically to track position, so it can resolve
  *"brake here"* to a corner from elapsed position. Not exact, but enough to pick
  between candidates.
- **Do not cap `text` at a word count.** An earlier draft said eight words; the
  only hand-authored set in the project runs 11 to 19, because a useful callout
  carries a braking landmark *and* an aim point *and* a throttle reference, and
  dropping any of the three loses the thing that makes it worth saying. The real
  constraint is time and it is already enforced twice — §6.3 refuses to speak a
  callout that will not finish before its point, and §7.4 draws the arc so an
  author can see the cost of another word. A word count is a guess at that;
  neither of those is.
  `textShort` still has to be genuinely short, because it exists to fit where the
  full form no longer does — three or four words.
- Require `confidence` per note.
- **Rewrite, don't echo.** Instruct the model to normalise into your own short
  pacenote phrasing rather than reproducing transcript wording. Better callouts,
  consistent voice, and a materially better position on the content question.

### Stage 4 validation — you have ground truth, use it

If the transcript says *"brake at the hundred board"* but the reference lap for
that car actually starts braking 180 m before corner entry, something is wrong:
misheard marker, wrong corner, or wrong car class.

```ts
const expectedM = Math.abs(deltaM(resolveEventPct(note), corner.entryPct, lengthM));
const actualM   = Math.abs(deltaM(ref.perCorner[i].brakeOnsetPct, corner.entryPct, lengthM));
if (Math.abs(expectedM - actualM) > 40) flagForReview(note);
```

Note both sides use `deltaM`, not raw subtraction — the La Source case in §4.2 is
exactly the one that wraps.

Cheap, automatic, and it catches a lot. This matters more here than in most AI
products: a hallucinated braking reference doesn't produce a bad paragraph, it
produces a crash.

### TTS

Render offline, once per note set, for **both** text variants. `ffprobe` each file
for its **real** duration and store it. Never estimate duration, never call a TTS
API at runtime.

### Provenance

Store and display source video, channel and URL on every note set. Keep a
documented removal path. Costs nothing now, awkward to retrofit.

---

## 11. Milestones

Each ends in something you can actually run.

**M0 — Skeleton.** Electron boots. `irsdk-node` connects, prints `LapDistPct`,
`Speed`, `Throttle`, `Brake`, `Gear`, `SteeringWheelAngle`, `IsOnTrack`,
`OnPitRoad`, `PlayerTrackSurface` at 60 Hz. Telemetry recorder writes NDJSON.
**Pin the steering sign convention here** (§5). *Done when:* you can drive a lap
and get a recording, and you know which sign is left.

> **M0 splits by platform.** `@irsdk-node/native` ships prebuilds for `win32-x64`
> and `win32-arm64` only — there is no darwin build, so the package installs on
> macOS but throws on `require`. **M0a** is everything platform-neutral (monorepo,
> strict TS, branded units, pct helpers, schemas, `TelemetrySource`, NDJSON
> recorder, `ReplayAdapter`, Electron shell, tests) and is developed and verified
> on macOS. **M0b** — the live `IRacingAdapter` connect, the real channel print,
> and measuring the steering sign — requires a Windows machine with iRacing.
> This ordering agrees with §9: the replay harness comes first anyway.

**M1 — Replay harness + track map builder.** Replay a recording on a virtual
clock. Corner detection produces `corners.json`. `brakeOnsetPct` / `throttleOnPct`
populate `perCorner`. A throwaway script renders detected corners so you can
eyeball them. *Done when:* **Daytona Road Course's** corners come out right, with
`corners.override.json` used only for the cases §5.2 already says are unsolvable.

> **The first track is whichever one is being driven.** It was Okayama on the
> grounds that it is short and uniform; it is Daytona Road because that is the
> week's track and a real lap beats a convenient one. Be aware this trades a
> uniform circuit for the exact pair of failure modes §5.2 names: the banked oval
> sections are sustained turns taken at high speed with very little steering
> input, while the infield hairpin puts a large angle into the same lap and
> raises the P98 threshold that the banking then falls under. Expect the banking
> to need an override entry. That is §5.2 working as designed, not detection
> being broken — but it does mean "without hand-editing" is the wrong bar for
> this track, so the criterion above says what it actually is.

**M2 — Note engine + audio.** Hand-author note sets for Daytona Road Course and
Spa (long, and its turn 1 wraps — deliberately the hard case). State machine,
scheduler, suppression. Preload WAVs at session start. Validate in replay first,
then in the car. *Done when:* callouts land where a coach would say them, at both
tracks, in two cars, with the S/F test green.

**M3 — Overlays.** Input trace vs reference, delta bar, dev callout overlay.
*Done when:* you can see your brake trace lagging the reference in real time.

**M4 — Deferred.** Automatic fading is not in v1 (§6.5): a driver picks a shorter
note set once a track is familiar, rather than the engine deciding for them. The
milestone number is kept so the ones after it do not move.

**M5 — Ingest pipeline** *(parallel from the start, separate package)*. Stages
0–6, local review UI. *Done when:* a YouTube URL for a Spa GT3 guide produces a
reviewed, rendered note set the runtime can load.

**M6 — Packaging.** Windows installer, first-run flow including the borderless
windowed warning, overlay layout editor, note-set picker UI.

---

## 12. Pitfalls — read before starting

- **Never key on track display name.** Use `TrackRef` / `TrackKey` (§4.0).
- **Never clear fired-state at start/finish.** Use the §6.2 state machine. This is
  a real bug, not a hypothetical — it double-fires turn 1 at most tracks.
- **Never subtract percentages directly.** `deltaM` / `aheadM` from §4.6, always.
- **`aheadM` cannot say "behind".** It always returns a positive distance the long
  way round, so an event two metres behind the car reads as 6,990 m ahead — which
  sails through any fit test you care to write, and speaks a callout for a corner
  the driver has already been through. Check the half-lap threshold explicitly
  before testing whether something fits.
- **Never assume `Lat`/`Lon` are populated.** At M0b they read a constant zero.
  The centreline comes from dead reckoning, and its handedness has to be
  *derived*, not assumed — closure will not catch a mirrored map (§4.1.1).
- **Never carry playback state across a clock that went backwards.** A looped
  replay restarts `tMs` at zero; a scheduler holding `busyUntilMs` from the
  previous pass mutes itself into the next one. Treat time going backwards as a
  new session.
- **Never precompute a static trigger pct.** It moves with speed.
- **Never do timing work in a renderer.** They get throttled when occluded.
- **Never render TTS at runtime**, and never estimate audio duration — `ffprobe` it.
- **Never use MP3** for callouts. WAV, preloaded into memory.
- **Never let the LLM free-text a corner reference.** Enum or null.
- **Never auto-merge two note sets.** Two coaches will contradict each other.
- **One point, one message.** If the throttle application at a corner is worth
  saying, it belongs in that corner's callout, not a second one 250 m later. A
  driver can use one line per corner; the input traces (§7.1) carry the rest.
- **Never assume the steering sign.** Measure it (§5). Measured at M0b: right is
  **negative** (MX-5, Daytona Road Course). Everything downstream inherits it —
  corner directions, and the centreline's yaw sense — so a wrong value mirrors the
  whole map without failing anything.
- **Never store kph.** SI internally, convert at render only (§3).
- **Anchor triggers to corner entry, not to a detected brake point.** Brake points
  are car- and driver-dependent; corner geometry is not. The landmark in the
  *words* can be car-specific; the *timing* must not drift with driver skill.

---

## 13. Open questions

1. **Landmark inventory bootstrap.** Building the first inventory per track is
   manual — someone drives and marks where the boards are. Acceptable for the
   first two tracks, or worth building a marking tool in M1?
2. ~~**Car class taxonomy.**~~ **Settled.** There were three car identifiers and
   no mapping between any of them: the sim reports a slug (`SessionIdentity.carId`,
   e.g. `"mx5-mx52016"`), a `ReferenceLap` was keyed by a hand-typed integer, and
   a `NoteSet` names a free-text `carClass`.

   **`ReferenceLap.carId` and `TrackMap.generatedFrom.baselineCarId` are now the
   sim's slug**, so the car being driven finds its own reference lap with no
   lookup. The integer came from `--car-id` at recording time and had no source of
   truth behind it. What remains is one table, `data/cars/{sim}.json`, mapping
   slug to class — the only part that genuinely needs a human, since nothing about
   the strings decides whether a 296 GT3 and a 992 GT3 R are one class.

   **Granularity is therefore data, not code.** Splitting `"gt3"` per manufacturer
   is an edit to that file and nothing recompiles.

   **The check runs after connect, not at load.** The session is pinned up front
   (§4.5, §8.1) but the sim only hands over the track and car on connect, so
   `carWarnings` is a second pass. A class mismatch warns and still runs — §1's
   "a GT3 brakes at the 100 board where an MX-5 brakes at the 150" makes it wrong
   braking points rather than a cosmetic complaint, but refusing would also refuse
   every car not yet in the table. An unknown car is reported as unknown, never as
   a mismatch: a warning that fires whenever someone drives something new stops
   being read.
3. **Reference lap source.** Three candidates, in ascending order of risk:

   | Source | Channels | Format risk | Notes |
   |---|---|---|---|
   | **Live SDK recording** | complete | none | Requires driving the lap. **Use this for v1.** |
   | `.ibt` telemetry | complete | low — documented in the irsdk header | `ibt-telemetry` unmaintained, `ibtparse` doesn't install; vendor a parser |
   | `.blap` / `.olap` ghost files | partial, see §13.3.1 | **high — undocumented** | What the community actually shares |

   Recommend recording via the live SDK for v1 and deferring both import paths.

   ### 13.3.1 On `.blap` / `.olap`

   `.blap` is iRacing's **best lap** ghost, `.olap` the **optimal lap** stitched
   from best sectors. They live in `Documents\iRacing\lapfiles`, are per car+track,
   and drive the in-sim ghost car and split-time delta. People share them freely,
   and Trophi.ai already ingests them — so it is evidently tractable.

   **The appeal is real:** this is how the community shares *fast* laps
   specifically. A shared 2:16 Spa GT3 blap is an alien reference you would never
   set yourself.

   **The problems, in order:**

   1. **No public format documentation and no public parser** that I could find.
      Trophi solved it privately. This is a reverse-engineering project of unknown
      size, and an undocumented format can break silently on any iRacing build.
   2. **Probably no pedal channels.** A ghost car needs position, time and enough
      state to render — steering, wheels. It does not need throttle or brake
      values, so they may simply not be stored. That matters because
      `brakeOnsetPct` (§5.1), fading (§6.5) and stage 4 validation (§10) all read
      the brake channel.
      *Partial mitigation:* braking is inferable from longitudinal deceleration if
      speed-vs-distance is present. A workable proxy, not a measurement — mark any
      `ReferenceLap` derived this way so downstream code knows its provenance.
   3. **An alien lap is the wrong reference to be judged against.** This was the
      third argument against automatic fading and it survives the deferral: a
      reference nobody can match is fine to *aim at* and useless to be *measured*
      by. It now applies to the input trace instead (§7.1), where the same lap is
      both the ghost you chase and the thing your own trace is read against. If
      fading returns, the two want separating — "reference to aspire to" and
      "reference to be measured against" are not the same lap.

   **Cheap first step before committing:** hex-dump a `.blap` for a lap whose time
   you know. Look for that time as a float, and check whether file size scales with
   track length in a way that implies per-sample records. An hour of work tells you
   whether this is tractable at all.
4. ~~**Voice.** One voice for v1 — which provider?~~ **Settled: Piper**, local and
   free, `en_US-ljspeech-medium`. Native 16-bit WAV, so duration is read from the
   header and there is no `ffprobe` dependency. Noise scales must be pinned to
   zero on every invocation or the same sentence renders at a different length
   each time, which would silently retime every callout. Still swappable — the
   engine is an interface — but the durations are real now.

   **The voice is a licensing decision, not a taste one.** The first choice here
   was `en_US-lessac-medium`, which cannot be shipped: the Blizzard 2013 Lessac
   licence forbids commercialising voice-synthesis products and that reaches the
   synthesised audio, not just the model. `hfc_male` is CC BY-NC-SA. Both are
   popular, both are dead ends. A voice qualifies only when its **dataset** and
   its model both permit redistribution of the output — `ljspeech` is
   public-domain data with an MIT model, `libritts_r` is CC BY 4.0 and needs
   credit. rhasspy/piper-voices is MIT as a repository while containing voices
   nobody may ship, so the repository licence proves nothing; read the MODEL_CARD.

   **Piper itself is GPL-3.0** — it embeds espeak-ng. Spawning it as a separate
   process (which is what §10 stage 6 does) leaves this project's own licence
   alone; bundling the binary into an installer would take on GPLv3 obligations
   for that component, which is why the app downloads it on request instead. The
   last release with standalone binaries is 2023.11.14-2; everything since is a
   Python wheel. That release's **macOS tarball is broken** — it ships
   `libonnxruntime.dylib.dSYM` without the `.dylib` — so macOS renders through a
   pip-installed Piper and only Windows and Linux can self-install.
5. **CrewChief landmark corpus.** Worth an email to Jim Britton about reuse. A
   shortcut, not a dependency — do not block on it.

---

## Sources

- [irsdk-node docs](https://irsdk-node.bengsfort.dev/) · [repo](https://github.com/bengsfort/irsdk-node) · [@irsdk-node/native](https://www.npmjs.com/package/@irsdk-node/native)
- [iRacing telemetry variable reference](https://gist.github.com/teknologika/0127fa9a031ec686537277a954972ad0)
- [ibt-telemetry](https://www.npmjs.com/package/ibt-telemetry)
- [Electron BrowserWindow docs](https://www.electronjs.org/docs/latest/api/browser-window)
- [DirectX Fullscreen Optimizations](https://devblogs.microsoft.com/directx/demystifying-full-screen-optimizations/)
- [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing) · [video understanding](https://ai.google.dev/gemini-api/docs/video-understanding)
- [CrewChief track landmarks](https://mr_belowski.gitlab.io/CrewChiefV4/About_Customising_TrackLandmarks.html)
- [Garage61 developer portal](https://garage61.net/developer/endpoints/v1/findLaps)
