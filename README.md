# Exxeed

A **track coach for iRacing**, for people who hate driving new
tracks. It talks you round the circuit while you drive, and cuts the painful
part of learning it down to a minimum.

```
"Brake at the hundred board, down to third"
"Gas when you see the ferris wheel"
"Stay inside for the next one"
```

It is your track guide video, riding along. Instead of watching it the night
before and trying to remember it, you hear each tip at the corner it is about,
tied to something you can see from the car. Your first laps at a new circuit
are already guided laps.

## Who it's for

**The sim racer with two hours a week.** New week, new track. What is the
fastest, most intuitive way to not just be a backmarker in the race? Not
spending one of your two hours watching a video and the other finding out where
turn four goes. You want to be driving proper laps tonight.

**Not for the last hundredth.** If you already know your way around every
track and are hunting your missing 0.01, you are better served by a telemetry
or coaching tool built for that. Exxeed is for the step before: getting from
"never driven here" to "I know this place" as fast as possible.

## Learning by doing, not homework

You know the routine: watch the track guide, pause, rewind, then get in the car
and try to recall what was said about turn seven while you are arriving at
turn seven.

Exxeed skips the homework and puts the guide in the car.

- **Told at the corner, not the night before.** "Brake at the 100 board" arrives
  just before the 100 board does.
- **Things you can see.** Boards, kerbs, the end of a tyre wall. Markers you
  can actually look for at speed.
- **You drive from the first minute.** The laps you would spend guessing are
  spent learning.
- **Never talks over your braking point.** If two calls come close together you
  get the short version, or the less important one is skipped.

## Three ways to get callouts for a track

- **Install a pack.** Find a callout pack another driver made for your track and car, install it, and go drive. No account needed.
- **Import a track guide.** Pick your favourite YouTube track guide and turn it into one callout per corner, with credit to whoever made it.
- **Write your own.** Put your own notes on the track map, hear them against a lap, and share the pack when you are happy with it.

### Install a pack

![A callout pack's page in the Content tab](docs/screenshots/content.png)

The **Content** tab is where packs live. Search by track and car, see what a
pack says before you install it, and star the good ones. When an author
improves a pack, you get the update. Packs can also carry a setup and lap
files for the same car and track.

![Track Coach: your own and installed callout packs](docs/screenshots/coach.png)

**Track Coach** keeps your packs together and loads the right one for the
track and car you are on. Want to hear a pack before you drive it? Test mode
runs a lap through it without the sim.

### Import a track guide

![The YouTube importer, listing this week's official iRacing races](docs/screenshots/importer.png)

1. Pick the race: the session you are in, or one of this week's official races.
2. Find a track guide for it and watch it right there.
3. Turn it into callouts, one per corner, each one editable.
4. Check them on the map, and drive.

### Write your own

![The note editor: Snetterton with numbered callouts, braking zones, and the throttle and brake chart](docs/screenshots/editor.png)

The editor shows the lap the way you think about it: turn by turn.

- **Every callout on the map**, with the stretch of track it is spoken over, so
  you can see when two of them would overlap.
- **Where the fast lap brakes.** Braking zones are drawn on the track, and a
  callout can snap straight to the braking point.
- **Throttle, brake and speed** for the whole lap under the map.
- **Play lap** drives the lap around the map and speaks every callout where
  you would hear it, so you can tune a pack without leaving the pits.
- **Publish** it for others when it is ready.

## Fast reference laps, from Garage 61

When you are new to a track, your own laps are the last thing you want to be
compared to. So Exxeed's **reference laps** are fast laps from
[Garage 61](https://garage61.net): the lap your callouts are timed against, and
the one the overlays compare your throttle, brake, speed and delta to.

You do not have to do anything. The Exxeed team prepares the track map and a
reference lap for each track and car from Garage 61, and they arrive in the app
with the track.

- **Laps shared on Garage 61.** Exxeed uses laps that are visible to it through
  Garage 61's API, the same ones you could open there yourself.
- **Only the reference lap and track map are kept.** The Garage 61 file itself
  is not stored or passed on.

## Overlays

Exxeed comes with a full set of overlays. Place and size each one where you
like, and save layouts as profiles: one for practice, one for racing. They hide
when you tab out of iRacing.

Several of them compare you to your reference lap as you drive, which is
where a fast lap from Garage 61 earns its keep.

*The pictures show sample data.*

### Driving

| Overlay | What it shows |
| --- | --- |
| <img src="docs/screenshots/overlays/inputs.png" alt="Essential Inputs" width="320"><br>**Essential Inputs** | Throttle and brake as a rolling trace and as bars, with speed, gear and steering. |
| <img src="docs/screenshots/overlays/pedals.png" alt="Input Telemetry" width="320"><br>**Input Telemetry** | The fuller version: adds the reference lap's speed and gear under yours, the live delta and the steering angle. |
| <img src="docs/screenshots/overlays/trace.png" alt="Input Comparison" width="320"><br>**Input Comparison** | Your throttle and brake against the reference lap over the track just ahead, with the reference braking point marked. |
| <img src="docs/screenshots/overlays/speed.png" alt="Speed Comparison" width="320"><br>**Speed Comparison** | Your speed against the reference lap's over the next few hundred metres. |
| <img src="docs/screenshots/overlays/brake.png" alt="Brake Indicator" width="320"><br>**Brake Indicator** | A countdown bar to the reference braking point, in metres. |

### Timing

| Overlay | What it shows |
| --- | --- |
| <img src="docs/screenshots/overlays/delta.png" alt="Delta Bar" width="320"><br>**Delta Bar** | Time gained or lost against the reference lap, live. |
| <img src="docs/screenshots/overlays/sectors.png" alt="Delta Sectors" width="320"><br>**Delta Sectors** | The delta per sector, with best, last and reference lap times. |
| <img src="docs/screenshots/overlays/corners.png" alt="Corner Analysis" width="320"><br>**Corner Analysis** | Time gained or lost in the corner just taken and the apex speed difference, with the speed trace through it. |
| <img src="docs/screenshots/overlays/reference.png" alt="Comparison Target" width="320"><br>**Comparison Target** | Which lap you are being compared to. |

### Race

| Overlay | What it shows |
| --- | --- |
| <img src="docs/screenshots/overlays/standings.png" alt="Standings" width="320"><br>**Standings** | The field by class: strength of field, licence and iRating, gap, interval, last and best lap. |
| <img src="docs/screenshots/overlays/relative.png" alt="Relatives" width="320"><br>**Relatives** | The cars around you on track with the gap to each, plus temperatures, brake bias, incidents and time left. |
| <img src="docs/screenshots/overlays/radar.png" alt="Radar" width="320"><br>**Radar** | Cars alongside you, with the occupied side lit. |

### Track

| Overlay | What it shows |
| --- | --- |
| <img src="docs/screenshots/overlays/map.png" alt="Track Map" width="320"><br>**Track Map** | The whole circuit with every car by class position, and where the callouts are. |
| <img src="docs/screenshots/overlays/minimap.png" alt="Mini Map" width="320"><br>**Mini Map** | A zoomed view of the track around your car. |

### Car

| Overlay | What it shows |
| --- | --- |
| <img src="docs/screenshots/overlays/fuel.png" alt="Fuel Calculator" width="320"><br>**Fuel Calculator** | Fuel and laps left, usage per lap (last, average, max) and how much is needed to finish. |
| <img src="docs/screenshots/overlays/tyres.png" alt="Tyres" width="320"><br>**Tyres** | Pressure, temperature across the tread and wear for each tyre, from the last pit read. |
| <img src="docs/screenshots/overlays/damage.png" alt="Damage" width="320"><br>**Damage** | Required and optional repair time. |
| <img src="docs/screenshots/overlays/weather.png" alt="Weather Conditions" width="320"><br>**Weather Conditions** | Sky, air and track temperature, humidity, rain, wind and how wet the track is. |

## Status

Exxeed is still being built. Callouts, the editor, track guide import,
Garage 61 import, overlays and pack sharing already work, and it is being
tested with iRacing on Windows.

Before release: a one-click Windows installer, and more packs for more tracks.
Until then it runs from source; see [Development](#development).

After that: a race summary after each session, themes for the overlays, driver
profiles with stats, and callouts that go quiet once you have learned a corner.

## How it's built

The system splits along a build-time / run-time line, and keeping that line sharp
is the main architectural discipline:

```
PREPARATION (offline, slow, AI in the loop)
  one lap        ──► track map + centreline + reference lap
  YouTube video  ──► note set ──► human review ──► audio pack
                                     │
                                     ▼
RUNTIME (60 Hz, dumb, deterministic)
  telemetry + note set ──► trigger ──► speak
```

The runtime is deliberately stupid: no analysis, no model calls, no network, no
decisions that aren't already in the data. It reads pre-computed artefacts and
fires pre-rendered audio. That is what makes it fast, offline-capable, testable
off a recording, and free to run. The AI cost is paid once per video, never per
lap.

Node 20 · TypeScript (strict, everywhere) · Electron · pnpm workspaces · Vitest ·
Supabase. Local disk is what a session runs from; the cloud is a sync service
for maps and packs.

## Garage 61 import

![The Garage 61 lap search in Track Coach → Import lap…](docs/screenshots/garage61.png)

How the reference laps and maps get into Exxeed. Garage 61 gives out API tokens on request, so connecting
an account is an admin feature, not something every driver does. With a token,
**Track Coach → Import lap…** searches laps by track and car, and the bulk tool
(`pnpm --filter @exxeed/trackmap g61`) builds maps for many tracks. What it
builds is shared to Exxeed's database, so drivers get maps and reference laps
from Exxeed and never call Garage 61 themselves.

- **Which laps.** The admin's own laps by default. Unticking "Only my laps"
  (`--with-teammates` in the tool) includes the laps teammates share with that
  account on Garage 61.
- **The token stays on the admin's machine**, encrypted with the OS keychain
  (or in a gitignored `.env` for the tool). It is not in the app and is never
  sent to Exxeed's servers.
- **Only what is built from a lap is kept and shared**: the reference lap and,
  if needed, the track map. The Garage 61 CSV itself is not stored.
- A CSV exported from the Garage 61 website can also be imported by anyone, with
  no token (**Import lap… → Choose a Garage 61 CSV**).
- Uses Garage 61's documented v1 API (driver, tracks, cars, lap search, lap
  CSV): one lap per import or per layout, layouts that already have a map are
  skipped, and rate-limit responses are waited out.

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

`Cmd/Ctrl+E` opens the note editor, described under
[Write your own](#write-your-own). Double-click a callout's words in the list
to edit them, drag a marker to move it, double-click the track to add one.

**Render Audio** (`Cmd/Ctrl+Shift+R`) re-renders the set through Piper and
redraws the windows from the new durations. Download a voice in preferences
first — without one the button is disabled rather than failing when pressed.

### Importing from YouTube

`Cmd/Ctrl+I` (or **Import from YouTube** in Track Coach) finds a track guide and
turns it into callouts:

1. **Race** — the live session fills in track and car on its own; otherwise pick
   from **This week**'s official races, or type them in.
2. **Search** — `iRacing track guide <car> <track>` through yt-dlp, which is
   downloaded on first use into `data/tools/`.
3. **Watch** — the guide plays in the window beside its transcript; click any
   timestamp to jump there.
4. **Convert** — one request to the model chosen under **AI model** (Claude,
   OpenAI, Gemini, or any OpenAI-compatible server such as Ollama), on your own
   API key. Or **Copy prompt**, paste it into any AI chat, and paste the answer
   back. Either way you get one editable callout per turn.
5. **Import** — the callouts are placed on the track map and rendered, installing
   Piper and a voice the first time, then opened in the editor: ready to drive.
   Corners are matched by description, not by number, and the official turn
   numbers the coach uses are learned and shown from then on. A guide for a
   different layout is flagged. A track with no map yet keeps the callouts under
   `<data>/imports/` until you have driven a lap there.

API keys are stored encrypted with the OS keychain and never reach the window.
This week's races need no account: they come from iRacing's public season
schedule PDF, fetched a few times a day and read by date.

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
EXXEED_DATA=data/demo EXXEED_NOTES=spa-gt3-fixture EXXEED_SPEED=8 pnpm dev
```

`data/demo/` holds a two-corner Spa stub — track map, landmarks, note set and a
placeholder audio pack — so both of those work with nothing else set up. The app
itself reads `data/` by default; point it at `data/demo` to use the fixture. The
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

#### Track maps

At a track with no map, the app cuts one from your **first clean lap** while you
drive — a full lap from the line, never on pit road, off track or towed — and the
map overlay appears as soon as that lap ends. A faster clean lap later in the same
session replaces the reference lap (the delta bar's ghost) without re-cutting the
map. The log says why each lap before that one was not used. Corners are numbered
as detected; add `data/tracks/iracing/<id>/<layout>/corners.override.json` to match
the official numbering before importing callouts by turn. The map overlay shows
for any mapped track, with or without a note set.

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
