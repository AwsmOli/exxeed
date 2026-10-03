// Building blocks: the parts of an overlay drawn in code — charts, maps,
// gauges, icons — that a template places like any other element:
//
//   <div class="graph"><x-timeline seconds="8"></x-timeline></div>
//
// A block fills the box it is put in; the template and the theme's stylesheet
// decide where that is and how big. Its attributes are its options. Each
// panel file registers the blocks it owns; templated.js paints every block in
// a panel on every frame, with the shared state and the panel's model data.

const BLOCKS = new Map();

/**
 * `create(el)` is called once per element and returns `{ paint(s, data) }`.
 * `about` describes the block and its attributes, for theme authors.
 */
export function registerBlock(tag, about, create) {
  BLOCKS.set(tag, { about, create });
}

/** Every block, for the theme documentation and the editor's completions. */
export function blockList() {
  return [...BLOCKS.entries()].map(([tag, b]) => ({ tag, ...b.about }));
}

const instances = new WeakMap();
const reported = new Set();

/** Paint every block inside `root`. */
export function paintBlocks(root, s, data) {
  if (BLOCKS.size === 0) return;
  for (const el of root.querySelectorAll([...BLOCKS.keys()].join(","))) {
    let block = instances.get(el);
    if (block === undefined) {
      block = BLOCKS.get(el.localName).create(el);
      instances.set(el, block);
    }
    try {
      block.paint(s, data);
    } catch (err) {
      // One broken block must not take the panel with it, and should say so once.
      if (!reported.has(el.localName)) {
        reported.add(el.localName);
        console.error(`${el.localName}: ${err?.stack ?? err}`);
      }
    }
  }
}

/** A canvas filling the block, made on first use. */
export function canvasIn(el) {
  let canvas = el.querySelector(":scope > canvas");
  if (canvas === null) {
    canvas = document.createElement("canvas");
    canvas.className = "fill";
    el.append(canvas);
  }
  return canvas;
}

/** A numeric attribute, or the fallback when missing or not a number. */
export function numberAttr(el, name, fallback) {
  const v = Number(el.getAttribute(name));
  return el.hasAttribute(name) && Number.isFinite(v) ? v : fallback;
}
