Milestones from [docs/SPEC.md](docs/SPEC.md) §11. Read §12 (Pitfalls) before
writing code — it is a read-before-coding list, not a task list, so it is not
duplicated here.

## Where this diverged from the plan

Six decisions changed the shape of the thing. SPEC.md is updated for all of
them; this is the short version of what moved and why, because several items
below only make sense with it.

0. **Automatic fading is deferred.** The driver swaps to a shorter note set
   instead of the engine inferring what they have learned. §1's promise is
   unchanged; the mechanism moved from inferred to chosen. M4 is now empty of
   engine work.
1. **A note is a point and a message.** `phase`, `cornerIndex` and the anchor
   union are gone. The engine does not need to know whether a callout is about
   braking, throttle, a bump or the pit entry — it needs to know *where* and it
   needs the words. Merging beat splitting: Daytona went from 12 notes to 5, one
   per braking point, because two lines per corner is more than a driver can use.
   A `pct` is also the most stable anchor available, not the least — lap position
   is physical tarmac, corner numbering is a derived artefact — so a NoteSet is
   keyed by `TrackKey` and carries `lengthM`, and **the runtime loads one artefact
   plus its audio**. No TrackMap, no LandmarkInventory.
2. **Landmarks are an M5 concern, not a prerequisite.** A landmark reference in
   the words is a string. The inventory exists so §10 stage 3 can hand the model a
   closed vocabulary.
3. **`Lat`/`Lon` do not exist on iRacing**, so §4.1.1's primary centreline path is
   dead and dead reckoning is the only one. That brought a hazard the original did
   not have: yaw handedness cannot be assumed and closure will not catch a
   mirrored map.
4. **Overlays are separate windows**, one per panel, each placeable and remembered.
   A rig has a shape and one combined panel can only be in one place.
5. **Configuration is a preferences window**, not environment variables. Twelve
   env vars were a scripting interface being used as a product; they survive as
   start-up overrides because the scripts here rely on them.

Two milestones were also done out of order: §7's overlay flags landed in M0b so
the steering sign could be read while driving, and §10's stage 6 landed in M2
because a hand-authored note set with no audio cannot speak.

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
- [x] `resolveEventPct` + `PHASE_PCT` (§4.7) — *later deleted*
  Built as specified, then removed wholesale when a note became a point and a
  message (§4.4). Left ticked because it was done, not because it is there.
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
  renumber them, so the implementation looked up by the `index` field instead.
  Moot now — anchors are gone — but it is why §4.7 was rewritten rather than
  patched.

## Small stuff

- [x] No way to regenerate a note set's placeholder audio
  `exxeed-ingest render <noteSetId>` does it, and it is stage 6 rather than a
  stand-in for it. Still needs the venv and a voice model, both gitignored — see
  README, "Rendering audio".
- [x] `REACTION_BUFFER_S` raised from 0.5 s to 1.0 s
  The gap a driver actually hears is buffer-sized, not text-sized. Measured at
  Daytona: **halving every clip moved the gap by 0.02-0.08 s**, because the lead
  is derived from the duration, so a shorter clip just starts later and lands in
  the same place. Shortening text is the lever for making a callout *fit*, never
  for giving it air. §6.1's worked example moves 173 m to 207 m, and the §6.2
  start/finish example fires at 0.99003 rather than 0.99496; both updated in
  SPEC.md along with the tests that encode them, and the golden file rebaselined.
  The cost is that notes which only just fitted now fall back or drop — the Spa
  synthetic's throttle cue changed from `event_passed` to `no_fit_after_short`.
  Daytona has room: nothing drops, and the tightest gap between callouts is 12.5 s.
- [x] Rewrite the Daytona text to name what the driver can see
  Done, from `transcript.example.txt`, and rendered with Piper — five notes, real
  speech, measured durations, no note `dirty`. The set is now anchored on the
  **measured brake onsets** from the reference lap rather than `entryPct`: the
  words say "brake", so the anchor has to be where the braking starts, which is
  also what §10 stage 4 validates against. That moved every note 20-57 m earlier.
  T2 is gone — the reference lap's second dab at 0.0725 is the trail through the
  T1 complex, and the coach calls it as one corner (§4.4 "merge, do not split").
  T12 is deliberately silent: the transcript's line there is track limits, a
  condition over 700 m, not a point event. One line to add if that reads wrong.
  **The two slip-road notes are the weak point.** T6 and T7 are "brake at the
  left slip road" and "brake at the right slip road", and the road is on the
  opposite side to the turn each time. Direction leads the phrasing so the short
  form stays unambiguous, but this is the pair to listen to first on track.

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
- [x] ~~Install `ffprobe` before starting M5 stage 6~~ — **not needed**
  Piper emits WAV, and `wavDurationMs` reads the duration straight out of the
  header. That is measuring, not estimating, which is what §12's rule actually
  asks for. `ffprobe` only comes back if a future voice provider emits something
  that is not WAV.

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
  Daytona is 5 notes, one per braking point, merged from 12 — one callout every ~27 s over the lap. Text and audio are both real as of the transcript rewrite above; it stays `draft` until the callouts have been heard from the car.
  Spa remains the two-corner `data/demo/` stub. It is a fixture for the wrap case, not a note set anyone would drive, and it needs a Spa lap before it is more than that.
- [x] Pick a voice provider (§13 Q4) and render real audio
  **Piper.** Local, free, offline, native WAV, runs anywhere — so the audio pack can be a build artefact rather than something that exists on one machine. Costs nothing to swap later: the whole v1 corpus is ~126k characters, which fits inside most providers' free tiers, so quality is the only thing that would ever justify moving.
  Not deterministic by default — ~240 ms of drift between renders. `--noise-scale 0 --noise-w-scale 0` fixes it and the renderer passes them always.
- [x] §9 required tests: the S/F double-fire case, and two priority-1 notes contending resolve deterministically
  `brakeOnsetPct` returns the onset landed with M1. Still owed: a golden-file
  timeline against a *real* recording — see the multi-lap fixture under Small
  stuff, which is the one thing blocking it.
- [x] Wire the engine into the Electron app
  Main owns the loop, the engine and the decision; the renderer is only the output device, since Node has no audio out. That window sets `backgroundThrottling: false` so the output path cannot be throttled either.
- [x] Golden-file the replay timeline
  `tools/replay/test/golden/` against the synthetic fixture. Freezes the engine, not the driving — rebaseline it against a real Daytona Road lap at M0b (`UPDATE_GOLDEN=1`). Verified it bites: changing `REACTION_BUFFER_S` fails it.

*Done when:* callouts land where a coach would say them, at both tracks, in two
cars, with the S/F test green.

**The machinery is finished, and the content is real.** Daytona has five notes
naming things a driver can see, rendered by Piper with measured durations, and
they fire on the reference lap:

    pnpm dev            # settings come from the preferences window now
    pnpm --filter @exxeed/replay start <rec.ndjson> --notes daytona-mx5-draft --data data

What is left is the one thing that cannot be checked from a chair: whether the
callouts land where a coach would say them, in the car. The set stays `draft`
until then. §11's bar also asks for two tracks and two cars, and there is one of
each.

Three findings from running it rather than unit-testing it:

- A note that sat in the queue while the car drove past its event used to play
  anyway: `aheadM` is always positive (§4.6), so it reported the event as 6990 m
  ahead instead of 14 m behind. Now dropped as `event_passed`.
- Looping a replay rewound `tMs` and the lap counter, so the scheduler kept a
  stale `busyUntilMs` and §6.4's out-lap gate never lifted. A looped pass now
  continues both — reaching the end of a file is an artefact of replay, not
  something that happened to the car.
- §6.3's fit test was re-deriving the trigger's own inequality and disagreeing
  with it. On an accelerating approach the lead *requirement* grows while
  `dAhead` shrinks, so they close faster than the car moves and callouts fell
  back to the short form for no audible reason. The trigger is now authoritative
  for a note served on the tick it became due.

## M3 — Overlays

- [x] Overlay window flags (§7) — transparent, frameless, always-on-top, click-through
  Brought forward so the M0b steering-sign reading could be done while driving.
- [x] **One window per panel**, each placeable and remembered
  Not in the original plan, and it should have been: a rig has a shape, and one
  combined panel can only be in one place. `telemetry`, `map`, `trace`, `delta`,
  `callouts`, all rendering the same document with the panel chosen by query
  string. Positions persist per panel; a panel whose display has gone away comes
  back on the primary one.
- [x] Drag them with the mouse
  `Cmd/Ctrl+Shift+E` unlocks every overlay at once — click-through windows cannot
  be dragged, and unlocking them one at a time is the opposite of arranging a
  layout. Done in JS rather than `-webkit-app-region: drag`, which swallows every
  mouse event in its region. Uses `movementX`: `screenX` is derived from the
  window's own origin, so it fed the window's movement back into the next delta
  and overshot by 9%.
- [x] The track map, with the car on it
  Also unplanned. It is the fastest way to see that a map, a note set and the
  telemetry agree about the same track — three artefacts that are individually
  plausible and can still disagree. The car dot goes orange while suppressed,
  which answers "why is nothing being said" at a glance.
- [x] Input trace vs reference (Canvas, §7.1)
  Throttle and brake, live against the reference ghosted behind, on a rolling
  ±8% window. Both are on the pct grid (§4.3) so the ghost is an index lookup
  with no time alignment. Corner guides are faint verticals and the reference's
  `brakeOnsetPct` is marked — §7.1 calls seeing your own trace start after that
  marker the most legible feedback in the app.
- [x] Delta bar off `elapsedS` (§7.2)
  `LapTimer` turns the sim's session clock into lap-elapsed and reports nothing
  until it has actually seen a crossing: a delta against a lap whose start was
  guessed is worse than none. Same half-lap test §6.2 re-arms on, because
  counting every backwards step reported 4404 laps for a six-lap session.
- [x] Dev callout overlay (§7.3)
  Every engine decision now reaches the window, not just the plays. **Drops never
  did**, so the log could show what was said but not what was withheld or why —
  the more useful half when you are wondering about a silence. Plus the next note
  ahead in metres and whether it is armed.
  Not gated behind a debug flag, deliberately: the whole window *is* the dev
  surface, so a flag would gate nothing until there is a shipping UI at M6.
- [ ] ~~Apply §7.0's Vue reactivity rules~~ — **superseded: there is no Vue**
  The renderer is plain JS that already does what those rules ask — subscribe to
  IPC directly, stash the frame in a plain variable, draw in `requestAnimationFrame`,
  never re-render on telemetry. §7.0 exists to stop a framework being wrapped
  around 60 Hz data; not having the framework satisfies it more completely than
  following the rules would.
  Still a real decision to make, not a dodge: §3's stack table says Vue 3, and M6
  wants a layout editor and a note-set picker where a framework would earn its
  keep. **Revisit at M6**, when there is a form-heavy surface to justify adding a
  bundler to the Electron app — not before, on the strength of two canvases.

**M3 is done**, minus the Vue question, which is deferred rather than dropped.

Renderer console output is forwarded to the terminal, which is not cosmetic: a
drawing error was previously silent — blank canvas, healthy-looking log, no
devtools when running headless. It caught the panel split leaving a dozen element
accesses unguarded, in four of the five windows.

## M4 — Deferred

**Automatic fading is not in v1.** A driver picks a shorter note set once a track
is familiar, rather than the engine deciding for them. SPEC.md §6.5 carries the
reasoning; the short version is that it is opaque when it misfires, cannot be
tuned before there is experience to tune against, and rests on an open question
about which reference lap it should measure against.

The goal from §1 — stop saying what the driver already knows — is unchanged. Only
the mechanism moved, from inferred to chosen.

- [x] Decide how a driver reduces the callouts
  **More than one note set per track and car**, chosen in preferences. Needs no
  new mechanism: note sets and the picker both already exist.
- [ ] Author a short Daytona set alongside the full one
  Only the corners that stay hard. Cannot sensibly be chosen before the full one
  has been driven — picking which callouts to keep is exactly the judgement that
  needs a lap first.
- [ ] Revisit if the duplication hurts
  Text and audio are copied across sets, so editing one callout means editing it
  everywhere it appears. The smaller fix is a level on each note plus a setting
  that picks how far down to play — one set, one audio pack, one place to edit.
  Worth reaching for when the duplication is actually painful, not before.

`fadeable` is gone from `Note`, and `/data/profile/` is unused — there is no
learning state to persist.

## M5 — Ingest pipeline (parallel from the start, separate package)

- [ ] Scan a playlist or channel to build a backlog of track/car combos
  Run stages 0–3 over every video a channel has, and keep the output as a **pool
  of ordered hints** rather than a note set per video. Resolution to `pct` happens
  later, when there is a reference lap for that track and car — so the backlog is
  a worklist of combos ready to refine, and ingest stops being blocked on having
  driven the track first.

  **Why a pool and not one note set per video.** Agreement across sources is the
  quality signal the current one-video shape cannot express. The Daytona
  transcript already showed it in miniature: its hot lap and breakdown lap agreed
  on the brake percentage at T4, T6 and T7 and differed by 5% at T1. And its
  chicane advice — "a little bit more brake to get through the second apex" — is
  contradicted by the reference lap, which brakes once and never returns. With one
  video there is no way to tell whether the coach or the reference driver is the
  outlier. With five there is.

  **Store the ordinal, not just the words.** A guide narrates corners in lap
  order, so the third braking instruction in a video is the third braking event on
  track — and braking events fall out of a reference lap with a threshold and a
  loop (six at Daytona). Aligning those two sequences assigns corners with no
  landmark understanding at all. It is the cheapest and strongest signal available,
  it is free at extraction time, and it cannot be recovered afterwards.

  **The artefact is new** — track and car-class guess, ordinal, the landmark
  phrase verbatim, a normalised action, `videoId`, `sourceTs`, channel, confidence
  — plus a resolve step taking pool + reference lap + corner list → NoteSet. That
  is a §10 rewrite, not a task inside the existing stages.

  **Two things to settle first.** Fetching third-party transcripts is the sticking
  point: `captions.download` only works for videos you own, and auto-generated
  captions are not exposed through the Data API at all, so every working tool
  (`yt-dlp --write-auto-subs`, `youtube-transcript-api`) uses the internal
  `timedtext` endpoint, against YouTube's ToS. That reads differently for a
  personal tool than for something shipped, and it is a decision, not an oversight.
  The metadata half is clean and free — `playlistItems.list` is one quota unit per
  fifty videos against 10,000 a day. Cost is not a constraint either: at §10's
  numbers a 500-video channel comes in under a dollar.
- [ ] §10's "cap `text` at 8 words" no longer matches the note sets we want
  The Daytona set runs 11-19 words and 3.4-5.0 s a callout, because the transcript
  carries a braking landmark *and* an aim point *and* a throttle reference per
  corner, and the timing has room for all three — 11-33 s between callouts, and
  nothing drops. The cap was never the binding constraint; it is a cognitive-load
  judgement, and it currently disagrees with the only hand-authored set we have.
  Settle it before stage 3 is prompted against it, or the pipeline will generate
  notes unlike the ones actually chosen.
- [ ] Stages 0–2: normalise, metadata, triage funnel
- [ ] Stage 3: extraction with the corner list passed **as enums**
  §12: never let the LLM free-text a corner reference. Enum or null.
  Two things changed under this. The corner index is now a stage-3 *output only* —
  the pipeline resolves it to a `pct` before writing the note (§4.4), so nothing
  downstream carries it. And the landmark inventory is optional: a landmark
  reference in the words is just a string, so the enum is worth having to stop the
  model inventing a bridge that is not there, not because the runtime needs one.
  The prompt also has to say **one note per corner** — the model will happily emit
  an approach, an apex and an exit note for the same corner, which is three lines
  where a driver can use one.
- [ ] Stage 4: cross-check against reference lap telemetry
- [x] Stage 5: the note editor (§7.4) — build it once, use it for both review and hand-authoring
  `Cmd/Ctrl+E`. SVG map, every callout's text readable without clicking, each
  one's speaking window shaded back along the centreline from its point, and the
  engine's own start drawn dashed inside it — the two differ wherever speed is
  changing, which is §7.4's constant-speed problem made visible instead of
  inferred. Double-click a label to edit in place, drag a point to move it, nudge
  by metres, or snap it to the measured braking point. Overlaps are flagged, and
  a suggested `leadAdjustS` correcting the engine's approximation is one click.
  Editing text marks the note dirty and greys its window, because the duration it
  was drawn from belongs to the old words.
- [x] Re-render audio from the editor
  A button, and File > Render Audio (`Cmd/Ctrl+Shift+R`). Saves first — rendering
  reads the note set from disk, so unsaved words would be rendered as the old
  ones — then redraws every speaking window from the new durations, which is the
  point: you see what a longer sentence costs in track.
  Stage 6 moved to `packages/tts` to make this possible without the app depending
  on `services/ingest`. §10's "never bundled into the app" is about stages 0-5:
  no LLM in the client, no service-role key in a zip anyone can open. Stage 6 is
  a local binary with no network and no credential, and it already served both
  the pipeline and hand-authoring.
- [x] Stage 6: TTS for both `text` and `textShort`, measured durations
  Done early, out of order, because the hand-authored note sets of M2 needed it
  too — a note set with no audio cannot speak. `exxeed-ingest render <noteSetId>`,
  Piper, durations read from the WAV header rather than estimated, and each note's
  `dirty` flag cleared because text and audio now agree.
  *Done when:* a YouTube URL for a track guide produces a reviewed, rendered note set the runtime can load.

## M6 — Packaging

- [ ] Windows installer
  Note that `app.isPackaged` is what decides whether debug is on, so packaging is
  also the first time the off-by-default path gets exercised for real.
- [ ] First-run flow including the borderless-windowed warning
  Put it in first-run, not the FAQ. It is the number one support question for every overlay app in existence.
  Half-done: preferences opens by itself when no note set is chosen, and the
  warning prints at launch. Neither is a first-run *flow*, and the warning is on
  stdout where no packaged user will ever see it.
- [x] Note-set picker UI
  The preferences window (`Cmd/Ctrl+,`), with note set, voice, lead adjust,
  reference car and which overlays to show. Replaced twelve environment variables,
  which were a scripting interface being used as a product. The env vars still
  work as start-up overrides because the scripts here lean on them, and the window
  says which fields are being overridden.
- [x] Overlay layout editor
  Unlock, drag, lock, remembered per panel. What is still missing is resizing —
  panels are fixed-size, which is fine for a delta bar and limiting for the trace.
- [ ] Resize overlays, not just move them

## Open questions (§13)

- [x] ~~**Landmark inventory bootstrap.**~~ **Settled: not needed yet.**
  A landmark reference in the *words* is just a string — "brake at the black seam"
  needs no `Landmark` record. The inventory is machinery for §10 stage 3, so it is
  an M5 question, not an M1 one. Daytona's notes name real markers from a track
  guide with no inventory anywhere. A marking tool becomes worth building when the
  model needs a closed vocabulary, and not before.
- [ ] **Car class taxonomy.** Need a car-ID → class mapping table, and a granularity decision (GT3 vs GT3-by-manufacturer).
  Now has a second consumer: the preferences window picks a reference lap by car
  id, and a note set names a car *class*. With one car and one track that gap is
  invisible; it will not stay that way.
- [ ] **Reference lap source.** Live SDK recording for v1; `.ibt` and `.blap`/`.olap` import deferred.
- [ ] Cheap first step on `.blap`: hex-dump a lap whose time you know, look for that time as a float, check whether file size scales with track length in a way that implies per-sample records. An hour of work tells you whether it's tractable at all.
- [x] ~~**Voice provider.**~~ **Settled: Piper**, `en_US-lessac-medium`.
  See M2. Cost did not decide it — the whole v1 corpus is ~126k characters, which
  fits inside most providers' free tiers — so quality is the only thing that would
  ever justify moving, and `TtsEngine` keeps that a one-file change.
- [ ] **CrewChief landmark corpus.** Worth an email to Jim Britton about reuse. A shortcut, not a dependency — don't block on it.
