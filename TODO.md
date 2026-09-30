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
- [x] One car identity (§13 Q2)
  There were three and no mapping between any of them: the sim's slug
  (`"mx5-mx52016"`), a hand-typed integer on `ReferenceLap`, and a free-text
  `carClass` on `NoteSet`. Reference laps and `baselineCarId` now key by the sim's
  slug, so the car being driven finds its own lap with no lookup; the integer came
  from `--car-id` and had no authority behind it. `data/cars/{sim}.json` is all
  that is left — slug to class — and it makes §13's granularity question data
  rather than code.

  **Two things this made possible that were not before.** `listForTrack`'s
  `carClass` filter had no caller outside its own tests, so an MX-5 note set
  loaded in a GT3 was silent; and `session.ts` picked the reference lap from a
  preference or "whatever lap is first on disk", so with exactly one lap for the
  wrong car the ghost trace and delta bar compared against it with no warning.

  **The check had to move after connect.** The session is pinned up front (§4.5),
  but the sim only reports the track and car on connect — so `carWarnings` runs as
  a second pass in the telemetry loop rather than inside `loadSession`. It warns
  and still runs, and reports an unknown car as unknown rather than as a mismatch,
  because a warning that fires for every car nobody has added yet stops being read.

  Migrated: `67.json` is now `mx5-mx52016.json`, and the map's `baselineCarId`
  with it. The `carId` preference and `EXXEED_CAR` are strings now.
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
  **The two slip-road notes are the weak point, and the short forms are now
  actively misleading.** T6 and T7 brake at a slip road that is on the *opposite*
  side to the turn each time — T6 is a right taken off the left-hand road, T7 a
  left off the right-hand one. The full text carries a turn number so it is clear,
  but `textShort` is "Left slip road" and "Right slip road", which name a side
  that contradicts the direction of travel. That fallback should probably be
  "Turn six" / "Turn seven" — it identifies the corner and cannot be misread as a
  direction. Low stakes at Daytona, where 11-33 s between callouts means the short
  form realistically never fires, but wrong in a way that will not stay harmless
  on a tighter track. This is the pair to listen to first on track.

- [ ] Check in a multi-lap slice of the Daytona session as an engine fixture
  `data/reference/daytona-2011-road-mx5-lap.ndjson` is one extracted lap, so §6.4
  suppresses every one of its 4,364 frames as `out_lap` and the engine says
  nothing: replaying it gives `0 spoken, 0 dropped`. Fine as a track-map source,
  useless as a callout timeline — which is why the golden file still runs on the
  synthetic 3-lap toy and the engine has no real-telemetry regression. Two or
  three laps from `2026-08-27T20-43-48-649Z.ndjson` would close it. That file is
  in `data/recordings/daytona-2011-road/` on this machine, and `splitLaps`
  (packages/telemetry/src/laps.ts) now does the cutting — this is an hour, not a
  project.
- [ ] Recording rate is 32 Hz, not the 60 Hz the adapter asks for
  Median frame gap 31 ms against a requested 16.7 ms — 1.7 m between samples at
  56 m/s rather than 0.9 m. Harmless today (well inside §6.5's 15 m threshold, and
  the scheduler's fit tolerance scales with the tick) but the code says 60 and
  reality says half that. Seen again at Snetterton: ~4,400 frames for a 137 s lap.

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

- [x] Cut the map automatically from the first clean lap
  Recording was always on for an unmapped track, but nothing turned a recording
  into a map — eleven laps at Snetterton and no map, and nothing said why. Now the
  first clean lap (from the line, never on pit road, off track or towed; laps.ts)
  becomes the map and reference lap mid-session, through the same builder, which
  moved to `packages/telemetry/src/map-build.ts`. A faster clean lap in the same
  session replaces the reference against the existing corners; a map is never
  re-cut. The map and reference now reach the overlays without a note set.
  Snetterton: 4 of 11 laps clean, 11 corners, 4,735 m.

**M1 is done.** `pnpm --filter @exxeed/trackmap start data/reference/daytona-2011-road-mx5-lap.ndjson
--track-id 192 --config road-course --car-id mx5-mx52016 --name "Daytona International Speedway"
--config-name "Road Course" --overrides data/tracks/iracing/192/road-course/corners.override.json
--svg map.svg` produces
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

- [x] ~~Move video ingest out into a separate CLI tool~~ — **reversed: it is in the app**
  File > Import From YouTube (`Ctrl+I`). This week's official races (iRacing's
  public schedule PDF, no login) or the live session fill in track and car; yt-dlp
  searches and fetches captions; one prompt converts the transcript, sent to
  Claude / OpenAI / Gemini / an OpenAI-compatible server on the author's key, or
  copied into any chat and pasted back. `{ turn, text }` is still the whole
  contract and `resolveProfile` still does the placing. See SPEC §10's note. The
  reasoning below is kept because the contract, the numbering prerequisite and
  the ordering fallback all still apply.

  *Original plan:*
  Stages 0–3 leave this project. The helper takes a video, playlist or channel
  link and emits one or more importable profiles; Exxeed gains an import path and
  never talks to YouTube. Scan a playlist and you get a backlog of track/car
  combos to refine later, so ingest stops being blocked on having driven the track.

  **The split is what makes it shippable.** Fetching third-party transcripts is
  the sticking point: `captions.download` only works for videos you own, and
  auto-generated captions are not exposed through the Data API at all, so every
  working tool (`yt-dlp --write-auto-subs`, `youtube-transcript-api`) uses the
  internal `timedtext` endpoint, against YouTube's ToS. As a separate, optional
  developer tool that is a property of the helper, not of the product — the app
  imports a file and has no opinion about where it came from. The metadata half is
  clean and free regardless: `playlistItems.list` is one quota unit per fifty
  videos against 10,000 a day, and at §10's numbers a 500-video channel costs
  under a dollar to extract.

  **The contract is `{ turn, text }`, and that is the whole of it.** The helper
  never resolves a position and never needs telemetry — it maps each callout to a
  turn number, which is a thing a transcript can actually support. Exxeed already
  knows how to turn that into a `pct`: it has the corner list and the reference
  lap's measured brake onsets, which is exactly how the Daytona notes were
  anchored. A callout may cover a *range* — the Daytona set is five notes over
  twelve turns, so "turns 9 to 11" and "turns 1 to 2" both have to be expressible.

  **This only works if our corner numbering matches the convention coaches use.**
  A guide says "turn four" meaning the conventional fourth, and if detection emits
  only the corners it found, our indices mean something else and every mapping is
  silently off by however many corners were missed. `corners.override.json` is
  what keeps them aligned — Daytona is done and verified against this transcript
  (T4, T5 and T6 all land where the coach says), but it is a per-track
  prerequisite for import, not a one-off.

  **Ordering is the fallback when the words are not explicit.** This guide names
  turns out loud on the breakdown lap, so the mapping is read straight off the
  text; the hot lap is pure deixis and would need ordering instead. A guide
  narrates corners in lap order, so the third braking instruction is the third
  braking event — and braking events fall out of a reference lap with a threshold
  and a loop (six at Daytona). Aligning those two sequences assigns corners with no
  landmark understanding at all. It is the cheapest and strongest signal available,
  it is free at extraction time, and it cannot be recovered afterwards.

  **Emit a pool, not a note set per video.** Agreement across sources is the
  quality signal one video cannot give. The Daytona transcript showed it in
  miniature: its hot lap and breakdown lap agreed on the brake percentage at T4,
  T6 and T7 and differed by 5% at T1. Its chicane advice — "a little bit more
  brake to get through the second apex" — is contradicted by the reference lap,
  which brakes once and never returns. With one video there is no telling whether
  the coach or the reference driver is the outlier. With five there is.

  Stage 6 (render) stays here: it needs Piper and it serves hand-authored sets
  too. Stages 4 and 5 — telemetry cross-check and the note editor — are already
  Exxeed's, and they become the import review step.
- [x] ~~§10's "cap `text` at 8 words"~~ — **removed**
  The only hand-authored set runs 11-19 words and 3.4-5.0 s a callout, because
  the transcript carries a braking landmark *and* an aim point *and* a throttle
  reference per corner, and the timing has room for all three: 11-33 s between
  callouts and nothing drops. The cap was never the binding constraint. Time is,
  and it is enforced twice already — §6.3 refuses a callout that will not finish
  before its point, and §7.4 draws the arc so the cost of another word is visible.
  A word count is a guess at that; neither of those is.

- [x] ~~Stages 0–2: normalise, metadata, triage funnel~~ — **superseded by a person choosing**
  The funnel existed to process submissions nobody looked at. In the importer a
  driver picks the video from search results while watching it, which is a better
  triage than a Flash-Lite call on 500 words. The only filter left that matters —
  "has captions at all" — is the transcript fetch failing with a reason.
- [x] Stage 3: extraction with the corner list passed **as enums**
  §12: never let the LLM free-text a corner reference. Enum or null.
  Two things changed under this. The corner index is now a stage-3 *output only* —
  the pipeline resolves it to a `pct` before writing the note (§4.4), so nothing
  downstream carries it. And the landmark inventory is optional: a landmark
  reference in the words is just a string, so the enum is worth having to stop the
  model inventing a bridge that is not there, not because the runtime needs one.
  The prompt also has to say **one note per corner** — the model will happily emit
  an approach, an apex and an exit note for the same corner, which is three lines
  where a driver can use one.
  Done in `packages/importer/src/prompt.ts`: the map's corners are listed as the
  only valid turns, one callout per turn with ranges via `throughTurn`, rewrite
  don't echo, `textShort` 2–4 words, confidence and `sourceTs` per callout. The
  reply parser drops any turn not in the map and says so. **Not yet run against a
  real model end to end** — only the paste path has been exercised in the app.
- [ ] Stage 4: cross-check against reference lap telemetry
  The next thing worth building here. The importer places a callout at the turn's
  entry; the reference lap knows where braking actually starts. Flag a callout
  whose words say "brake" but whose turn has no brake onset, or whose landmark
  distance disagrees with the onset by more than §10's 40 m — shown in the
  importer's callout list before import, not after.
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
  **Every step now exists** — search, transcript, convert, import, edit, render —
  and a Snetterton set has been imported through it. Not yet rendered or driven,
  so not ticked.
- [x] ~~Snetterton's `corners.override.json`~~ — **replaced: the app learns the numbering**
  Nobody writes a numbering file any more. The prompt describes every corner the
  way a driver meets it — position on the lap, direction, tightness, where the
  reference lap brakes, minimum speed, gear — and says our numbers may not be the
  official ones, so the model matches by description. It also returns the number
  the coach said, and the app keeps the consistent ones in
  `tracks/.../turn-numbers.json` (in lap order, one number per corner, earlier
  knowledge wins); later prompts and the importer show "official T8". Not learned
  from a guide the model flags as a different layout — the first Snetterton guide
  tried was for the 200, and its numbers would have been wrong for the 300.
  `corners.override.json` still exists for merging and splitting detected corners;
  it is no longer how numbering gets fixed.
- [x] Render on import
  Import renders the set straight away, installing Piper and a voice first if
  either is missing, so an imported set is ready to drive with no trip to
  Preferences. Found two real bugs doing it: the downloader corrupted files at the
  right size (a progress listener beside the pipe — Piper's zip was unreadable),
  and Piper's unzip used whatever `tar` was on PATH, which from Git Bash is GNU
  tar and cannot take a Windows drive path.

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
- [x] Resize overlays, not just move them
  Overlays are `resizable` with OS-level hit-testing on the border, and the size is
  remembered per panel along with the position.

## M7 — Race summary

A screen after the chequered flag: the result, the iRating and Safety Rating
change with an animation, where the time went, and how this race compares to
others in the same combo. **Everything except the rating change is local.** The
result is in the session YAML, the time loss is in the recording (§9), and the
comparisons are a query over races already driven. Only the ratings need the web.

The order below is the order of dependency. Each step ships something usable on
its own, and the web API comes last because its auth is the slowest part.

**Step 1 — Result from the SDK**

- [ ] Read `Sessions[n].ResultsPositions` from the session YAML into `race.ts`
  Position, class position, laps, laps led, fastest lap, incidents, reason out,
  for every car. It updates live and is final at the flag. Same rule as the rest
  of `race.ts`: a snapshot a source MAY offer, absent on replay.
- [ ] Watch `Sessions[n].ResultsOfficial` go 0 → 1
  That is "the report is ready", as far as the sim can tell us. Only visible while
  the driver is still in the session, so nothing may depend on seeing it.
- [ ] Capture `WeekendInfo.SubSessionID` at connect
  It is the key for the Data API in step 4 and costs nothing to keep. Without it,
  a race cannot be looked up afterwards.
- [ ] Detect the end of a race session
  Chequered flag or session state, race sessions only — practice and qualifying
  get no summary screen, or a lighter one.
- [ ] Session YAML fixture with results in it
  A replay has no race snapshot (§7), so the results path needs its own checked-in
  YAML, taken at the flag and again after `ResultsOfficial`, to test against.

**Step 2 — The race summary record**

- [ ] `RaceSummary` schema (Zod, §4 style)
  `subsessionId`, `TrackKey`, `carId`, date, session type, field size and SOF,
  finishing and class position, incidents, per-lap times with a clean/dirty flag
  (pit, off track, yellow), per-corner segment times, and the iRating/SR deltas as
  optional until step 4 fills them. **This record is what makes every comparison
  cheap.** Without it, "since forever" means re-parsing every old recording.
- [ ] `RaceSummaryRepository` + `LocalFile*` implementation (§8)
  Keyed by `TrackKey` + `carId`, like `ReferenceLap`, because a comparison across
  map revisions still has to work. `listForCombo(trackKey, carId, since?)` is the
  query everything in step 5 needs.
- [ ] Write the record when a race ends, and link it to its recording
  The recording path goes in the record, so a summary can always be recomputed
  if the segment maths changes.
- [ ] Backfill from existing recordings
  A tool that builds summaries from `data/recordings/` so history does not start
  at zero. Recordings have no result, so these are laps and segments only.

**Step 3 — The results screen**

- [ ] Summary window, opened automatically at the end of a race
  Its own window, not an overlay: it is read after the race, not glanced at during
  it. Dismissable, and reopenable from a menu for the last race.
- [ ] Result block: position, class position, positions gained, incidents, best lap
- [ ] Lap chart: every lap time, clean laps distinguished, best lap marked
- [ ] Placeholder for the rating change
  Shows the local estimate (step 4) or "waiting for official results", so the
  screen is complete without the web and fills in when it arrives.

**Step 4 — iRating and Safety Rating**

- [ ] Local iRating estimate from the field
  The SDK has every driver's iRating, so the community-known formula gives a
  number at the flag. Shown as an estimate and replaced by the official number.
  No offline SR estimate — it is not derivable usefully from what the SDK gives.
- [ ] Register an OAuth client with iRacing
  Legacy email+hashed-password auth is gone; the Data API is OAuth2 only, and one
  report says iRacing has paused issuing new client ids — check before building.
  This is the one place in the app a login is genuinely needed: this week's
  schedule turned out to be public (the season PDF), results and ratings are not.
- [ ] Sign-in flow in preferences, token stored with `safeStorage`
  Optional: everything else on the screen must work signed out.
- [ ] `results/get?subsession_id=…` client
  Two-step: the response is a JSON with a `link` to a signed S3 URL, and the data
  is behind that. Poll after the race ends until it appears (usually a minute or
  two), respecting the `x-ratelimit-*` headers, and give up quietly.
- [ ] Fill the deltas into the `RaceSummary`
  `newi_rating − oldi_rating`, `new_sub_level − old_sub_level`, license class
  before and after.
- [ ] The animation
  iRating counter rolls from old to new; the SR bar fills or drains; a
  license-promotion moment when a threshold is crossed. The estimate-to-official
  settle is itself part of it.

**Step 5 — Where the time went**

- [ ] Segment each lap at corner boundaries
  From the corner list the map already has, via the §4.6 pct helpers — never raw
  subtraction, and the segment spanning S/F is the one to test first.
- [ ] Time lost per corner, ranked
  Against the race's own best lap, and against the `ReferenceLap` when there is
  one. Average and worst, so one mistake does not read as a habit.
- [ ] Say *why*, where the channels support it
  Brake onset against the reference's `brakeOnsetPct` (§5.1 — the same function,
  or the comparison drifts), minimum speed, throttle-on. "Turn 7: −0.31 s, braking
  12 m early" is the line worth building toward.
- [ ] Theoretical best: stitched best segments against the actual best lap
- [ ] Consistency: spread of clean lap times

**Step 6 — Compared with other races**

- [ ] This race against this week's and all-time in the same combo
  Best lap, average clean lap, finishing position, incidents, iRating trend.
- [ ] Most improved and most regressed corner
  Per-corner segment times against the previous races in the combo. The
  improvement is the dopamine; the regression is the useful half.
- [ ] Rating history chart per combo, once step 4 has filled enough records

*Done when:* finishing a race at Daytona opens a summary with the official
result, the real iRating and SR change, the three corners costing the most time,
and how it compares to the last race in the same car.

## M8 — Community packs (Supabase)

People sign in, make their own callout packs, publish them, and browse and
install everyone else's. The catalog of sims, tracks, layouts and cars lives in
the database, and so do the track maps, so a pack installed on a new machine has
a map to draw on. That is the Snetterton problem: the note set was committed, but
its map was gitignored and stayed on the rig that cut it.

**Most of the shape already exists.** §8's repositories were built to be swapped
for Supabase ones as a DI change. Every key already carries `sim`, which is
currently the literal `"iracing"`. §8.1 has a first draft of the schema, and Auth
and Storage were in the §3 stack table from the start. What is new is that packs
are user-made and public, rather than authored by us under the service role.

**A pack** is a published note set, plus what it needs to work and be trusted:
the map version and reference lap it was authored against, the voice it was
rendered with, optional setups, and an author. Audio is *not* in the pack by
default. It renders locally on install with the pack's voice, the same way import
already does (`auto-render.ts`). Measured at Daytona, audio is about 250 KB per
note as WAV against about 1 KB of JSON, so it would be almost all the storage and
bandwidth. Piper with `--noise-scale 0` and a named voice model makes the render
the same on every machine.

Sizes, measured on Daytona, gzipped: note set 1.1 KB, map 41 KB, reference lap
62 KB. So a few hundred tracks of maps plus every pack anyone writes fit in the
free tier. Audio is the only thing that would not.

**Step 0 — Decisions and the schema**

- [x] Bring §8.1 up to date before writing a migration
  The draft predates four changes. Note sets are keyed by `TrackKey`, not
  `TrackRef`, because they hold lap positions, not corner indices (§4.4), so
  `map_version` comes off `note_sets`. Car ids are the sim's slug
  (`mx5-mx52016`), not an int. A map is ~100 KB, not "a few KB". And a
  reference lap is a JSON document today, not a `Float32Array`: decide whether
  the binary blob is still worth it at 62 KB gzipped (probably not yet).
- [ ] Widen `SimSchema` from the literal to an enum, and a `sims` table
  `iracing` is the only member, but the column and the enum exist from the first
  migration. Adding a sim later then means a row and an adapter, not a
  migration that rekeys every table. Things that are per-sim: track and car ids,
  the setup file format, and whether a map can be cut from telemetry at all.
- [x] Catalog tables: `sims`, `track_layouts`, `cars`, `car_classes` — no separate `tracks`: iRacing gives each layout its own id
  `track_layouts` is what `TrackKey` points at (`sim, track_id, config_id`),
  with display names, length, and turn numbering (`turn-numbers.json` moves
  here). `cars` is keyed by `(sim, car_id)` with a class. This replaces
  `data/cars/iracing.json`, and §13's granularity question gets settled in
  data. Read-only to clients.
- [x] Content tables: `track_maps`, `reference_laps`, `content_items`, `content_versions`, `content_drafts`, `content_media`, `content_setups`, `stars`, `downloads`, `reports`
  `packs` is the identity (owner, track layout, car class, title, description,
  visibility). `pack_versions` holds the immutable published note sets, each with
  the map version, reference lap and voice id it was authored against. Installing
  pins a version, and an update is a new version, never an edit under someone who
  is driving it. Drafts are a `pack_versions` row that is not published.
  Columns for Step 3b: `(pack_id, version)` unique, `changelog`, `published_at`,
  `withdrawn_at`, and `based_on` (pack version) for forks. `installs` records
  `(user, pack, version, policy)`.
- [x] Row Level Security on in the first migration, per §8.1
  Published versions are readable by anyone, including signed-out users.
  Drafts are readable and writable only by the owner. The catalog is read-only.
  Maps and reference laps are insertable by any signed-in user and never updatable
  (see Step 2). Write the policy tests alongside the policies: a draft invisible
  to another user and to the anon key, and a published version the owner cannot
  mutate.
- [x] `supabase/` in the repo: migrations, seed, and `supabase start` for local dev
  Generated types go to `packages/repo/src/db.generated.ts` and stay inside
  `packages/repo` (§8.1). Develop against the local stack, and treat the hosted
  project as a deploy target.
- [x] Settle the data directory before there is anything to sync into it
  `resolveDataDir` defaults to the repo's `data/`, which is right for development
  and wrong for a packaged app. Installed packs, cached maps and rendered audio go
  under `userData`. The repo's `data/` stays as the dev fixture set.

**Step 1 — Sign in**

- [ ] Supabase Auth in the Electron app: Discord and Google OAuth, plus an email code
  Built (`apps/desktop/src/account.ts`). OAuth uses PKCE through the system
  browser, back to a one-shot loopback listener on `127.0.0.1:53682`, not a
  custom protocol: no registry entry, and it works in dev on both OSes. Email
  is a 6-digit code typed into the app, not a magic link, because a link opened
  on a phone cannot reach the PC. The email path is verified end to end on the
  local stack. Discord verified end to end locally.
  **Open, before launch: custom SMTP.** A hosted project without its own SMTP
  sends only to members of the Supabase organisation, and cannot use custom
  templates, so the code template is local-only for now. The app also listens
  for the email's link, so email sign-in works when the link is clicked on the
  same PC. With SMTP (e.g. Resend on a verified blkpixel.com sender), put
  `supabase/templates/sign-in-code.html` into the hosted "Magic Link" and
  "Confirm signup" templates, and the code path works for everyone.
- [x] Session in main, refresh token stored with `safeStorage`
  Same rule as the importer's API keys: the renderer never holds a secret, and it
  asks main. The anon key ships in the app, and the service role key never does
  (§8.1).
- [x] `profiles` table: display name and avatar, created on first sign-in
  The author name shown on a pack. Nothing else about a person is public.
- [x] Top-right of the control window: "Sign in", or the avatar with a menu (profile, sign out)
  Everything works signed out except publishing, starring and syncing your own
  drafts. Browsing and installing public packs must not need an account.

**Step 2 — Catalog and maps in the database**

This step has value on its own, before anything is shared: it fixes maps living
on one machine.

- [ ] Seed the catalog
  iRacing's Data API has every track, layout and car with ids (`track/get`,
  `car/get`), but it needs the OAuth client that M7 step 4 is already blocked on.
  Until then, add rows as they are seen: on connect the sim reports `TrackID`,
  layout, `CarPath` and display names, and a `report_session` RPC
  inserts-if-absent. Enough to cover every combo anyone actually drives, and the
  Data API backfills the rest later. The schedule PDF can add names, but it
  carries no ids.
  **Half done:** `report_session` runs on connect when signed in. The Data API
  backfill waits on the iRacing OAuth client.
- [x] Publish a map the first time anyone cuts one
  `AutoMapper` already cuts a map from the first clean lap. Signed in, it also
  uploads it if the layout has none. The first map wins and is not replaced by
  later ones: a note set's positions are pct, which is physical tarmac (§4.4), so
  any good map serves every pack. But the corner list and numbering are what
  everyone authors against, and they should not churn. Replacing a bad map is a
  new `map_version`, and that is a moderation action, not an automatic one.
  Refuse to publish a map whose orientation check came in under the threshold
  (§4.1.1): a mirrored map shipped to everyone is worse than none.
- [x] Reference laps per layout and car, contributed the same way
  One public reference lap per combo, for the editor's speaking windows and the
  trace overlay's ghost. The first one, or a faster clean one, replaces it. A
  driver's own laps stay local.
- [x] ~~`Supabase*` repositories wrapping the `LocalFile*` ones~~ — **a sync service instead** (`packages/repo/src/cloud/sync.ts`, `apps/desktop/src/cloud-sync.ts`)
  Local files stay the runtime's source of truth; the sync pulls a missing map
  and reference laps before a session and when the editor opens a set without
  one, pushes what the auto-mapper cuts, and offers every local map once per
  sign-in. Artefacts only move through `packages/repo`; the one other place
  that talks to Supabase is `account.ts`, for auth and the profile.
- [x] Then commit nothing under `data/tracks` or `data/reflaps` for real use
  They stay gitignored, as dev fixtures only. The database is where a map lives.

**Step 3 — Making and publishing your own packs**

- [ ] Every note set gets an owner and a remote id
  A local slug id (`daytona-mx5-draft`) stays the file name. A `remoteId`
  (uuid) and `version` get added to `NoteSet`, absent until published. Existing
  sets and imports keep working unpublished.
- [ ] Publish from the control window and the editor
  Title, description, car class, visibility (public or unlisted). Refuse a set
  with a `dirty` note, as §7.4 already refuses to call one `published`: someone
  installing it would hear callouts timed against audio that does not match the
  words. Publishing uploads the note set as a new `pack_versions` row, pinned
  to the map and reference versions it was written against.
- [ ] Sync drafts across your own machines
  A draft is a private row. Signed in, the editor saves locally and pushes. On
  conflict, the later save wins, with the other kept as a copy, not merged:
  there is one author per pack.
- [ ] Imports record their source
  `source.videoId`/`channel` already exist. A published pack made from a
  YouTube guide says so and links to it. The words are rewritten, not
  transcribed (§10), but the coach should still get the credit.

**Step 3b — Versions**

A pack gets better as its author drives it: a braking point moves 20 m, a line
gets shorter, a corner that turned out to be easy loses its callout. Versions are
how those improvements reach the people who installed it without anyone losing
the version they already know.

- [ ] Versions are numbered 1, 2, 3, … per pack, immutable once published
  A plain counter, not semver. There is no API to break, and "v4" is what a
  driver can remember and repeat on Discord. A published version is never
  edited, only superseded. The row, its note set, its setups, and the map and
  reference versions it was written against are fixed forever, so "I'm on v3"
  always means the same callouts.
- [ ] The draft is a working copy on top of the latest published version
  "Edit" on a published pack opens the draft. "Publish update" turns it into the
  next version, and the draft carries on from there. Publishing still refuses a
  `dirty` note (Step 3). Only one draft per pack, because there is one author.
- [ ] A changelog per version: the author's one line, plus a diff the app writes itself
  Note ids are opaque handles that survive a move and a rewrite
  (`note-id.ts`), so two versions diff exactly by id, with no guessing. Each
  note is added, removed, reworded, or moved by N m. The author writes "moved T1
  braking later, shortened the chicane"; the app lists the rest. Both are shown on
  the pack page and in the update prompt.
- [ ] Updating re-renders only what changed
  Audio is cached by `(note id, text hash, voice)`, not by pack version, so a
  version that moves three notes and rewords one renders one clip, not the whole
  set. Moved notes keep their audio: position does not change what is said
  (§7.4's "moving a note does not make it stale").
- [ ] Per-pack update policy for installers: automatic (default) or pinned
  Automatic takes a new version when no session is running (§4.5: a session
  is pinned up front). Pinned stays put and shows "v5 available". Either way,
  every version stays installable, so going back to v3 is one click, and v3 is
  still there to go back to, because versions are immutable.
- [ ] The author can withdraw a version
  For a version that is actually wrong, such as a callout at the wrong corner.
  Withdrawn versions are hidden from new installs and never auto-installed.
  Anyone on one gets "the author withdrew this version" and an offer to
  move to the latest. Not deleted, so a pinned install keeps working offline.
- [ ] Setups are versioned with the pack
  A version lists its setup files. An unchanged file is stored once, by content
  hash, and referenced from each version that has it. A new setup for a new
  season is a new version, like a callout change.
- [ ] A new version may target a newer map version
  A pack's positions are pct, which holds across map re-cuts (§4.4), so this is
  normally just a matter of recording what the author was looking at. It matters
  when turn numbers were renumbered between map versions: the pack page shows
  numbers from the map version the pack was written against.
- [ ] Forks remember the version they came from
  "Based on <pack> v3." When the original publishes v4, the fork's author gets
  "upstream has v4" with the same diff, and can pull individual changes by note
  id. That is not merging: each note is either kept or taken.
- [ ] Stars belong to the pack, downloads to the version
  A star is "I rate this author's work on this track", the way a GitHub star is
  about a repo and not a commit, so it carries across versions. Downloads are
  counted per version and summed for the pack, so the author can see how many
  people are still on v2.

**Step 4 — My packs (the Track Coach tab)**

- [ ] Split the list: "Mine" and "Installed"
  Mine: drafts and published, with version, stars and downloads. Installed: other
  people's packs, the version pinned, "update available" when there is a newer
  one. The per-track rows from this session (a mapped track with no notes, with
  Import… and Write manually) stay.
- [ ] Install renders locally, with the pack's voice
  Piper and the voice model download on first use, as import already does. Clips
  are cached per `(pack version, voice)`. If the pack's voice is unavailable, fall
  back to the user's voice with a note that timing may differ slightly: durations
  are re-measured anyway, so it is correct, just not identical.
- [ ] Update, roll back, uninstall
  Following Step 3b's policy. An update installs the new version beside the old
  one and switches only when not in a session: changing callouts mid-stint would
  break §4.5's rule about pinning a session up front. The installed row shows the
  version, "v5 available" with its changelog, and a version picker for going
  back.
- [ ] "Follow the sim" picks among installed packs too
  `noteSetByTrack` already remembers the last set per track. Installed packs join
  that pool, filtered by the car class actually being driven (`carWarnings`
  already knows it).

**Step 5 — Content (new tab)**

Named for what sim racers already call it: Assetto Corsa's Content Manager made
"content" the word for things other people made that you install. This tab is
everyone else's packs. Your own and the ones you installed stay in Track Coach
(Step 4).

- [ ] Filter by sim, track, layout and car or class, pre-set to the current session's combo
  The question someone opens this tab with is "what is there for what I am
  about to drive". A pack names a car *class*, so filtering by a car shows
  packs for its class, labelled as such. Also this week's official races (the
  schedule is already fetched for the importer), for tracks not driven yet.
- [ ] The filters live in the tab's state, so anything can open it pre-filtered
  One entry point, `openContent({ sim, trackId, configId, carClass })`, used
  by the quick link below, share links, and the Track Coach rows. It is the
  same shape as the importer's preset from this session's "Import…" button.
- [ ] Quick link when you are on a combo you have no callouts for
  At connect the session already knows track, layout and car, and
  `noteSetForTrack` already knows there is no installed pack for them. Instead
  of starting silent, the control window shows "No callouts for Snetterton 300
  in the MX-5. 4 packs in Content", linking to the tab with those filters set.
  The count is one cheap `count(*)` query, and the line is left out offline or
  when the count is zero. With zero it is "Nothing yet. Write the first one",
  pointing at Import… and Write manually. The mapped-track rows in Track Coach
  get the same "Find in Content" button beside Import… and Write manually.
- [ ] Stars, like GitHub
  A star button on every pack card, on the pack detail, and on installed packs in
  Track Coach, with the count beside it. Signed in only, one per user per pack,
  and toggling it off un-stars. A "Starred" filter in Content lists yours.
  Stored as `pack_stars (user_id, pack_id, created_at)`, primary key on the
  pair, insert and delete limited to your own rows by RLS.
- [ ] Downloads, counted by the server rather than trusted from the client
  One row per install in `pack_downloads (pack_version_id, installation_id,
  user_id?, created_at)`, unique per installation and version, so reinstalling
  or updating in a loop cannot inflate it. `installation_id` is a random uuid
  made on first run and kept in settings, so signed-out installs count too
  (Step 1 says browsing and installing need no account). Recorded through an
  RPC. Clients never write counters.
- [ ] Counters on `packs`, maintained by triggers, indexed for sorting
  `star_count` and `download_count` are updated by triggers on the two tables
  above, and are not client-writable (RLS denies the columns), so the Content
  list sorts on an index instead of counting rows per request. The rows stay the
  source of truth; a nightly job re-derives the counters if a trigger ever
  misses.
- [ ] Sort by most stars (default), most downloads, recently updated, and newest; text search
  "Most stars" is the popularity sort people expect from GitHub. "Recently
  updated" surfaces packs whose authors are still driving the track. Postgres
  full-text search on title, description and track name is enough, with no
  search service.
- [ ] Layout like VS Code's Extensions view: a search sidebar on the left, the selected item's page on the right
  **Sidebar:** a search box at the top, the filters under it (sim, track,
  layout, car or class, kind, "Starred", "Installed"), and a sort control. Then
  the results as compact rows: icon, title, author, one-line summary, stars,
  downloads, and an Install button right on the row, so the common case needs
  no second click. The list scrolls on its own, and the page does not reload
  when the selection changes.
  **Page:** a header with the icon, title, author, version, stars, downloads
  and last updated, and the actions: Install / Update / Uninstall, Star, a
  version picker, and Share. Under it, tabs:
  - **Details**: the author's description, as Markdown with pictures (below);
  - **Callouts**: every callout's text in lap order, readable before installing;
  - **Map**: the track with every callout point on it (the editor's SVG,
    read-only), hovering a point shows its text;
  - **Changelog**: versions, the author's line and the app's diff (Step 3b);
  - **Setups**: the files, what each is for, where they will be installed.

  Beside the tabs, a narrow column of facts, as VS Code does: track and layout,
  car class, callout count, voice, source video, map version, published date,
  and the author's other content.
- [ ] The description is a README: Markdown with pictures
  Written in the publish dialog with a live preview. It is a separate field,
  not the note set, and it can change without a new version, like a store page.
  Each item also gets an icon (a square image, falling back to the track
  outline drawn from the map) and up to 8 screenshots, uploaded to Storage and
  shown in the Details tab.
- [ ] Render the Markdown safely
  Rendered in the renderer with raw HTML off and the output sanitised: a
  README is a stranger's text inside the app. Images load only from our own
  Storage bucket, enforced by the window's Content Security Policy, not just
  by the renderer. A remote image in a README is a tracking pixel that fires
  every time someone looks at the page. Links open in the browser, never in
  the app.
- [ ] Image limits, enforced by a Storage policy
  PNG, JPEG or WebP only. There is a size cap per file and a count cap per item,
  and images are re-encoded on upload (an Edge Function) so what is served has
  been decoded once by us and carries no metadata. That strips the GPS
  coordinates in a phone photo of someone's rig. Themes get their rendered
  preview (M9 Step 3) as the first screenshot automatically.
- [ ] Preview a callout before installing
  One clip rendered on demand, so "is this any good" does not need a full
  install.
- [ ] Share link: `exxeed://pack/<id>`, falling back to a web page
  Opens the app on the pack's detail in Content. The web fallback is a static
  page built from the same row, for someone who does not have the app yet.

**Step 6 — Setups in a pack**

- [ ] `pack_setups`: files in a Storage bucket, with car and optional track
  iRacing setups are `.sto` files under `Documents/iRacing/setups/<car>/`. A
  pack can carry several (race, qualifying, wet), each labelled. Install copies
  them into that folder under a subfolder named for the pack, so they show up
  in the sim's garage without touching anyone's own setups. Keyed per sim,
  because the format and the folder are both iRacing's.
- [ ] Size limit and type check on upload
  A `.sto` is a few KB, so anything large is not a setup. Storage policy: owner
  write, public read of published versions only.
- [ ] Rights attestation, and a report button
  Setup shops sell theirs, and a paid setup re-shared is the most likely
  takedown request this feature will ever get. The uploader confirms it is
  theirs to share, and reports go to moderation (Step 7).

**Step 7 — Trust and moderation**

- [ ] No written reviews yet
  Stars and downloads (Step 5) are the whole of the social signal for now.
  Reviews are a moderation surface, and there is nobody to moderate them.
- [ ] Report a pack, a map or a setup; an `admin` role that can unlist and replace
  RLS gives admins what the service role would, without shipping the service
  role. A bad map needs the most care: a new map version is published, and packs
  written against the old one keep working because they hold pct, not corner
  indices.
- [ ] Fork
  "Make my own copy" of a public pack starts a draft that credits the
  original. It is the natural way to fix one callout in someone else's set,
  which is otherwise the gap M4's "revisit if the duplication hurts" was
  about.

*Done when:* someone who has never driven Snetterton signs in on a fresh install,
follows the "4 packs in Content" link, stars and installs the most-starred one,
and hears it on their first lap, with the map drawn and the setup in their
garage. Meanwhile the
author of that pack published it from a different machine than the one they
drove it on. When the author publishes v2 with one braking point moved, the
installer gets it before their next session with a one-line changelog and one
clip re-rendered, and can go back to v1 if they preferred it.

Open questions for this milestone:

- **Map disagreements.** Two people cut the same layout and get different corner
  lists, because detection varies by lap (§5.2: T1/T2 at Daytona merge or split
  by 1 m). First-wins avoids churn, but the first may be the worse map. Is
  "admin replaces" enough, or do maps need votes?
- **Voice parity.** Is re-rendering with a different voice than the author's
  acceptable, or should a pack pin its voice and refuse to install without it?
  Durations are re-measured either way, so this is about sound, not timing.
- **Hosted audio later?** If a cloud voice ever replaces Piper, audio has to be
  hosted, because nobody can render it locally. Opus at ~24 kbps is about 16 KB
  per note against 250 KB as WAV, decoded to WAV on download. That keeps §12's
  no-decoding-at-trigger rule, since clips are already decoded once at session
  start.
- **Licensing of the text itself.** A pack derived from a coach's video is a
  rewrite with attribution. Is that enough, or should imports be private by
  default until the author marks them public?

## M9 — Themes

Themes like VS Code's: a theme is a file of named colors and a few shape and
type settings, picked in preferences, and publishable to Content alongside
callout packs. Four ship built in: Exxeed (the current look), iRacing, Gran
Turismo, and Synthwave. Looks modelled on other overlay apps are community
themes in Content, not built-ins.

**Why tokens-only, like VS Code, and not custom CSS.** A theme is data, not
code. A CSS file from a stranger can load remote URLs (a tracking pixel in every
overlay), hide a panel, or push text off-screen, and it breaks every time a
panel's markup changes. A fixed set of tokens cannot do any of that, can be
validated, and survives every redesign of a panel. That is exactly why VS Code
themes are JSON.

**Steps 0-2 need no backend** and can ship before M8. Step 3 is where themes
join Content.

**Step 0 — One set of tokens for everything**

- [ ] Define the token vocabulary, in `@exxeed/overlays` as a typed list with defaults
  `overlay.css` already has most of it (`--card`, `--text`, `--text-2`,
  `--green`, `--red`, `--radius`, `--font`…). Tokens are named by *role*, not by
  hue: `brake`, `throttle`, `delta-gain`, `delta-loss`, `class-1…4`, `flag-*`,
  `accent`, `warning`. A synthwave theme's brake can be hot pink, and
  `--red` would then be a lie. Three groups:
  - **surface**: backgrounds, cards, lines, text levels, accent, for both app
    windows and overlays;
  - **data**: the colors that carry meaning at speed (pedals, delta, sectors,
    shift lights, class colors, flags);
  - **shape and type**: radius, gap, card opacity, font family (from a bundled
    list), number weight, and **glow**, which synthwave needs and nothing else
    should have to fake.
- [ ] Move the app windows onto the tokens
  control, editor and preferences hard-code ~80 colors between them, and
  `importer.html` has its own separate set of variables (`--bg`, `--panel`,
  `--accent`…). One shared `theme.css` of variables, and every window uses it.
  Mechanical, but it is the bulk of this step.
- [ ] Move the canvas panels onto the tokens, read once per theme change, never per frame
  `panels/util.js` already reads colors through `token()`, but only once at load,
  and `driving.js` still hard-codes some (the shift-light ramp, the pedal
  gradients, trace grid lines). Re-read the palette on theme change and draw
  from a cached object. §7.0's rule is that nothing on the 60 Hz path queries
  the DOM.
- [ ] Live switching
  Main sends the resolved theme to every window over IPC. Each window sets
  variables on `:root` and refreshes its canvas palette. Changing theme never
  restarts the overlays: they hold decoded audio and reference arrays (the
  reason `setVisible` hides rather than closes).

**Step 1 — The theme format and the four built-ins**

- [ ] `ThemeSchema` (Zod, §4 style): `id`, `name`, `author`, `version`, `base`, `tokens`
  `base: "dark" | "light"` fills every token the theme leaves out, so a theme
  can be six lines, as in VS Code. Validation rejects anything that is not a
  color, length or listed font, so there are no `url()` and no free-form CSS
  anywhere.
- [ ] **Exxeed**, the current look (default)
  Today's `overlay.css`, which the header comment says was modelled on GO
  Fast's overlay suite: stacked near-black cards, big light numbers, pill bars,
  gradients bleeding in from the left edge. This becomes the reference theme
  that every token's default comes from.
- [ ] **iRacing**, in the style of the sim's own UI
  Flatter and squarer (small radius), more opaque panels, iRacing's blue as
  accent, a condensed sans. The point is overlays that look native beside the
  sim's own black boxes.
- [ ] **Gran Turismo**, in the style of its menus
  Light base, lots of white space, thin type, a single accent color, soft
  shadows instead of lines. It is the one light theme, which also proves `base:
  "light"` works end to end.
- [ ] **Synthwave**
  A deep purple-to-navy card gradient, magenta and cyan data colors, glow on
  numbers and bars, a grid motif on the map background.
- [ ] Built-ins may be named after games, never after other overlay products
  Naming a theme after the sim or game whose look it echoes is fine. Naming one
  after a competing overlay app is not something we ship. A theme that
  deliberately recreates another overlay suite belongs in Content as a
  community theme, published and named by its author, not in the app. That is
  also why the default is called Exxeed and not after what it was modelled on.
  Either way we bundle only fonts we are licensed to ship (OFL), so there are no
  GT or iRacing fonts, and no logos.
- [ ] Theme picker in preferences, and optionally per overlay profile
  An overlay profile can override the app theme. Someone might want iRacing
  overlays for racing and Synthwave for streaming, and profiles already exist
  for exactly that kind of split.

**Step 2 — Legibility guard rails**

A theme on an overlay is read in a glance at 250 km/h, over whatever the sim is
showing behind it. "Pretty" is not enough, so the validator warns, and publishing
(Step 3) refuses the worst cases:

- [ ] Contrast for text on cards, checked against a light *and* a dark sim backdrop
  Card opacity is part of the theme, so a transparent card over snow or sky
  needs checking against both. WCAG 4.5:1 for small text, 3:1 for the big numbers.
- [ ] Brake and throttle must stay distinguishable, including for color-blind drivers
  Checked under simulated deuteranopia and protanopia, the common ones. Red
  against green is the default, and exactly the pair that fails. A theme that
  makes them indistinguishable is refused, not warned about.
- [ ] Delta gain and loss, and sector colors, the same check
- [ ] Theme editor, JSON first, like VS Code's `settings.json`
  A theme *is* a JSON file, so editing it as JSON is the core, and a form comes
  later as a convenience over the same file. Never the other way round, where
  the form is the model and the JSON an export.
  - **Files:** user themes live in `<userData>/themes/<id>.json`. "New theme"
    copies a built-in as a starting point; built-ins themselves are read-only,
    like VS Code's defaults.
  - **Schema:** the Zod `ThemeSchema` also emits a JSON Schema
    (`zod-to-json-schema`), shipped with the app and referenced by `$schema`
    in every theme file. That one artefact gives autocomplete, hover docs per
    token (from the same descriptions as the typed token list) and
    red-squiggle validation, both in our editor and in VS Code for anyone who
    would rather edit there.
  - **In-app editor:** CodeMirror 6 with a JSON language and the schema, an
    inline color swatch beside every color value, and click-to-pick. Not
    Monaco: it is several MB and wants web workers, which is a lot to take on
    for one JSON file. CodeMirror is also a set of ES modules that expect a
    bundler, which the app does not have yet (see the Vue question in M3).
    Either vendor a single prebuilt bundle of the handful of packages needed,
    or treat this as the moment that question gets answered.
  - **Live preview:** the file is watched, not only saved from our editor, so an
    edit made in VS Code updates the preview too. `overlay-preview.ts` already
    drives every panel with a synthetic lap for arranging overlays, and the
    preview reuses it, so every token change is seen on moving data. An invalid
    file keeps the last valid theme on screen and shows the errors.
  - **Guard-rail warnings** (the checks above) appear as diagnostics on the
    offending token's line, the same way the schema errors do.
- [ ] Later: a visual editor view over the same file
  The token list grouped by surface, data, and shape and type, with color
  pickers and font and radius controls. It reads and writes the JSON, so the two
  views never disagree, and a "Open JSON" button sits in the corner, as VS
  Code's settings UI has. Built when people ask for it; the JSON view is
  complete without it.

**Step 3 — Themes in Content**

Needs M8.

- [ ] Content items get a `kind`: `callouts` or `theme`
  One set of machinery for both: versions (Step 3b), stars, downloads, forks,
  reports. A theme has no track key, so the catalog filters simply do not apply
  to it. Generalise `packs` into `content` with kind-specific version payloads,
  rather than building a second copy of everything.
- [ ] Themes in the Content sidebar's kind filter, with a rendered preview as their first screenshot
  The preview is rendered locally at publish time from the preview harness
  (delta, inputs and standings panels on the sample lap) and uploaded with the
  version. A theme's page swaps the Callouts, Map and Setups tabs for a
  **Preview** tab, and "Try it" applies the theme temporarily, with "Keep" or
  "Revert".
- [ ] Publishing runs the Step 2 validator server-side too
  The client check is for the author's convenience. The server check is the one
  that counts, because a client can be modified. It is an Edge Function doing a
  pure function over JSON, which is the right shape for one, unlike ingest (§8.1).

*Done when:* someone switches to Synthwave mid-session without the overlays
blinking, makes a variant with a different accent in the theme editor, publishes
it, and a second person finds it in Content under Themes, previews it on their
own overlays, stars it and keeps it.

## Screens

Every screen or dialog the open items above need, grouped by where it lives.
The milestone is in brackets. "New" means a new window, tab or dialog; everything
else changes something that exists. Today the app has the control window (tabs
Overlays and Track Coach), Preferences, the note editor, the YouTube importer,
the overlay panels and the tray menu.

Every screen here has to be designed for its **empty, loading, offline and
signed-out states** too, not only the happy path. Those are what a first-time
user sees first.

**Control window: frame**

- [ ] Account area, top right [M8.1]: "Sign in" when signed out; avatar with
  a menu (profile, sign out) when signed in.
- [ ] Session banner under the top bar [M8.5]: "No callouts for <track> in
  <car>. N packs in Content", or "Nothing yet. Write the first one". Also
  reused for "Update available for <pack>" and "the author withdrew this
  version" [M8.3b].
- [ ] Tab bar grows to Overlays · Track Coach · Content · Races [M8.5, M7].

**Control window: Track Coach tab (changes)**

- [ ] Split into **Mine** and **Installed** [M8.4]. Mine: drafts and published,
  with version, stars and downloads, plus Edit, Publish or Publish update.
  Installed: the pinned version, "vN available", an update policy toggle,
  a version picker, and Uninstall.
- [ ] Mapped tracks with no callouts [done this session]: add **Find in Content**
  beside Import… and Write manually [M8.5].
- [ ] Star button on installed packs [M8.5].

**Control window: Content tab (new) [M8.5, M9.3]**

- [ ] Sidebar: search, filters (sim, track, layout, car or class, kind,
  Starred, Installed), sort, and the result list with an Install button on
  each row.
- [ ] Item page, callout pack: header (icon, title, author, version, stars,
  downloads, updated; Install / Update / Uninstall, Star, version picker,
  Share), tabs **Details** (README with screenshots), **Callouts**, **Map**,
  **Changelog**, **Setups**, and the facts column.
- [ ] Item page, theme: the same header, tabs **Details**, **Preview**,
  **Changelog**, and "Try it" with a Keep / Revert bar.
- [ ] Screenshot lightbox (click a screenshot to see it full size, arrow keys
  to step through).
- [ ] Callout preview player: play one clip, rendered on demand, from the
  Callouts tab.
- [ ] Install progress: download, Piper and voice install on first use, and
  rendering N of M clips, shown on the row and on the page [M8.4].
- [ ] Author page: an author's display name, avatar and published content,
  reached from the facts column [M8.1].
- [ ] Report dialog: reason and details, for packs, maps and setups [M8.6, M8.7].

**Control window: Races tab (new) [M7]**

- [ ] Race history list: date, combo, finish, iRating change, filterable by
  combo, from `RaceSummaryRepository`; opens a summary.
- [ ] Per-combo view: this week and all-time best lap, average clean lap,
  finishes, incidents, and the rating history chart [M7.6].

**Race summary window (new) [M7.3-7.6]**

- [ ] Opens automatically at the end of a race, and can be reopened from Races
  or a menu.
- [ ] Result block: position, class position, positions gained, incidents, best
  lap.
- [ ] Rating block: estimate, then official. The iRating counter animation,
  SR bar, licence promotion moment, and "waiting for official results".
- [ ] Lap chart: every lap, clean laps distinguished, best marked.
- [ ] Where the time went: corners ranked by time lost, each with its reason
  ("braking 12 m early"), theoretical best, and consistency.
- [ ] Compared with other races: this week and all-time in the combo, most
  improved and most regressed corner.

**Publish flow (new dialogs) [M8.3, M8.3b, M8.6]**

- [ ] Publish dialog: title, summary line, README editor with live preview,
  icon and screenshots upload, car class, visibility, source attribution.
  Refuses dirty notes, with a link to render.
- [ ] Publish update dialog: the automatic diff since the last version, the
  author's changelog line, and the target map version.
- [ ] Setups section of the publish dialog: add `.sto` files with a label and
  the rights attestation checkbox [M8.6].
- [ ] Version management for the author: the list of versions, with Withdraw on
  each [M8.3b].
- [ ] Fork dialog: "Make my own copy", naming the copy and crediting the
  original. Later, an "upstream has vN" review listing the upstream diff note
  by note, with Keep / Take on each [M8.3b, M8.7].
- [ ] Draft sync conflict notice: "edited on another machine; kept both"
  [M8.3].

**Sign-in (new) [M8.1]**

- [ ] Sign-in dialog: Discord, Google, email magic link. Waiting on the browser,
  and an error state.
- [ ] "Check your email" state for the magic link.
- [ ] First sign-in: choose a display name and avatar (the `profiles` row).
- [ ] Sign-in landing page, a static web page shown in the browser after the
  OAuth redirect: "You can close this tab".

**Preferences (changes)**

- [ ] Theme picker with a swatch per theme [M9.1], plus the per-overlay-profile
  override, in the Overlays tab's profile row.
- [ ] iRacing account connection for official results (OAuth) [M7.4]. It is
  separate from the Exxeed sign-in and says why.
- [ ] Content settings: default update policy, cache size and a clear-cache
  button, where installed setups go [M8.4, M8.6].

**Theme editor (new window) [M9.2]**

- [ ] JSON view (the core): CodeMirror with schema autocomplete, hover docs,
  inline color swatches, and errors and guard-rail warnings shown on their
  lines.
- [ ] Live preview beside it: the overlay panels on the sample lap
  (`overlay-preview.ts`), plus a mock control window, and a backdrop switcher
  (light sky, dark night, busy grandstand). Follows the file on disk, so
  external edits show up too.
- [ ] Toolbar: New from…, Open in external editor, Reveal file, Apply, Publish.
- [ ] Later: the visual view over the same file, token list with pickers and an
  "Open JSON" button.

**Importer (changes) [M5 stage 4]**

- [ ] Cross-check flags in the callout list before import: "says brake, no
  brake onset at this turn" and "landmark 60 m from the measured onset".

**Note editor (changes)**

- [ ] Publish / Publish update in the header, a version badge, and the draft's
  sync state [M8.3].
- [ ] Read-only mode, used by the Content page's Map tab [M8.5].

**First run (new) [M6]**

- [ ] Welcome: what Exxeed does, in one screen.
- [ ] Borderless-windowed warning, with a picture of the iRacing setting. The
  number one support question, so it gets a screen of its own.
- [ ] Voice setup: Piper and the voice download with progress, or skip.
- [ ] Overlay layout: pick a profile and arrange, reusing the edit mode.
- [ ] Optional sign-in, with "you can do this later".
- [ ] Done: "start iRacing and drive". Where callouts come from: installed
  packs, Content, or writing your own.

**Overlays (changes)**

- [ ] Everything re-themed [M9.0]. There are no new panels, but every panel has
  to be checked in all four built-in themes.

**Tray (changes)**

- [ ] "Update available" and "Race summary ready" items [M8.4, M7.3].

**Moderation (new, admin role only) [M8.7]**

- [ ] Reports queue: the reported item, the reason and the reporter, with Unlist,
  Dismiss, and, for maps, "Publish replacement map version". Could start as a
  saved view in the Supabase dashboard and become a screen once reports are
  frequent enough to need one.

**Web (new, outside the app) [M8.5]**

- [ ] Share page for `exxeed://pack/<id>`: the item's README, screenshots, stars
  and an "Open in Exxeed" button, with a download link for people without the
  app.
- [ ] The OAuth landing page (listed under Sign-in).

## Open questions (§13)

- [x] ~~**Landmark inventory bootstrap.**~~ **Settled: not needed yet.**
  A landmark reference in the *words* is just a string — "brake at the black seam"
  needs no `Landmark` record. The inventory is machinery for §10 stage 3, so it is
  an M5 question, not an M1 one. Daytona's notes name real markers from a track
  guide with no inventory anywhere. A marking tool becomes worth building when the
  model needs a closed vocabulary, and not before.
- [ ] **Car class taxonomy.** ~~Need a car-ID → class mapping table~~ (done: `data/cars/iracing.json`, one car so far), and a granularity decision (GT3 vs GT3-by-manufacturer).
  The importer now leans on it too: a car picked from the schedule has only a
  name, and is matched to the table by name before falling back to a slug.
  Now has a second consumer: the preferences window picks a reference lap by car
  id, and a note set names a car *class*. With one car and one track that gap is
  invisible; it will not stay that way.
- [ ] **Reference lap source.** Live SDK recording for v1 — now automatic, the first clean lap and then the session's fastest (M1); `.ibt` and `.blap`/`.olap` import deferred.
- [ ] Cheap first step on `.blap`: hex-dump a lap whose time you know, look for that time as a float, check whether file size scales with track length in a way that implies per-sample records. An hour of work tells you whether it's tractable at all.
- [x] ~~**Voice provider.**~~ **Settled: Piper**, `en_US-lessac-medium`.
  See M2. Cost did not decide it — the whole v1 corpus is ~126k characters, which
  fits inside most providers' free tiers — so quality is the only thing that would
  ever justify moving, and `TtsEngine` keeps that a one-file change.
- [ ] **CrewChief landmark corpus.** Worth an email to Jim Britton about reuse. A shortcut, not a dependency — don't block on it.
