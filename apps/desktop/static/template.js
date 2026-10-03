// Overlay templates: how a theme changes what an overlay is built from, not
// just its colours.
//
// An overlay is two halves. Its *model* (JS, in ./panels/) works out what to
// show — the rows of the standings, the gap to the car ahead — as plain data.
// Its *template* (HTML, here) says how that data is laid out. The built-in
// templates live beside the models; a theme can replace any of them, so a
// Gran Turismo theme can put the gap on a line of its own between two rows
// and a RaceLab one can hang the class name off a tab — from the same data.
//
// Templates are declarative and contain no code: themes are downloaded from
// strangers. What a template can say:
//
//   {{ path }}                  text of a value, in text or in an attribute
//   {{ path | filter:arg }}     ...formatted (FILTERS below)
//   data-if="path"              the element only while the value is truthy
//   data-if="!path"             ...or falsy
//   data-each="rows"            the element once per item; inside it, names
//                               look in the item first, then outwards.
//                               {{ . }} is the item itself; $index, $first,
//                               $last and $count are set too.
//   data-each="r in rows"       ...with the item named, as {{ r.name }}
//   data-class="me: isPlayer; pit: onPitRoad"
//                               classes switched on by values
//   <x-group>                   a wrapper that takes no room (display:
//                               contents), to repeat or hide several siblings
//   <x-trace>, <x-sweep>, …     building blocks drawn in code — the charts,
//                               maps and gauges — placed and sized by the
//                               template like any other element
//
// Everything is sanitized before use (DOMPurify): no scripts, no event
// handlers, no links or forms. Values are only ever written as text or as an
// attribute's value, never parsed as HTML.

import DOMPurify from "./vendor/purify.es.mjs";
import { clock, irating, lapTime, signed } from "./panels/util.js";

/** Formatters a template can pipe a value through. */
export const FILTERS = {
  lapTime: (v) => lapTime(v),
  /** "0:11.113": a lap time that always carries the minute, as a timing screen writes a sector. */
  sectorTime: (v) => {
    if (typeof v !== "number" || !(v > 0)) return "—";
    const m = Math.floor(v / 60);
    return `${m}:${(v - m * 60).toFixed(3).padStart(6, "0")}`;
  },
  clock: (v) => clock(v),
  irating: (v) => irating(v),
  /** "+0.533", always signed. Digits default to 1. */
  signed: (v, digits = "1") => (typeof v === "number" ? signed(v, Number(digits)) : ""),
  /** "+13.8" for a gap behind; nothing for none. */
  gap: (v, digits = "1") => (typeof v === "number" ? `+${Math.max(0, v).toFixed(Number(digits))}` : ""),
  fixed: (v, digits = "0") => {
    const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
    return typeof n === "number" && Number.isFinite(n) ? n.toFixed(Number(digits)) : "";
  },
  abs: (v) => (typeof v === "number" ? Math.abs(v) : v),
  neg: (v) => (typeof v === "number" ? -v : v),
  pct: (v) => (typeof v === "number" ? `${Math.round(v * 100)}%` : ""),
  upper: (v) => String(v ?? "").toUpperCase(),
  lower: (v) => String(v ?? "").toLowerCase(),
  /** The first word: "A 4.12" → "A". */
  first: (v) => String(v ?? "").split(/\s+/)[0] ?? "",
  /** A 0–100 value as a share of an arc that is `of` long: {{ revPct | ringOf:75 }} for a three-quarter ring. */
  ringOf: (v, of = "100") => (typeof v === "number" ? ((v / 100) * Number(of)).toFixed(1) : "0"),
  /** The nth word, from 0: {{ license | word:1 }} is the safety rating of "B 4.62". */
  word: (v, n = "0") => String(v ?? "").split(/\s+/)[Number(n)] ?? "",
  /** The first letter. */
  initial: (v) => String(v ?? "").charAt(0),
  /** A fallback for an empty value: {{ sof | or:— }}. */
  or: (v, fallback = "") => (v === null || v === undefined || v === "" ? fallback : v),
  /** Text when the value is truthy: {{ isPlayer | then:YOU }}. */
  then: (v, text = "") => (v ? text : ""),
  pad: (v, width = "2") => String(v ?? "").padStart(Number(width), "0"),
};

/** Attributes a bound value may never be written to, whatever the template says. */
const UNSAFE_ATTR = /^(on|href$|src$|srcset$|action$|formaction$|xlink:href$|srcdoc$)/i;

const PURIFY = {
  FORBID_TAGS: ["style", "script", "a", "form", "input", "button", "textarea", "select", "option", "iframe", "object", "embed", "link", "meta", "base", "img", "video", "audio", "source", "use", "foreignObject", "image"],
  FORBID_ATTR: ["href", "xlink:href", "src", "srcset", "action", "formaction", "id"],
  ALLOW_DATA_ATTR: true,
  CUSTOM_ELEMENT_HANDLING: {
    tagNameCheck: /^x-[a-z][a-z0-9-]*$/,
    attributeNameCheck: /^[a-z][a-z0-9-]*$/,
    allowCustomizedBuiltInElements: false,
  },
  RETURN_DOM_FRAGMENT: true,
};

/** A template's text as a clean fragment: what is left once anything active is taken out. */
export function sanitize(markup) {
  return DOMPurify.sanitize(String(markup), PURIFY);
}

// ---------------------------------------------------------------------------
// Expressions: a path, maybe negated, maybe piped through filters.
// ---------------------------------------------------------------------------

const cache = new Map();

function parseExpression(text) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const [head, ...pipes] = text.split("|").map((p) => p.trim());
  const negate = head.startsWith("!");
  const path = (negate ? head.slice(1) : head).trim();
  const filters = pipes.map((p) => {
    const at = p.indexOf(":");
    const name = (at < 0 ? p : p.slice(0, at)).trim();
    const arg = at < 0 ? undefined : p.slice(at + 1).trim();
    return { fn: FILTERS[name] ?? null, name, arg };
  });
  // A quoted string is a literal, for {{ 'POSITION' }} style constants.
  const literal = /^'.*'$/.test(path) ? path.slice(1, -1) : undefined;
  // "." is the item itself, inside data-each: {{ . }} for a list of strings.
  const keys = path === "." ? ["$item"] : path === "" ? [] : path.split(".");
  const parsed = { negate, keys, filters, literal };
  cache.set(text, parsed);
  return parsed;
}

function lookup(scopes, keys) {
  if (keys.length === 0) return scopes[0];
  for (const scope of scopes) {
    if (scope !== null && typeof scope === "object" && keys[0] in scope) {
      let v = scope;
      for (const k of keys) {
        if (v === null || v === undefined) return undefined;
        v = v[k];
      }
      return v;
    }
  }
  return undefined;
}

function evaluate(scopes, text) {
  const e = parseExpression(text);
  let v = e.literal !== undefined ? e.literal : lookup(scopes, e.keys);
  for (const f of e.filters) if (f.fn !== null) v = f.fn(v, f.arg);
  return e.negate ? !v : v;
}

const MUSTACHE = /\{\{([^}]*)\}\}/g;

function interpolate(scopes, text) {
  return text.replace(MUSTACHE, (_, expr) => {
    const v = evaluate(scopes, expr);
    return v === null || v === undefined || v === false ? "" : String(v);
  });
}

// ---------------------------------------------------------------------------
// Compile: walk a sanitized fragment once, and keep a list of what changes.
// An instance updates those bindings in place, so the DOM a template makes is
// built once and then only touched where a value moved — a row is not rebuilt
// because the gap in it ticked.
// ---------------------------------------------------------------------------

/** `node` cloned and bound. Returns { node, update(scopes) }. */
function instantiate(source) {
  const node = source.cloneNode(true);
  const bindings = [];
  bind(node, bindings);
  return {
    node,
    update(scopes) {
      for (const b of bindings) b(scopes);
    },
  };
}

function bind(node, bindings) {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent;
    if (text.includes("{{")) {
      bindings.push((scopes) => {
        const next = interpolate(scopes, text);
        if (node.textContent !== next) node.textContent = next;
      });
    }
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node;

  if (el.hasAttribute("data-each")) return bindEach(el, bindings);
  if (el.hasAttribute("data-if")) return bindIf(el, bindings);

  for (const attr of [...el.attributes]) {
    if (attr.name === "data-class" || !attr.value.includes("{{") || UNSAFE_ATTR.test(attr.name)) continue;
    const name = attr.name;
    const text = attr.value;
    bindings.push((scopes) => {
      const next = interpolate(scopes, text);
      if (el.getAttribute(name) !== next) el.setAttribute(name, next);
    });
  }
  // After the attributes, so a bound class="…" is written first and the
  // switched classes go on top of it.
  const switched = el.getAttribute("data-class");
  if (switched !== null) {
    const pairs = switched
      .split(";")
      .map((p) => p.split(":").map((s) => s.trim()))
      .filter(([name, expr]) => name && expr);
    el.removeAttribute("data-class");
    bindings.push((scopes) => {
      for (const [name, expr] of pairs) el.classList.toggle(name, Boolean(evaluate(scopes, expr)));
    });
  }
  for (const child of [...el.childNodes]) bind(child, bindings);
}

/** data-if: the element, or a placeholder where it would be. */
function bindIf(el, bindings) {
  const expr = el.getAttribute("data-if");
  el.removeAttribute("data-if");
  const anchor = document.createComment(`if ${expr}`);
  el.replaceWith(anchor);
  let shown = null;
  bindings.push((scopes) => {
    if (evaluate(scopes, expr)) {
      if (shown === null) {
        shown = instantiate(el);
        anchor.after(shown.node);
      }
      shown.update(scopes);
    } else if (shown !== null) {
      shown.node.remove();
      shown = null;
    }
  });
}

/** data-each: one bound copy per item, reused by position as the list changes. */
function bindEach(el, bindings) {
  const spec = el.getAttribute("data-each");
  el.removeAttribute("data-each");
  const named = /^\s*([A-Za-z_$][\w$]*)\s+in\s+(.+)$/.exec(spec);
  const alias = named ? named[1] : null;
  const listExpr = named ? named[2] : spec;
  const anchor = document.createComment(`each ${spec}`);
  el.replaceWith(anchor);
  const copies = [];
  bindings.push((scopes) => {
    const list = evaluate(scopes, listExpr);
    const items = Array.isArray(list) ? list : [];
    while (copies.length > items.length) copies.pop().node.remove();
    while (copies.length < items.length) {
      const copy = instantiate(el);
      (copies.at(-1)?.node ?? anchor).after(copy.node);
      copies.push(copy);
    }
    items.forEach((item, i) => {
      const meta = { $item: item, $index: i, $first: i === 0, $last: i === items.length - 1, $count: items.length };
      const own = alias !== null ? { [alias]: item, ...meta } : meta;
      copies[i].update(alias !== null ? [own, ...scopes] : [own, item, ...scopes]);
    });
  });
}

/**
 * A template ready to render: `mount()` gives its root element and an
 * `update(data)` that brings it up to date with the model's data.
 * Throws when the template has no root element, so a broken theme template
 * can be reported and the built-in used instead.
 */
export function compile(markup) {
  const fragment = sanitize(markup);
  const root = [...fragment.childNodes].find((n) => n.nodeType === Node.ELEMENT_NODE);
  if (root === undefined) throw new Error("the template has no element in it");
  return {
    mount() {
      const instance = instantiate(root);
      return { el: instance.node, update: (data) => instance.update([data]) };
    },
  };
}
