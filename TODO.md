Milestones from [docs/SPEC.md](docs/SPEC.md) §11. Read §12 (Pitfalls) before
writing code — it is a read-before-coding list, not a task list, so it is not
duplicated here.

## M0a — Skeleton (platform-neutral, works on macOS)

- [x] pnpm workspace + strict tsconfig
  All of §3's flags on, `noUncheckedIndexedAccess` included. No `.js` sources, no `allowJs`.
- [x] Lint rule enforcing `packages/core` purity
  §3 asks for it to be enforced, not documented. Ban `fs`/`path`/`electron`/`irsdk-node` imports there.
- [x] Branded units (§3) — `Pct`, `Metres`, `Mps`, `Seconds`
  Constructors at I/O boundaries only.
- [x] `wrapPct` / `aheadM` / `deltaM` (§4.6)
  Every distance comparison in the codebase goes through these.
- [x] `TrackKey` / `TrackRef` (§4.0) and Zod schemas for the §4 artefacts
- [x] `resolveEventPct` + `PHASE_PCT` (§4.7)
- [x] `TelemetryFrame` + `TelemetrySource` interface
  Include `Lat`/`Lon` from the start so M1's centreline comes free rather than needing a second driving session.
- [x] NDJSON telemetry recorder (§9.1) — record every frame, always, cheaply
- [x] `ReplayAdapter` — virtual clock at 1x/Nx, the adapter everything is developed against
- [x] `IRacingAdapter` with a lazy import behind a win32 guard
  Keeps the whole tree importable and typecheckable off Windows.
- [x] Repository interfaces + `LocalFile*` implementations (§8)
  `ReferenceLapRepository` is keyed by `TrackKey`, **not** `TrackRef` — that asymmetry is the point of §4.0.
- [x] Electron shell; telemetry loop in **main**, never a renderer (§7)
- [x] `tools/replay` CLI over a checked-in NDJSON fixture
- [x] Tests green with no sim: wrap boundary both directions, branded-unit `@ts-expect-error`, schema fixtures, replay ordering

M0a is done: 59 tests green, `pnpm typecheck` and `pnpm lint` clean, Electron boots
on macOS against `ReplayAdapter`. Two things worth knowing that came out of building it:

- `@irsdk-node/native` does **not** fail off Windows — its installer substitutes a
  **mock** that returns fabricated telemetry. `IRacingAdapter` guards on platform
  and throws anyway, because an app that appears to connect and streams plausible
  garbage is worse than one that refuses.
- SPEC.md §4.7's listing does `map.corners[note.anchor.cornerIndex]`, which indexes
  by array *position*. Corner indices are 1-based and §5.2's override file can
  renumber them, so the implementation looks up by the `index` field instead.

## Small stuff

- [x] Replay CLI needs an absolute path
  Fixed: paths now resolve against `INIT_CWD`, the directory the command was invoked from.
- [ ] Fold the §4.7 corner-lookup correction back into docs/SPEC.md
- [ ] Correct §6.2's and §9's start/finish worked examples in docs/SPEC.md
  Both illustrate the double-fire with a note anchored at pct 0.998. That event sits *before* the line, so by the time a naive `firedThisLap` set is cleared the event is a whole lap behind (6988 m) and even the broken design cannot re-fire. The bug needs the trigger on one side of the line and the **event on the other** — turn 1's *entry* at 0.0121, not the 100 board at 0.99781. Bug is real; the illustration is off by one anchor. See `packages/core/test/engine.test.ts`.
- [ ] Install `ffprobe` before starting M5 stage 6

## M0b — Live SDK (needs a Windows machine with iRacing)

- [ ] `irsdk-node` connects and prints `LapDistPct`, `Speed`, `Throttle`, `Brake`, `Gear`, `SteeringWheelAngle`, `IsOnTrack`, `OnPitRoad`, `PlayerTrackSurface` at 60 Hz
- [ ] **Measure the steering sign convention** and hardcode it as a named constant with a test (§5)
  §12: never assume it. Get it backwards and every corner's `direction` inverts silently, with no crash to tell you.
- [ ] Confirm `Lat`/`Lon` are actually populated
  §4.1.1's centreline depends on it; the dead-reckoning fallback drifts and needs a closure correction.
- [ ] Drive a lap, get a recording, check it into the repo as the M1 fixture
  *Done when:* you can drive a lap and get a recording, and you know which sign is left.

## M1 — Replay harness + track map builder

- [ ] Replay a recording on a virtual clock
- [ ] Corner detection (§5) → `corners.json`, plus `corners.override.json` for hand fixes
  Don't try to solve chicanes and fast kinks algorithmically — ten minutes per track beats a week of tuning.
- [ ] `brakeOnsetPct` / `throttleOnPct` (§5.1) → `ReferenceLap.perCorner`
  One definition shared by reference and live driver, or §6.5's error metric compares different quantities.
- [ ] Centreline from Lat/Lon, equirectangular about mean latitude (§4.1.1)
- [ ] Throwaway script rendering detected corners so you can eyeball them
  *Done when:* Okayama's corners come out right without hand-editing.

## M2 — Note engine + audio

- [x] Per-note state machine (§6.2) — ARMED/SPENT, no lap concept
  §12: never clear fired-state at start/finish. It double-fires turn 1 at most tracks. Regression test verified by mutation: the naive `firedThisLap` design fails all three S/F tests.
- [x] `leadSecondsFor` (§6.1) as the single source of truth for lead time
  Both adjustment layers separate and additive, with a floor so a negative adjustment can never leave the voice still talking after its own event.
- [x] Scheduler: fit test, short-form fallback, priority admission, tie-break by event position (§6.3)
  Dropping applies at every priority including 1 — a braking cue that arrives late is worse than silence.
- [x] Suppression (§6.4)
  All seven conditions, plus the 2 s off-track hold and the out-lap gate.
- [ ] Preload WAVs at session start; never touch disk at trigger time
- [ ] Hand-author note sets for Okayama (short) and Spa (long, turn 1 wraps — deliberately the hard case)
  Raw JSON is fine. Two tracks isn't enough to justify building the editor first, and hand-authoring is a useful way to feel where the schema is awkward.
- [x] §9 required tests: the S/F double-fire case, and two priority-1 notes contending resolve deterministically
  Still owed from §9: `brakeOnsetPct` returns the onset (needs M1), and golden-file timelines against a real recording (needs M0b).
- [ ] Wire the engine into the Electron app
  `apps/desktop` still only forwards frames. Needs audio playback, which needs a voice provider picked (§13 Q4).
- [ ] Golden-file the replay timeline
  Format and CLI are in place (`--notes`); needs a real recorded lap to be worth freezing.

*Done when:* callouts land where a coach would say them, at both tracks, in two
cars, with the S/F test green.

The engine (trigger, state machine, scheduler, suppression) is in and runs off a
recording via `pnpm --filter @exxeed/replay start <rec.ndjson> --notes spa-gt3-fixture
--data data/demo`. One finding from actually running it: a note that sat in the
queue while the car drove past its event used to play anyway, because `aheadM` is
always positive (§4.6) and reported the event as 6990 m ahead instead of 14 m
behind. Now dropped as `event_passed`. Unit tests did not catch this; replaying a
timeline did.

## M3 — Overlays

- [ ] Input trace vs reference (Canvas, §7.1)
- [ ] Delta bar off `elapsedS` (§7.2)
- [ ] Dev callout overlay behind a debug flag (§7.3)
  Not a shipping feature — the only way to see what the engine is doing while sitting in the car.
- [ ] Apply §7.0's Vue reactivity rules: `shallowRef` frames, `markRaw` channel arrays, Canvas subscribes to IPC directly
  *Done when:* you can see your brake trace lagging the reference in real time.

## M4 — Fading + profile

- [ ] Per-`(trackRef, carId, cornerIndex, phase)` learning state with the 15 m / 22.5 m hysteresis (§6.5)
- [ ] Count only valid laps; persist to `/data/profile/`
  *Done when:* twenty laps of Okayama leaves only the corners you keep getting wrong.

## M5 — Ingest pipeline (parallel from the start, separate package)

- [ ] Stages 0–2: normalise, metadata, triage funnel
- [ ] Stage 3: extraction with the corner list and landmark inventory passed **as enums**
  §12: never let the LLM free-text a corner reference. Enum or null.
- [ ] Stage 4: cross-check against reference lap telemetry
- [ ] Stage 5: the note editor (§7.4) — build it once, use it for both review and hand-authoring
- [ ] Stage 6: TTS for both `text` and `textShort`, `ffprobe` real durations
  **Needs `ffprobe` installed** — not currently on this machine.
  *Done when:* a YouTube URL for a Spa GT3 guide produces a reviewed, rendered note set the runtime can load.

## M6 — Packaging

- [ ] Windows installer
- [ ] First-run flow including the borderless-windowed warning
  Put it in first-run, not the FAQ. It is the number one support question for every overlay app in existence.
- [ ] Overlay layout editor, note-set picker UI

## Open questions (§13)

- [ ] **Landmark inventory bootstrap.** Manual for the first two tracks, or worth building a marking tool in M1?
- [ ] **Car class taxonomy.** Need a car-ID → class mapping table, and a granularity decision (GT3 vs GT3-by-manufacturer).
- [ ] **Reference lap source.** Live SDK recording for v1; `.ibt` and `.blap`/`.olap` import deferred.
- [ ] Cheap first step on `.blap`: hex-dump a lap whose time you know, look for that time as a float, check whether file size scales with track length in a way that implies per-sample records. An hour of work tells you whether it's tractable at all.
- [ ] **Voice provider.** One voice for v1. Only affects stage 6 and is swappable, but pick before M2 so durations are real.
- [ ] **CrewChief landmark corpus.** Worth an email to Jim Britton about reuse. A shortcut, not a dependency — don't block on it.
