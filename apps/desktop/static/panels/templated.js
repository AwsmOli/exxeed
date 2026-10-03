// A panel made of a model and a template (../template.js): the model turns
// the shared state into plain data, the template lays that data out. The
// built-in template is the panel's own; a theme can hand in another.

import { compile } from "../template.js";

/**
 * `model(state)` returns the data the template reads. `deps` are the
 * `state.v` counters that mean the data may have changed — a panel off the
 * race channel only needs redoing when a race update arrives — and `rate`
 * caps how often it is redone, in ms. No deps: every paint.
 */
export function templated({ template, model, deps = [], rate = 0, frame }) {
  return (override = null) => {
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

    let at = -Infinity;
    let seen = "";
    return {
      el: view.el,
      frame,
      draw(s) {
        const now = performance.now();
        if (now - at < rate) return;
        if (deps.length > 0) {
          const key = deps.map((d) => s.v[d]).join(":");
          // Once a second regardless, for what has no counter (the session's phase).
          if (key === seen && now - at < 1000) return;
          seen = key;
        }
        at = now;
        view.update(model(s));
      },
    };
  };
}
