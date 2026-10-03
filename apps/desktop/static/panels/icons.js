// Small inline icons. Drawn here from plain shapes so the overlays need no
// icon font and no image files.

import { numberAttr, registerBlock } from "./blocks.js";

const svg = (w, h, body, extra = "") =>
  `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${body}</svg>`;

/** An H-pattern gate, the "this is a gear" mark. */
export const gearbox = () => svg(12, 12, `<path d="M2 2v8M6 2v8M10 2v8M2 6h8"/>`);

/** A formula-style wheel, seen from the cockpit. */
export const wheel = (size = 34) =>
  svg(
    34,
    22,
    `<path fill="currentColor" stroke="none" d="M6 2h22c3 0 5 2 5 5v4c0 5-3 9-7 9h-2l-2-4h-10l-2 4H8c-4 0-7-4-7-9V7c0-3 2-5 5-5z"/>
     <rect x="11" y="5" width="12" height="7" rx="2" fill="#000" stroke="none" opacity="0.75"/>
     <circle cx="8" cy="9" r="1.4" fill="#000" stroke="none" opacity="0.7"/>
     <circle cx="26" cy="9" r="1.4" fill="#000" stroke="none" opacity="0.7"/>
     <circle cx="14" cy="14.5" r="1" fill="#000" stroke="none" opacity="0.7"/>
     <circle cx="17" cy="14.5" r="1" fill="#000" stroke="none" opacity="0.7"/>
     <circle cx="20" cy="14.5" r="1" fill="#000" stroke="none" opacity="0.7"/>`,
    `style="width:${size}px;height:${(size * 22) / 34}px"`,
  );

export const pump = (size = 18) =>
  svg(
    18,
    20,
    `<rect x="2" y="2" width="9" height="16" rx="2"/><path d="M4.5 6h4"/><path d="M11 8h2.5a1.5 1.5 0 0 1 1.5 1.5V15a1.5 1.5 0 0 0 3 0V7l-3-3"/>`,
    `style="width:${size}px;height:${(size * 20) / 18}px"`,
  );

export const thermometer = () =>
  svg(10, 16, `<path d="M3.5 10V3a1.5 1.5 0 0 1 3 0v7a3 3 0 1 1-3 0z"/>`);

export const droplet = () => svg(12, 16, `<path d="M6 1.5C4 5 2 7.5 2 10a4 4 0 0 0 8 0c0-2.5-2-5-4-8.5z"/>`);

export const lanes = () => svg(14, 12, `<path d="M1 3h12M1 6h12M1 9h12"/>`);

export const disc = (size = 40) =>
  svg(
    40,
    40,
    `<circle cx="20" cy="20" r="15"/><circle cx="20" cy="20" r="6"/><circle cx="20" cy="20" r="2"/>
     <path d="M26 6.5a15 15 0 0 1 8 10" stroke-width="4"/>`,
    `style="width:${size}px;height:${size}px"`,
  );

/** A round steering wheel with a red mark at its top, as the sim's own inputs box draws it. */
export const roundWheel = (size = 40) =>
  svg(
    40,
    40,
    `<circle cx="20" cy="20" r="16.5" stroke-width="3.4"/>
     <circle cx="20" cy="20" r="4.2" fill="currentColor" stroke="none"/>
     <path d="M4.5 22h11M24.5 22h11M20 24v12" stroke-width="3.4"/>
     <path d="M20 2.2v5.6" stroke="#e8262b" stroke-width="3.6"/>`,
    `style="width:${size}px;height:${size}px"`,
  );

/** Sun, sun-and-cloud or cloud, by the sim's sky word. */
export function sky(skies) {
  const sun = `<circle cx="9" cy="8" r="3.5"/><path d="M9 1.5v1.5M2.5 8H4M4.4 3.4l1 1M13.6 3.4l-1 1"/>`;
  const cloud = `<path d="M6 17h9a3.5 3.5 0 0 0 0-7 5 5 0 0 0-9.3 1.2A3 3 0 0 0 6 17z"/>`;
  const body = skies === "clear" ? sun : skies === "partly cloudy" ? sun + cloud : cloud;
  return svg(20, 19, body);
}

// ---------------------------------------------------------------------------
// The icons as a building block for templates (blocks.js):
//
//   <x-icon name="pump" size="26"></x-icon>
//   <x-icon name="sky" of="{{ skies }}"></x-icon>
// ---------------------------------------------------------------------------

const ICONS = { gearbox, wheel, "round-wheel": roundWheel, pump, thermometer, droplet, lanes, disc, sky };

registerBlock(
  "x-icon",
  {
    summary: "A small line icon in the text colour.",
    attributes: {
      name: Object.keys(ICONS).join(" | "),
      size: "pixels, for wheel, round-wheel, pump and disc",
      of: "for sky: the sky's state (clear, partly cloudy, mostly cloudy, overcast)",
    },
  },
  (el) => {
    let drawn = null;
    return {
      paint() {
        const name = el.getAttribute("name") ?? "";
        const key = `${name}|${el.getAttribute("size")}|${el.getAttribute("of")}`;
        if (key === drawn) return;
        drawn = key;
        const icon = ICONS[name];
        if (icon === undefined) {
          el.replaceChildren();
          return;
        }
        // Our own markup, from the functions above — never the template's text.
        el.innerHTML = name === "sky" ? icon(el.getAttribute("of") ?? "") : icon(numberAttr(el, "size", undefined));
      },
    };
  },
);
