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

- [x] No way to regenerate a note set's placeholder audio
  `exxeed-ingest render <noteSetId>` does it, and it is stage 6 rather than a
  stand-in for it. Still needs the venv and a voice model, both gitignored — see
  README, "Rendering audio".
- [ ] Rewrite the Daytona text to name what the driver can see
  Current notes say "Brake, turn 1, left" — that is a metronome, not the product.
  §1's whole argument is naming something visible. `transcript.example.txt` (an
  MX-5 Daytona track guide, untracked, third-party) names the real ones: "the
  black seam", "the second lamp post on the left", "once the second-to-last lamp
  post disappears out of view", "the one marker" for the chicane. That is what
  the callouts should say, and it is the first honest test of the premise.

- [ ] Check in a multi-lap slice of the Daytona session as an engine fixture
  `data/reference/daytona-2011-road-mx5-lap.ndjson` is one extracted lap, so §6.4
  suppresses every one of its 4,364 frames as `out_lap` and the engine says
  nothing: replaying it gives `0 spoken, 0 dropped`. Fine as a track-map source,
  useless as a callout timeline — which is why the golden file still runs on the
  synthetic 3-lap toy and the engine has no real-telemetry regression. Two or
  three laps from `2026-08-27T20-43-48-649Z.ndjson` would close it; that file is
  on the Windows machine.
- [ ] Recording rate is 32 Hz, not the 60 Hz the adapter asks for
  Median frame gap 31 ms against a requested 16.7 ms — 1.7 m between samples at
  56 m/s rather than 0.9 m. Harmless today (well inside §6.5's 15 m threshold, and
  the scheduler's fit tolerance scales with the tick) but the code says 60 and
  reality says half that.

- [x] Replay CLI needs an absolute path
  Fixed: paths now resolve against `INIT_CWD`, the directory the command was invoked from.
- [x] Fold the §4.7 corner-lookup correction back into docs/SPEC.md
- [x] Correct §6.2's and §9's start/finish worked examples in docs/SPEC.md
  Done, along with §4.1.1 (Lat/Lon are zero; dead reckoning is what ships) and §12 (the two runtime bugs, and the measured steering sign).
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
- [x] Drive a lap, get a recording, check it into the repo as the M1 fixture
  `data/reference/daytona-2011-road-mx5-lap.ndjson` — 4364 frames, 135.39 s, MX-5 at Daytona Road, 100% grid coverage and no warnings from the resampler. Picked from a 22-minute session that yielded three fully clean laps (136.8 / 140.5 / 135.4 s); this is the fastest. `tMs` is rebased to zero so it stands alone, and the header says which track, car and source session it came from.
  *Done when:* you can drive a lap and get a recording, and you know which sign is left. **Both done.**

**M0b is closed.** The remaining M1 work is all platform-neutral again — it runs
off that one committed lap, so it does not need Windows or the sim.

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
- [x] Resample a recorded lap onto the fixed pct grid (§4.3)
  `resampleLap` in `packages/core/src/resample.ts`. Linear interpolation, not
  nearest-sample snapping — a grid cell holds ~4 samples in a slow corner and none
  on a straight, so snapping aliases the fast sections. Gear steps rather than
  interpolating. Refuses a lap whose pct goes backwards (a reset or two laps
  concatenated) instead of sorting it into plausibility; partial laps and dropped
  frames come back as warnings plus a coverage figure.
- [x] Corner detection (§5) — the algorithm
  `detectCorners` in `packages/core/src/corners.ts`, §5 implemented plainly with no
  cleverness added, per §5.2. Wrap-spanning corners are joined (Spa's turn 1 is that
  case). `steerSignRight` is a required option with no default — a default would be
  an assumption wearing a parameter's clothes — and there is a test asserting that
  flipping it inverts every direction while changing nothing else about the output.
- [x] `applyOverrides` (§5.2) and Daytona's `corners.override.json`
  `packages/core/src/overrides.ts` plus
  `data/tracks/iracing/192/road_course/corners.override.json`. Operations address
  **detected** indices and all resolve against the original detection, so a file is
  order-independent and adding one does not renumber the rest. Un-gitignored on
  purpose: it is hand-written source, not output — regenerating a map is cheap,
  regenerating the judgement in it is a person watching a lap again.
  Yields **12 corners on the fixture, matching iRacing's own count**, with T9–T11
  recovered as left-right-left.
- [x] `brakeOnsetPct` / `throttleOnPct` (§5.1) → `ReferenceLap.perCorner`
  `packages/core/src/onsets.ts`. In core, not the builder, because §5.1 requires the
  reference lap and the live driver to use the *same* function; two implementations
  that agree today would drift, and the symptom would be a callout that never fades.
  §9's required test ("returns the onset, not a sample near corner entry") is there.
  Note the 300 m search window clamps rather than running back forever, so on a
  braking zone longer than that the value is the window edge, not a real onset.
- [x] Centreline by **dead reckoning**, with a closure correction at start/finish (§4.1.1)
  `packages/core/src/centreline.ts`. 5701 m integrated against a true 5687.3 m,
  closing to within 2 m.
  **A mirrored map was shipped and confirmed before this was caught**, so the
  reasoning is worth keeping: negating yaw very nearly mirrors the path, and a
  mirrored loop closes just as well. On the fixture the *wrong* sense closed to
  1.94 m and the right one to 21.63 m — closure actively preferred the mirror, and
  choosing by it was choosing by noise. Handedness is now decided by checking the
  drawn curvature against the measured steering convention: 98.1% agreement one
  way, 2.8% the other. Below 80% it refuses to emit rather than draw a plausible
  circuit with every left turned into a right (§12).
- [x] The builder tool: `map.json` and `ReferenceLap` on disk
  `tools/trackmap` — `exxeed-trackmap <lap.ndjson> --track-id N --config <id>`.
  Writes through `packages/repo` rather than touching disk itself, because §8 is
  absolute about that. Infers track length from the lap's own `lapDistM` channel,
  which is both a measurement and a standing check on §4.3's even-spacing
  assumption. Refuses to run while the steering sign is unmeasured, and refuses to
  write an empty map.
  §4.0's asymmetry is the thing to not get wrong here and it is silent when you do:
  the map is keyed by `TrackRef` because it holds corner indices, the reference lap
  by `TrackKey` + car because re-cutting a map must not invalidate raw telemetry.
  Detection gives 13 regions on the fixture lap; the track has 12 turns. The
  corrections, confirmed against the telemetry:
  - detected 1 covers **T1 and T2** — split, around pct 0.113. Fragile: those two sit
    31 m apart against a 30 m merge rule, so they merge or split depending on the lap.
  - detected 5 is not a corner, it is **T6's entry** — a 0.153 rad left flick under
    braking (throttle 0, brake 0.5–0.7). Merge into detected 6.
  - detected 8 + 9 are one corner, **T8**.
  - detected 10 hides a sign change and is really **T9 (left) + T10 (right)**: a
    0.471 rad sustained left at 0.6675 before the 0.677 right at 0.6885. Detection
    averaged the two and reported "right". Detected 11 is **T11** — left-right-left.
  - detected 12 + 13 are one corner, **T12**.
  Note the two sign-change cases pull opposite ways: T6's entry must merge across a
  sign flip, T9/T10 must split at one. Three times the magnitude separates them,
  which is exactly why §5.2 says hand-fix rather than tune a rule.
- [ ] `brakeOnsetPct` / `throttleOnPct` (§5.1) → `ReferenceLap.perCorner`
  One definition shared by reference and live driver, or §6.5's error metric compares different quantities.
- [x] Throwaway script rendering detected corners so you can eyeball them
  `tools/trackmap/src/render.ts`, behind `--svg`. Not actually throwaway: it is the
  only way to tell a correct map from a plausible one, and §5.2's workflow is look,
  correct, look again. Draws direction-of-travel arrows specifically because a
  mirrored map is otherwise indistinguishable by eye — which is not hypothetical,
  it happened.
  *Done when:* Daytona Road Course's corners come out right, with `corners.override.json` used only for the cases §5.2 already says are unsolvable.

**M1 is done.** `pnpm --filter @exxeed/trackmap start data/reference/daytona-2011-road-mx5-lap.ndjson
--track-id 192 --config road_course --car-id 67 --overrides
data/tracks/iracing/192/road_course/corners.override.json --svg map.svg` produces
a 12-corner map matching iRacing's own turn count, a reference lap with all six
channels and per-corner metrics, and a picture to check it against.

Numbers from that run, worth keeping as the baseline to notice regressions against:
lap 135.39 s, 100% grid coverage, length inferred 5687.3 m against the sim's
5.6873 km, centreline path 5701 m closing to 21.6 m, orientation agreement 98.1%.

**A prediction made here was wrong, and it is worth keeping the correction.** The
expectation was that Daytona would hit both of §5.2's failure modes — that the
banked sections, held at high speed on very little steering, would fall under a
P98 threshold raised by the infield hairpin, and would need an override entry.

They did not. The banking is detected comfortably, as two long gentle arcs (614 m
and 503 m, 155 and 181 kph, peak 0.17 rad against a 0.118 threshold). §5's
adaptive threshold handled a track that was supposed to defeat it. The real
failures were elsewhere and were the opposite shape: **regions merged that should
have split**, because averaging the steering over a region hides a sign change.

The banking still needs no callouts — it is not a corner anyone has to be taught —
but that is now a note-set decision about what to say, not a detection problem.

One thing it does still cost, and it is worth settling before authoring anything:
**corner numbering.** iRacing reports Daytona Road as 12 turns, and a coach in a
video says "turn six" meaning the conventional sixth. If detection emits only the
corners it found, our `index` values silently mean something different from every
external reference — including the corner list M5 stage 3 hands the model as an
enum (§10). Number the corners to match the track's convention via
`corners.override.json`, including entries for corners carrying no notes, rather
than numbering whatever detection happened to return.

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
- [x] Corners too close together share one callout, anchored at the first
  Falls out of the model rather than needing a rule: T9-T11 is one note at 0.6563. So does the throttle cue that used to be its own line.
  There is no time to say two things between two corners a second apart, so a
  complex gets one note covering the sequence rather than one note per corner.
  **This is a NoteSet decision, not a TrackMap one** — the gap that matters is in
  *seconds*, so it is car-dependent, and the map stays car-independent with every
  corner on it (§4.0). Computable exactly from `ReferenceLap.elapsedS` rather than
  guessed, and it is the text version of §7.4's trigger-window shading.
  Measured at Daytona in the MX-5: only T3→T4 (1.61 s) is tight enough to force
  it. Everything else clears the ~1.9 s a full-form callout needs — including the
  T9–T11 complex, at 2.67 s and 4.07 s. Expect more pairs to collapse in a GT3.
- [x] Hand-author note sets for Daytona Road Course and Spa (long, turn 1 wraps — deliberately the hard case)
  Daytona is 6 notes, one per braking point, merged from 12 — one callout every ~22 s over the lap. Text is still placeholder and every note is `dirty`, so it stays `draft` until there is a real voice.
  **Blocked on M0b.** A note set needs a TrackMap and a LandmarkInventory to anchor against, and both come from a recorded lap. `data/demo/` holds a two-corner Spa stub to develop against; inventing full corner geometry for a braking-point app would be worse than waiting.
- [x] Pick a voice provider (§13 Q4) and render real audio
  **Piper.** Local, free, offline, native WAV, runs anywhere — so the audio pack can be a build artefact rather than something that exists on one machine. Costs nothing to swap later: the whole v1 corpus is ~126k characters, which fits inside most providers' free tiers, so quality is the only thing that would ever justify moving.
  Not deterministic by default — ~240 ms of drift between renders. `--noise-scale 0 --noise-w-scale 0` fixes it and the renderer passes them always.
- [x] §9 required tests: the S/F double-fire case, and two priority-1 notes contending resolve deterministically
  Still owed from §9: `brakeOnsetPct` returns the onset (needs M1), and golden-file timelines against a real recording (needs M0b).
- [x] Wire the engine into the Electron app
  Main owns the loop, the engine and the decision; the renderer is only the output device, since Node has no audio out. That window sets `backgroundThrottling: false` so the output path cannot be throttled either.
- [x] Golden-file the replay timeline
  `tools/replay/test/golden/` against the synthetic fixture. Freezes the engine, not the driving — rebaseline it against a real Daytona Road lap at M0b (`UPDATE_GOLDEN=1`). Verified it bites: changing `REACTION_BUFFER_S` fails it.

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
  *Done when:* twenty laps of Daytona Road Course leaves only the corners you keep getting wrong.

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
