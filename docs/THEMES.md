# Theming the overlays

A theme can change more than colours. It can restyle anything with its own
stylesheet, and rebuild any overlay with its own template. That is how the
Gran Turismo theme puts your gap to the car ahead on a line of its own between
two rows. Nothing in a theme is code: templates are declarative and sanitized,
so a theme from Content is safe to install.

Start with **New…** in the Overlays tab, based on the built-in closest to what
you want, then **Edit**. Changes show on the overlays as you type; turn on Test
mode to have something to look at.

## What a theme is made of

A theme is a folder in the app's `themes` folder (**Folder** in the Overlays tab):

```
my-theme/
  theme.json                 name, base, layout, tokens
  theme.css                  optional — a stylesheet over the built-in one
  templates/standings.html   optional — how that overlay is built, one file per overlay
```

In the editor, **Add…** creates `theme.css` or a template. A new template
starts as a copy of the one the overlay uses now, so you start from what is
on screen. An older theme that is a single `my-theme.json` file becomes a
folder the first time you add one. When a theme is published to Content, the
whole folder goes up as one document, and installing it writes the folder back.

### theme.json

```json
{
  "$schema": "../theme.schema.json",
  "name": "My GT",
  "description": "Gran Turismo with a red position box.",
  "base": "gran-turismo",
  "tokens": { "red": "#c8102e", "radius": "0px" }
}
```

- `base` is the theme you start from: `iracing`, `gran-turismo`, `synthwave`
  or `classic`. Its tokens fill in anything you leave out. Its stylesheet and
  templates come along too, so a theme based on Gran Turismo keeps GT's
  standings unless it has a standings template of its own.
- `tokens` are colours, fonts and shapes. Every token, with what it does,
  completes in the editor; the full list is the `tokens` section of
  `theme.schema.json` beside your themes.
- `layout` (`wash`, `chips` or `blocks`) picks one of three built-in row styles
  for Standings and Relatives. A template replaces that entirely.

### theme.css

A stylesheet applied after the app's own. The app's styles sit in a cascade
layer, so **your rules always win, however specific the app's are** — `.row`
beats anything the app says about `.row`. Tokens are available as variables:
`var(--card)`, `var(--red)`, `var(--title-font)`.

The overlays load nothing from outside the app, so `url(https://…)` does
nothing. Fonts and images have to be ones the app already has.

`:root` carries the current state as attributes, to style by:

| Attribute | Values |
|---|---|
| `data-theme` | the theme's id |
| `data-base` | the base theme's id |
| `data-layout` | `wash`, `chips` or `blocks` |
| `data-shift` | `lights` or `sweep` (the `shift-style` token) |

`body` carries `data-style` when the driver has chosen a different structure
for that overlay (`dial` for the Delta, `stack` for Weather, `dark` for the Track Map),
and `data-hidden` with the parts switched off, space-separated:
`body[data-hidden~="revlights"]` styles the overlay without its rev lights.

### Templates

`templates/<overlay>.html` replaces how that overlay is built. The file is
HTML with a root element, plus a little template language:

| Write | Does |
|---|---|
| `{{ name }}` | the value, as text — in text or inside an attribute |
| `{{ gapS \| signed:3 }}` | piped through a filter (below); filters chain |
| `{{ 'POSITION' }}` | a fixed string |
| `data-if="isPlayer"` | the element only while the value is truthy |
| `data-if="!isPlayer"` | …or falsy |
| `data-each="rows"` | the element once per item. Inside, names are looked up in the item first, then outwards; `{{ . }}` is the item itself; `$index`, `$first`, `$last` and `$count` are set |
| `data-each="r in rows"` | the same, with the item named: `{{ r.name }}` |
| `data-class="me: isPlayer; pit: onPitRoad"` | classes switched on by values |
| `<x-group>` | a wrapper that takes no room, to repeat or hide several siblings together |
| `data-part="gap"` | hidden when the driver switches that part off in the overlay's options |
| `<x-map>`, `<x-trace>`, … | building blocks drawn in code (below) |

Values are only ever written as text or as an attribute's value — never as
HTML. Scripts, event handlers, links, forms, images and `id` attributes are
removed. Inline `style` works, so data can size things:
`<i style="width:{{ fillPct }}%"></i>`.

The root element should carry `class="panel"` and normally
`data-class="is-empty: empty"`, with a `<div class="empty">` child. The app
shows that child, and hides the rest, while there is nothing to show.

**To see what a template can use**, open the overlay with **Inspect** in the
editor and type `overlayData` in its console: that is exactly the data your
template is given, live.

#### Filters

| Filter | Gives |
|---|---|
| `lapTime` | `1:57.870`, or `—` |
| `sectorTime` | `0:42.833`, always with the minute |
| `clock` | `29:04`, or `1:02:10` past the hour |
| `signed:digits` | `+0.533` / `−0.760`, always signed (1 digit unless given) |
| `gap:digits` | `+13.8`; nothing when there is no gap |
| `fixed:digits` | the number to that many digits |
| `irating` | `3.4k` |
| `pct` | `0.45` → `45%` |
| `abs`, `neg` | the size of a number; the number negated |
| `upper`, `lower` | case |
| `first`, `initial` | the first word (`A 3.41` → `A`); the first letter |
| `pad:width` | zero-padded: `7` → `07` |
| `or:text` | `text` when the value is empty |
| `then:text` | `text` when the value is truthy, otherwise nothing |

#### Building blocks

Blocks are drawn in code and fill the box they are put in; size and place them
with the template and `theme.css`. Their attributes are their options.

| Block | Draws |
|---|---|
| `<x-icon name="…">` | a line icon: `gearbox`, `wheel`, `pump`, `thermometer`, `droplet`, `lanes`, `disc`, or `sky` with `of="{{ skies }}"`. `size` for wheel, pump and disc |
| `<x-shift-lights>` | sixteen rev lights from both ends inwards, blinking at the shift point. Hidden when `shift-style` is `sweep` |
| `<x-sweep shape="band" redline="0.82" mark>` | Gran Turismo's rev band, white with the revs and flashing red to shift. `shape` is `band` (a strip of upright ticks on an even curve, cut straight at the ends), `swoop`, `arch`, `arc` or `line`; `hatch` ticks the line shapes; past `redline` (0–1) the lit part is red; `mark` puts a small red arrow at the redline. Under the band, `.sweep-body` can be filled to make it the top edge of a body. Shown only when `shift-style` is `sweep`. Colours: `--sweep-lit`, `--sweep-red` in theme.css |
| `<x-timeline seconds="5">` | throttle and brake against time |
| `<x-wheel-dial>` | a ring showing how far the wheel is turned |
| `<x-trace>` | throttle and brake by lap position against the reference lap |
| `<x-speed-trace>` | speed by lap position against the reference lap |
| `<x-delta-dial>` | the delta as a ring (Delta overlay only) |
| `<x-corner-chart>` | your speed through the last corner over the reference's (Corner Analysis only) |
| `<x-map dark road="outline" cars="chevron">` | the whole track, heat map, sectors, callout points and cars. `dark` numbers the turns; `road="outline"` is a hollow white line; `cars="chevron"` draws arrowheads, yours red |
| `<x-minimap ahead="260" road cars disc="none">` | the road around the car, turned so ahead is up. `disc="none"` fades the road out instead of framing it |
| `<x-radar cars="chevron" disc="none">` | cars alongside, ahead and behind |

The blocks' colours come from the tokens: tyre temperatures from `temp-cold`,
`temp-cool`, `temp-ok`, `temp-warm` and `temp-hot`, chevrons from `blue` and
`red`, the outline road from `road-edge`.

Fonts a theme can name (tokens `font`, `num-font`, `title-font`) include
`squared` (squared digits, as a game's speedo), `narrow` (narrow capitals for
captions) and `swiss` (Helvetica, or Arial on Windows).

## What each overlay gives its template

Times are seconds (`…S`), speeds km/h (`…Kph`), and `good` / `bad` mean
gaining / losing time. Values that may be missing are `null`. `show.*` is
whether the driver has that part switched on in the overlay's options.

**Standings** (`standings`) — `empty` (why there is nothing, or null),
`session` (`R`, `Q`, `P`…), `lap`, `lapsTotal`, `lapsLine` ("Lap 3/12"),
`timeRemainS`, `incidents`, `show.{header, number, license, irating, chip, gap,
interval, last, best}`, `cols` (grid columns for those), `fieldSize`,
`player` (your row), `playerClass` (your class) and `classes[]`: `name`,
`colour`, `sof`, `size`, `rows[]`. Each row: `position`, `carNumber`, `name`,
`colour`, `isPlayer`, `onPitRoad`, `license`, `licenceColour`, `iRating`,
`gapS` (to the leader), `intervalS` (to the car ahead), `lastLapS`, `bestLapS`,
`fastest`, `aheadOfPlayer`, `behindPlayer`, `behindS` (on your row: the car
behind's interval to you). Long classes are condensed to the top three and the
cars around you.

**Relatives** (`relative`) — the session values above, `airC`, `trackC`, `sof`,
`brakeBiasPct`, `clock` (time of day), `show.{header, number, lap, license,
irating, chip, footer}`, `cols`, and `rows[]`: `position`, `carNumber`, `name`,
`lap`, `lappingYou`, `lappedByYou`, `classColour`, `license`, `licenceColour`,
`iRating`, `gapS` (unsigned), `ahead`, `isPlayer`, `onPitRoad`.

**Essential Inputs** (`inputs`) — `clutch`, `brake`, `throttle` (each `pct`
0–100, `text` "07", `knob` the cap's lift in px), `speedKph`, `gear` ("N",
"R", "3"), `wheelDeg`, `rpm`.

**Input Telemetry** (`pedals`) — everything in Essential Inputs, plus
`refSpeedKph`, `refGear`, `refGearDiffers` (the reference is in another gear here: a suggestion to shift), `deltaS`, `gaining`, `losing`, `ffbPct`,
`shiftFraction` (0–1 up the shift range), `shifting`.

**Rev Lights** (`revlights`) — `empty`, `rpm`, `shiftFraction`, `shifting`.

**Input Comparison** (`trace`) and **Speed Comparison** (`speed`) — `noReference`.

**Brake Indicator** (`brake`) — `empty`, `fillPct`, `now` (brake now),
`metresToGo`, `boards[]`: `metres`, `at` (% along the bar).

**Delta** (`delta`) — `empty`, `deltaS`, `good`, `bad`, `ahead`, `colour` (the
trend colour: green gaining, red losing), `fraction` (0–1 of a side),
`fillLeft`, `fillWidth`, `fillRadius` (for a centre-out bar).

**Delta Sectors** (`sectors`) — `empty`, `sectors[]`: `name` ("S1"), `number`,
`live`, `timeS`, `deltaS`, `good`, `bad`; `bestLapS`, `lastLapS`, `refLapS`,
`best` and `last` (each `deltaS`, `good`, `bad` against the reference).

**Corner Analysis** (`corners`) — `empty`, `corner` (its number), `done`,
`deltaS`, `good`, `bad`, `apexKph` (your minimum speed minus the reference's),
`apexGain`.

**Comparison Target** (`reference`) — `hasReference`, `lapTimeS`, `carId`, `noteSet`.

**Fuel** (`fuel`) — `empty`, `lap`, `lapsTotal`, `timeRemainS`, `levelL`,
`levelPct`, `level` (0–1), `usedPct`, `lapsLeft`, `perLapL`, `maxLapL`, `usage[]` (`label`,
`perLap`, `ends`), `toFinishL`, `learning`, `hasMargin`, `marginL`, `spare`,
`short`.

**Tyres** (`tyres`) — `empty`, and `lf`, `rf`, `lr`, `rr`: `psi`, `tempC`
("88°"), `tempsC` (outer/centre/inner), `gradient` (a CSS gradient of the
tread's temperatures), `colour` (the tyre as one colour), `wearPct`, `edges`
(`["O","C","I"]` as the car sees them).

**Damage** (`damage`) — `empty`, `repairS`, `optionalS`, `needsRepair`.

**Weather** (`weather`) — `empty`, `skies`, `sky`, `surface`, `airC`, `trackC`,
`humidityPct`, `rainPct`, `windKph`, `windFrom` ("SW"), `windArrowDeg`.

**Track Map** (`map`), **Mini Map** (`minimap`), **Radar** (`radar`) — `empty`
only; the blocks draw from the live data themselves.

**Callouts** (`callouts`) — `empty`, `count`, `events[]`: `text`, `className`
(`play` or `drop`), newest first.

## Example: the gaps either side of you

From the Gran Turismo theme's `templates/standings.html`:

```html
<x-group data-each="playerClass.rows">
  <x-group data-if="isPlayer"><div data-if="intervalS" class="gt-gap">{{ intervalS | signed:3 }}</div></x-group>
  <div class="gt-row" data-class="me: isPlayer; pit: onPitRoad" style="--cls:{{ colour }}">
    <span class="gt-pos">{{ position }}</span>
    <span class="gt-slab"><span class="gt-name">{{ name }}</span></span>
    <span class="gt-lead"><x-group data-if="isPlayer">{{ gapS | signed:3 }}</x-group></span>
  </div>
  <x-group data-if="isPlayer"><div data-if="behindS" class="gt-gap">{{ behindS | neg | signed:3 }}</div></x-group>
</x-group>
```

The built-in themes' own files are in `apps/desktop/static/themes/`, and every
overlay's built-in template is in `apps/desktop/static/panels/`. Both are worth
reading as examples.
