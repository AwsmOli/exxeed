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

Step-by-step: **[docs/WINDOWS.md](docs/WINDOWS.md)**.

- [x] `irsdk-node` connects and prints `LapDistPct`, `Speed`, `Throttle`, `Brake`, `Gear`, `SteeringWheelAngle`, `IsOnTrack`, `OnPitRoad`, `PlayerTrackSurface` at 60 Hz
- [x] **Measure the steering sign convention** and hardcode it as a named constant with a test (§5)
  Measured 2026-08-27, MX-5 at Daytona: **right is negative**, left positive. `STEER_SIGN_RIGHT = -1`, `STEER_SIGN_MEASURED = true`, covered by `packages/telemetry/test/steering.test.ts`. Agrees with iRacing's counter-clockwise-positive convention, but the agreement is a cross-check — the source is a driver turning right and reading the sign.
- [x] Confirm `Lat`/`Lon` are actually populated
  **They are not.** Not zero — *absent* from the telemetry variable list (`"Lat" in telemetry === false`). §4.1.1's primary centreline path does not exist on iRacing, so the dead-reckoning fallback is the only one. See M1 below.
- [x] Record the channels dead reckoning needs, before driving the M1 lap
  `VelocityX`, `VelocityY`, `YawNorth` all present and now in `TelemetryFrame`, along with `LapDist` (metres). Done ahead of the lap deliberately: a lap recorded without them cannot produce a centreline, and the fix would have been to drive it again.
- [x] Label recordings with track and car, and group them by both
  `data/recordings/<track>/<car>/<timestamp>.ndjson`, ids from the sim's own `TrackName`/`CarPath`. The header repeats it, so a file moved out of the tree still says what it is. `ReplayAdapter.identity` reads it back.
- [ ] Drive a lap, get a recording, check it into the repo as the M1 fixture
  Still owed, and it is the deliverable. Needs **Okayama**, not Daytona — M1's *done when* is Okayama's corners coming out right.
  *Done when:* you can drive a lap and get a recording, and you know which sign is left.

Three things came out of doing this that were not visible from macOS:

- `LapDist` cross-checks the pct grid exactly: at Daytona, `lapDistPct` 0.04174 ×
  5687.3 m = 237.4 m against a reported `lapDistM` of 237.39. §4.3's assumption
  that pct is evenly spaced in distance holds, and now there is a channel to keep
  checking it against rather than trusting it.
- `getTelemetry()` **aborts the process** — not throws — if called before the
  session data is mapped. It has to be gated on `sessionStatusOK`, which only
  refreshes when `waitForData` is called. Nothing in the SDK docs says so.
- `waitForData` blocks the calling thread, and in Electron that thread also pumps
  Chromium's message loop. A blocking wait there starves IPC to the renderer:
  frames reach the recorder and the window shows nothing.

## M1 — Replay harness + track map builder

- [x] Replay a recording on a virtual clock
  Landed early, in M0a — §9 puts the harness before the engine, so it had to.
- [ ] Resample a recorded lap onto the fixed pct grid (§4.3)
  Everything else in M1 consumes this, not raw frames: corner detection, the onset
  functions and the centreline all assume one lap on one evenly-spaced grid. It is
  also where a lap gets rejected as unusable — off-track, a reset, or a wrap that
  never happens.
- [ ] Corner detection (§5) → `corners.json`, plus `corners.override.json` for hand fixes
  Don't try to solve chicanes and fast kinks algorithmically — ten minutes per track beats a week of tuning.
  Unblocked now the steering sign is measured: `directionFromSteer()` throws until it is, by design.
- [ ] `brakeOnsetPct` / `throttleOnPct` (§5.1) → `ReferenceLap.perCorner`
  One definition shared by reference and live driver, or §6.5's error metric compares different quantities.
- [ ] Centreline by **dead reckoning**, with a closure correction at start/finish (§4.1.1)
  **Changed from the spec, and not by choice.** §4.1.1 says use Lat/Lon and treat
  dead reckoning as the fallback; iRacing does not expose Lat/Lon at all (M0b), so
  the fallback is the whole plan. Integrate `velocityXMps`/`velocityYMps` rotated
  by `yawNorthRad`, then distribute the closure error around the lap — an
  uncorrected loop does not join up, and the editor (§7.4) draws its map from this.
  Must reject an all-zero-velocity lap loudly: every recording made before these
  channels existed parses fine and integrates to a single point.
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
- [x] Preload WAVs at session start; never touch disk at trigger time
  Clips are read, duration-checked and shipped to the renderer once; decoding happens there at preload, not on play. A pack whose declared `durationMs` disagrees with the file is a warning, not a shrug — it mistimes every callout for that note.
- [ ] Hand-author note sets for Okayama (short) and Spa (long, turn 1 wraps — deliberately the hard case)
  **Blocked on M0b.** A note set needs a TrackMap and a LandmarkInventory to anchor against, and both come from a recorded lap. `data/demo/` holds a two-corner Spa stub to develop against; inventing full corner geometry for a braking-point app would be worse than waiting.
- [ ] Pick a voice provider (§13 Q4) and render real audio
  The audio path is built and runs on placeholder tones at the declared durations. Timing logic is verifiable now; whether a callout *feels* early or late is not, until the words are real.
- [x] §9 required tests: the S/F double-fire case, and two priority-1 notes contending resolve deterministically
  Still owed from §9: `brakeOnsetPct` returns the onset (needs M1), and golden-file timelines against a real recording (needs M0b).
- [x] Wire the engine into the Electron app
  Main owns the loop, the engine and the decision; the renderer is only the output device, since Node has no audio out. That window sets `backgroundThrottling: false` so the output path cannot be throttled either.
- [x] Golden-file the replay timeline
  `tools/replay/test/golden/` against the synthetic fixture. Freezes the engine, not the driving — rebaseline it against a real Okayama lap at M0b (`UPDATE_GOLDEN=1`). Verified it bites: changing `REACTION_BUFFER_S` fails it.

*Done when:* callouts land where a coach would say them, at both tracks, in two
cars, with the S/F test green.

**The machinery is finished; the content is not.** Everything mechanical works end
to end — trigger, state machine, scheduler, suppression, preloading, audio out,
golden-filed timeline:

    EXXEED_NOTES=spa-gt3-fixture EXXEED_SPEED=8 pnpm dev
    pnpm --filter @exxeed/replay start <rec.ndjson> --notes spa-gt3-fixture --data data/demo

What is missing is real content, and both halves are blocked on things outside this
machine: note sets need a recorded lap (M0b), and judging whether a callout *feels*
right needs a real voice (§13 Q4). So M2 cannot be closed here, and the two open
items above say why rather than being quietly ticked.

Two findings from running it rather than unit-testing it:

- A note that sat in the queue while the car drove past its event used to play
  anyway: `aheadM` is always positive (§4.6), so it reported the event as 6990 m
  ahead instead of 14 m behind. Now dropped as `event_passed`.
- Looping a replay rewinds `tMs`, and the scheduler kept a stale `busyUntilMs`
  across the gap — muting the channel into the next pass. It now treats time going
  backwards as a new session.

## M3 — Overlays

- [x] Overlay window flags (§7) — transparent, frameless, always-on-top,
      click-through, with a layout-edit toggle and remembered position
  Brought forward from M3 so the M0b steering-sign reading can be done while
  driving. `EXXEED_OVERLAY=1`. The borderless-windowed warning prints at launch;
  it belongs in the first-run flow at M6.
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
