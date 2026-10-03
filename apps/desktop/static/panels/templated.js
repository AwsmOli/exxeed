// A panel made of a model and a template (../template.js): the model turns
// the shared state into plain data, the template lays that data out, and the
// building blocks in it (blocks.js) draw what HTML cannot. The built-in
// template is the panel's own; a theme can hand in another.

import { compile } from "../template.js";
import { paintBlocks } from "./blocks.js";
// Registers <x-icon>, which any template may use.
import "./icons.js";

/**
 * `model(state, local)` returns the data the template reads. `local` is this
 * panel's own memory, from `local()` — for panels that track something across
 * frames, such as the sector being driven — and `frame(state, local)` is
 * called for every telemetry frame, not just every paint.
 *
 * `deps` are the `state.v` counters that mean the data may have changed — a
 * panel off the race channel only needs redoing when a race update arrives —
 * and `rate` caps how often it is redone, in ms. No deps: every paint.
 * Blocks are painted every paint regardless.
 */
export function templated({ template, model, local = () => ({}), frame = null, deps = [], rate = 0 }) {
  const make = (override = null) => {
    let compiled = null;
    if (override !== null) {
      try {
        compiled = compile(override);
      } catch (err) {
        console.error(`theme template: ${err?.message ?? err} — using the built-in one`);
      }
    }
    compiled ??= compile(template);
    const view = compiled.mount();
    const mine = local();

    let at = -Infinity;
    let seen = "";
    let data = null;
    return {
      el: view.el,
      frame: frame === null ? undefined : (s) => frame(s, mine),
      draw(s) {
        const now = performance.now();
        let due = now - at >= rate;
        if (due && deps.length > 0) {
          const key = deps.map((d) => s.v[d]).join(":");
          // Once a second regardless, for what has no counter (the session's phase).
          due = key !== seen || now - at >= 1000;
          seen = key;
        }
        if (due || data === null) {
          at = now;
          data = model(s, mine);
          view.update(data);
          // What the template was given, for a theme author in the overlay's
          // developer tools (Inspect in the theme editor): type overlayData.
          window.overlayData = data;
        }
        paintBlocks(view.el, s, data);
      },
    };
  };
  make.template = template;
  return make;
}
