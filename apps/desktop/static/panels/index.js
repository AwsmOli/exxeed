// Every overlay, by id: what renderer.js mounts, and where the theme editor
// finds each one's built-in template (`PANELS[id].template`) to start a
// theme's own from.

import { inputs, pedals, trace, speed, brake, revlights } from "./driving.js";
import { delta, sectors, corners, reference } from "./timing.js";
import { standings, relative, radar, spotter, flags } from "./race.js";
import { map, minimap } from "./track.js";
import { fuel, tyres, damage, weather } from "./car.js";
import { callouts, telemetry } from "./exxeed.js";

export const PANELS = {
  inputs,
  pedals,
  trace,
  speed,
  brake,
  revlights,
  delta,
  sectors,
  corners,
  reference,
  standings,
  relative,
  radar,
  spotter,
  flags,
  map,
  minimap,
  fuel,
  tyres,
  damage,
  weather,
  callouts,
  telemetry,
};

export { blockList } from "./blocks.js";
export { FILTERS } from "../template.js";
