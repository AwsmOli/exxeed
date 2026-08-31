# Exxeed

A desktop app for iRacing that tells you **where** to brake, in terms you can see
out of the windscreen, at the moment you need to hear it.

```
"Brake at the hundred board"    → fires ~1.7s before the braking point
"Kerb — throttle"               → fires at the apex
"Stay inside for the next one"  → fires on exit
```

> Status: build spec written, M0a scaffold up. Nothing drives yet.

## Why this doesn't already exist

Existing telemetry coaches are **delta coaches** — they compare your lap to a
reference and report the difference: *"brake 10m later."* That only helps once you
already know roughly where to brake.

The reference lap does contain the braking point, but only as *"2,340 metres into
the lap"* — useless to a human at 250 km/h. The missing piece is translating **lap
distance** into a **visual landmark**, and right now that translation exists only
inside YouTube lap guides you have to watch and re-watch between stints.

So Exxeed extracts that translation once, delivers it by voice at the right
instant, and **stops saying it once you've learned the corner.**

## How it's built

The system splits along a build-time / run-time line, and keeping that line sharp
is the main architectural discipline:

```
GENERATION (offline, slow, AI in the loop)
  recorded lap  ──► TrackMap + centreline + LandmarkInventory
  YouTube video ──► NoteSet ──► human review ──► AudioPack
                                     │
                                     ▼
RUNTIME (online, 60 Hz, dumb, deterministic)
  telemetry + config ──► trigger ──► speak ──► fade
```

The runtime is deliberately stupid: no analysis, no model calls, no network, no
decisions that aren't already in the config. It reads pre-computed artefacts and
fires pre-rendered audio. That is what makes it fast, offline-capable, testable off
a recording, and free to run — the AI cost is paid once per video, never per lap.

Node 20 · TypeScript (strict, everywhere) · Electron · Vue 3 · pnpm workspaces ·
Vitest. Local-first in v1, with a repository layer already shaped for Supabase.

## Rendering audio

Callouts are rendered offline, once per note set, by [Piper](https://github.com/rhasspy/piper)
— local, free, and native 16-bit WAV, so nothing calls a TTS API at runtime and
there is no `ffprobe` dependency: duration is read straight out of the header.

**Only authors need any of this.** A note set carries its own audio — ten files
and about 1.2 MB for a five-callout set — so driving one someone else wrote needs
no Piper, no voice model and no setup. That is the whole reason §10 renders
offline: CrewChief needs a several-hundred-megabyte sound pack because it
assembles sentences from fragments at runtime, and Exxeed does not, because each
callout is one fixed sentence rendered whole.

To write notes, open **Preferences → Voice rendering**. It lists the voices it
can fetch, downloads the one you pick into `data/voices/`, and finds Piper
itself. On Windows and Linux it can install Piper for you; on macOS there is no
working standalone build, so use a venv:

```sh
python3 -m venv .venv && .venv/bin/pip install piper-tts
```

The same venv is what the ingest CLI uses when rendering a pack away from the sim
machine:

```powershell
# Windows
python -m venv .venv
.venv\Scripts\python.exe -m pip install piper-tts
pnpm --filter @exxeed/ingest start render daytona-mx5-draft --data data
```

A venv puts its executables in `Scripts\` on Windows and `bin/` elsewhere, and
`--piper` defaults to whichever matches the platform it is running on. Override
it with `--piper` or `EXXEED_PIPER` if piper lives somewhere else.

```sh
python3 -m venv .venv && .venv/bin/pip install piper-tts
```

`data/voices/` and `data/piper/` are gitignored, as is the venv — a voice model
is ~60 MB of someone else's weights, not source. So is `data/audio/`: **an audio
pack is a build artefact, not source.** A fresh clone has note sets but no sound,
and rendering is what produces it — if callouts are silent, or beep, that is the
step that has not been run.

### Voice licences, which are not a formality

Most Piper voices cannot be shipped in a product, and the popular ones are the
worst offenders. `en_US-lessac-medium` — the obvious default, and what this
project rendered with first — is trained on the Blizzard 2013 Lessac corpus,
whose licence forbids "the development, marketing, commercialisation, sale or
licencing of voice synthesis products", and that reaches the *synthesised audio*,
not just the model. `hfc_male` is CC BY-NC-SA. Both are fine to experiment with
and impossible to distribute.

The picker therefore offers a short list whose model **and dataset** licences
were both read: `en_US-ljspeech` (public-domain dataset, MIT model) and
`en_US-libritts_r` (CC BY 4.0, so credit it). Adding to that list means reading a
MODEL_CARD — rhasspy/piper-voices is MIT as a repository while containing voices
nobody may ship, so the repository licence proves nothing.

> **Piper is not deterministic by default.** It samples noise during inference,
> so the same sentence rendered twice differs by ~240 ms. That matters more here
> than it sounds: `durationMs` is an input to the trigger, so a re-render would
> silently retime every callout. The renderer pins both noise scales to zero on
> every invocation, which makes output byte-identical across runs — it is not
> something to leave to a config file.

Rendering writes the measured duration into both the pack and the note, and
clears each note's `dirty` flag.

### Editing notes

`Cmd/Ctrl+E` opens the note editor: the track, every callout's text, and each
one's speaking window shaded back from its point. Double-click a label to edit
it, drag a point to move it, or snap it to the measured braking point.

**Render Audio** (`Cmd/Ctrl+Shift+R`) re-renders the set through Piper and
redraws the windows from the new durations. Download a voice in preferences
first — without one the button is disabled rather than failing when pressed.

## Testing on Windows

The live SDK, the steering sign convention, and recording a real lap all need a
Windows machine with iRacing. **[docs/WINDOWS.md](docs/WINDOWS.md)** is the
step-by-step.

## Documentation

**[docs/SPEC.md](docs/SPEC.md)** is the source of truth — data model, note engine,
corner detection, overlays, ingest pipeline, milestones, and the open questions.
Read §12 (Pitfalls) before writing any code.

[TODO.md](TODO.md) tracks the milestones.

## Development

Requires Node 20+ and pnpm.

```sh
pnpm install
pnpm test          # runs on any platform, no sim needed
pnpm typecheck
pnpm lint
```

Replay a recording through the note engine, or boot the app against one:

```sh
# Timeline of what would be said, and what would be dropped
pnpm --filter @exxeed/replay start <recording.ndjson> --notes spa-gt3-fixture --data data/demo

# The app, with audio, replaying the built-in fixture at 8x
EXXEED_NOTES=spa-gt3-fixture EXXEED_SPEED=8 pnpm dev
```

`data/demo/` holds a two-corner Spa stub — track map, landmarks, note set and a
placeholder audio pack — so both of those work with nothing else set up. The
audio is tone bursts at the right durations, not speech: the engine only cares
about `durationMs`, which is what sets lead distance.

### Overlay mode

`EXXEED_OVERLAY=1` opens each panel as its own transparent, click-through,
always-on-top window, so they can be placed where a rig actually needs them —
the delta near the eyeline, the trace somewhere glanceable, the map wherever
there is room.

```sh
EXXEED_OVERLAY=1 pnpm dev                       # all five
EXXEED_OVERLAY=1 EXXEED_PANELS=delta,trace pnpm dev
```

Panels: `telemetry`, `map`, `trace`, `delta`, `callouts`.

`Ctrl+Shift+E` (`Cmd+Shift+E` on macOS) unlocks **every** overlay at once — they
turn opaque with a blue border, name themselves, and can be **dragged anywhere
with the mouse**. The same shortcut locks them again and saves the layout. While
locked they are click-through, so they cannot be moved and cannot steal a click
from the sim. Positions are remembered per panel and restored
next launch; an overlay whose display has gone away comes back on the primary
one rather than opening somewhere invisible. Launch prints where each landed,
which is the only way to answer "off-screen or behind the game?".

> **Run the sim in borderless windowed.** Transparent overlays are not supported
> over exclusive fullscreen. Windows 10/11 Fullscreen Optimizations often
> converts DX11 exclusive fullscreen to a composited path, so it may appear to
> work anyway — but borderless windowed is the supported configuration.

Replay runs at real time unless you ask otherwise — `EXXEED_SPEED=8` to hurry.

> **A recording that starts mid-session needs `EXXEED_SKIP_OUTLAP=1`.** Two
> separate rules keep the engine quiet until a lap has been completed: §6.4's
> gate, and §6.2 starting every note spent. A single extracted lap satisfies
> neither, so it plays back in silence — correct behaviour that looks exactly
> like a broken engine. The flag relaxes both, and main refuses to honour it for
> a live source.

### Configuration

Settings live in a preferences window — **Preferences in the menu**, `Cmd/Ctrl+,`,
or `Cmd/Ctrl+Shift+P` — and it opens by itself on first run when no note set has
been chosen.

> On macOS the menu bar is global, so it is always reachable. On Windows and
> Linux a menu belongs to a window frame and every overlay is frameless, so in
> overlay mode there is no visible menu there — the shortcuts are the interface.
> They are global, so they work while the sim has focus, which a menu accelerator
> never does. Note set,
voice, lead adjust, reference car and which overlays to show are all there, saved
to `settings.json` in the app's data folder.

A **Debug** section covers the things that only make sense against a recording:
replay file, replay speed, loop, and skipping the out-lap. It is **on
automatically when running from source**, so `pnpm dev` needs no flag; a packaged
build has it off unless started with `EXXEED_DEBUG=1`. `EXXEED_DEBUG=0` forces it
off from source, which is how to check packaged behaviour without packaging.

Debug settings are saved like anything else but **only take effect while debug is
on** — otherwise a replay file set once could quietly stop a real user's sim from
connecting, with no visible panel to explain it.

Changing the note set, voice, car or data folder rebuilds the session in place.
The overlays keep their positions.

**Fewer callouts once a track is familiar** is a matter of picking a shorter note
set — one naming only the corners that stay hard. The engine does not try to
work out what you have learned; you tell it, because that is the one judgement
you are better placed to make than the telemetry is.

#### Environment overrides

Every setting can still be overridden at start-up, which is what the scripts and
tests in this repo use. An override is never written back — running one session
at `EXXEED_SPEED=8` should not silently become the saved preference — and the
preferences window says which fields are being overridden rather than letting an
edit look like it did nothing.

`EXXEED_NOTES`, `EXXEED_DATA`, `EXXEED_VOICE`, `EXXEED_CAR`, `EXXEED_LEAD_ADJUST`,
`EXXEED_PANELS`, `EXXEED_REPLAY`, `EXXEED_SPEED`, `EXXEED_SKIP_OUTLAP`,
`EXXEED_OVERLAY`, `EXXEED_DEBUG`. Two more belong to the ingest CLI:
`EXXEED_PIPER` and `EXXEED_VOICE_MODEL` (a voice id in `data/voices/`, not a path).

`EXXEED_REPLAY` takes a full path, and should — it is passed by scripts that
never see the picker. The saved setting behind it names a file inside the
recordings folder instead; see below.

#### Recordings

`data/recordings/` is the one place replays come from. A session's own recording
lands there grouped `<trackId>/<carId>/<stamp>.ndjson`, the preferences window
lists whatever is in it newest first, and **Import…** checks a file will actually
replay before copying it in — that it has frames, that they parse, and that the
car moves. A file that merely parses but was recorded parked replays as a session
where nothing happens, which is indistinguishable from a broken engine, so that
is checked rather than assumed.

**Open folder** shows it in the file manager, so a pile of laps can be dropped in
at once; the list refreshes when the preferences window comes back into focus.
Nothing about a recording being picked up depends on how it got there — the
import button only adds the check and the `<trackId>/<carId>/` grouping.

### Command-line tools

```
exxeed-replay   <recording.ndjson> [--speed N] [--notes ID] [--data DIR] [--lead-adjust S]
                [--skip-outlap]
exxeed-trackmap <lap.ndjson> --track-id N --config ID [--overrides PATH] [--svg PATH] [--dry-run]
exxeed-ingest   render <noteSetId> [--model PATH] [--length-scale N] [--voice ID]
exxeed-ingest   import <profile.json> --id <noteSetId> --track-id N --config ID
```

Each prints its full option list when run without arguments. Note that
`exxeed-replay` defaults to running **flat out**, not real time — pass
`--speed 1` to watch it.

**iRacing is Windows-only, and so is the telemetry SDK.** `@irsdk-node/native`
ships prebuilds for `win32-x64` and `win32-arm64` only; off Windows its installer
substitutes a **mock** that returns fabricated telemetry rather than failing. So
`IRacingAdapter` guards on platform and throws instead — plausible-looking fake
data is worse than a clear error.

Everything else — the engine, the schemas, the replay harness, the tests — is
platform-neutral and developed against recorded laps via `ReplayAdapter`, so the
bulk of the work happens anywhere. With no recording to hand the app falls back to
a small synthetic fixture, which is enough to see frames flowing but is not real
telemetry and must never be used to cut a track map.

## License

MIT
