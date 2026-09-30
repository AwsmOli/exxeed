// The Content tab (M8): VS Code's Extensions view for callout packs. Search and
// filters on the left, the selected pack's page on the right. Main answers
// every question (content.ts); installs go through the library (library.ts),
// the same path as Track Coach's install field.

import { marked } from "./vendor/marked.esm.js";
import DOMPurify from "./vendor/purify.es.mjs";

const el = (id) => document.getElementById(id);
const SVG = "http://www.w3.org/2000/svg";

const make = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
};

const ask = async (channel, request) => {
  const response = await window.exxeed[channel](request);
  if (!response.ok) throw new Error(response.error);
  return response.value;
};
const content = (request) => ask("content", request);
const library = (request) => ask("library", request);

const state = {
  facets: null,
  rows: [],
  offset: 0,
  selected: null,
  page: null,
  tab: "details",
  loading: false,
};

const setStatus = (text, bad = false) => {
  el("c-status").textContent = text;
  el("c-status").className = `c-status${bad ? " bad" : ""}`;
};

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const date = (iso) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

// -- Filters ------------------------------------------------------------------

const keyOf = (k) => (k === null ? "" : `${k.sim}:${k.trackId}:${k.configId}`);
const parseKey = (v) => {
  if (v === "") return null;
  const [sim, trackId, configId] = v.split(":");
  return { sim, trackId: Number(trackId), configId };
};

function filters() {
  return {
    text: el("c-search").value,
    trackKey: parseKey(el("c-track").value),
    carClass: el("c-class").value || null,
    starred: el("c-starred").checked,
    installed: el("c-installed").checked,
    sort: el("c-sort").value,
  };
}

async function loadFacets() {
  try {
    state.facets = await content({ op: "facets" });
  } catch (err) {
    setStatus(`Content is unreachable: ${err.message}`, true);
    return;
  }
  const track = el("c-track");
  const keep = track.value;
  track.replaceChildren(
    make("option", { value: "", textContent: "Any track" }),
    ...state.facets.layouts.map((l) => make("option", { value: keyOf(l.trackKey), textContent: l.label })),
  );
  track.value = keep;
  const cls = el("c-class");
  const keepClass = cls.value;
  cls.replaceChildren(
    make("option", { value: "", textContent: "Any car class" }),
    ...state.facets.carClasses.map((c) => make("option", { value: c.id, textContent: c.name })),
  );
  cls.value = keepClass;
  el("c-starred").disabled = !state.facets.signedIn;
  el("c-starred").parentElement.title = state.facets.signedIn ? "" : "Sign in to star packs";
}

// -- Results --------------------------------------------------------------------

/** The pack's icon, or its initials when it has none. */
function icon(row, big = false) {
  if (row.iconUrl) {
    const img = make("img", { className: `c-icon${big ? " big" : ""}`, src: row.iconUrl, alt: "" });
    img.addEventListener("error", () => img.replaceWith(initials(row, big)));
    return img;
  }
  return initials(row, big);
}

const initials = (row, big) =>
  make("span", {
    className: `c-icon${big ? " big" : ""}`,
    textContent: row.title.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join(""),
  });

/** Install / Update / Installed, as the row and the page both show it. */
function installButton(row) {
  const local = row.local;
  if (local?.origin === "mine") return make("span", { className: "chip", textContent: "yours" });
  if (local?.origin === "installed") {
    const behind = row.latestVersion !== null && local.version !== null && row.latestVersion > local.version;
    if (!behind) return make("span", { className: "chip", textContent: `v${local.version} installed` });
    const update = make("button", { className: "ghost primary", textContent: `Update to v${row.latestVersion}`, type: "button" });
    update.addEventListener("click", (e) => {
      e.stopPropagation();
      void install(row.id, update);
    });
    return update;
  }
  const b = make("button", { className: "ghost primary", textContent: "Install", type: "button" });
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    void install(row.id, b);
  });
  return b;
}

function resultRow(row) {
  const li = make(
    "li",
    { className: row.id === state.selected ? "selected" : "" },
    icon(row),
    make(
      "div",
      {},
      make("div", { className: "c-title", textContent: row.title }),
      make("div", { className: "c-meta", textContent: `${row.authorName} · ${row.trackLabel}${row.carClass ? ` · ${row.carClass.toUpperCase()}` : ""}` }),
      make("div", { className: "c-summary", textContent: row.summary }),
      make(
        "div",
        { className: "c-line" },
        make("span", { className: "c-meta", textContent: `★ ${row.stars} · ${row.downloads} ↓ · v${row.latestVersion}` }),
        installButton(row),
      ),
    ),
  );
  li.addEventListener("click", () => void select(row.id));
  return li;
}

function renderResults() {
  el("c-results").replaceChildren(...state.rows.map(resultRow));
  if (state.rows.length === 0 && !state.loading) {
    const f = filters();
    const narrowed = f.text !== "" || f.trackKey !== null || f.carClass !== null || f.starred || f.installed;
    el("c-results").append(
      make("li", { className: "c-empty", textContent: narrowed ? "Nothing matches. Try fewer filters." : "No packs published yet." }),
    );
  }
}

let searchTimer = null;
async function search(reset = true) {
  if (reset) {
    state.offset = 0;
    state.rows = [];
  }
  state.loading = true;
  setStatus("Searching…");
  try {
    const rows = await content({ op: "browse", filters: filters(), offset: state.offset });
    state.rows = reset ? rows : [...state.rows, ...rows];
    state.offset += rows.length;
    el("c-more").hidden = rows.length < 30;
    setStatus(state.rows.length === 0 ? "" : plural(state.rows.length, "pack"));
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    state.loading = false;
    renderResults();
  }
}

// -- The page -------------------------------------------------------------------

async function select(itemId) {
  state.selected = itemId;
  renderResults();
  el("c-page").replaceChildren(make("div", { className: "c-empty", textContent: "Loading…" }));
  try {
    state.page = await content({ op: "page", itemId });
    renderPage();
  } catch (err) {
    el("c-page").replaceChildren(make("div", { className: "c-empty", textContent: err.message }));
  }
}

async function install(itemId, button, versionId) {
  if (button) button.disabled = true;
  setStatus("Installing…");
  try {
    const message = await library({ op: "install", ref: itemId, ...(versionId ? { versionId } : {}) });
    setStatus(message);
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    if (button) button.disabled = false;
    await refreshAfterChange(itemId);
  }
}

async function refreshAfterChange(itemId) {
  await search(true);
  if (state.selected === itemId) await select(itemId);
}

function markdown(text) {
  const html = DOMPurify.sanitize(marked.parse(text, { async: false }), {
    // No forms, frames or styles from a stranger; links and images only over
    // https, and the window's CSP limits images to our own storage besides.
    FORBID_TAGS: ["style", "form", "input", "button", "iframe", "object", "embed"],
    FORBID_ATTR: ["style"],
    ALLOWED_URI_REGEXP: /^https:/i,
  });
  const box = make("div", { className: "c-readme" });
  box.innerHTML = html;
  for (const a of box.querySelectorAll("a[href]")) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      void content({ op: "openExternal", url: a.href }).catch((err) => setStatus(err.message, true));
    });
  }
  return box;
}

function starButton(page) {
  const b = make("button", {
    className: `ghost star${page.starred ? " on" : ""}`,
    type: "button",
    textContent: `${page.starred ? "★ Starred" : "☆ Star"} · ${page.stars}`,
    disabled: !state.facets?.signedIn,
    title: state.facets?.signedIn ? "" : "Sign in to star packs",
  });
  b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      const stars = await content({ op: "star", itemId: page.id, on: !page.starred });
      state.page = { ...page, starred: !page.starred, stars };
      renderPage();
      const row = state.rows.find((r) => r.id === page.id);
      if (row) Object.assign(row, { starred: state.page.starred, stars });
      renderResults();
    } catch (err) {
      setStatus(err.message, true);
      b.disabled = false;
    }
  });
  return b;
}

function actions(page) {
  const box = make("div", { className: "c-actions" }, installButton(page), starButton(page));

  if (page.local?.origin === "installed") {
    const picker = make("select", { title: "Install another version and stay on it" });
    picker.append(
      make("option", { value: "", textContent: "Other version…" }),
      ...page.versions
        .filter((v) => !v.withdrawn && v.version !== page.local.version)
        .map((v) => make("option", { value: v.id, textContent: `v${v.version}${v.version === page.latestVersion ? " (latest)" : ""}` })),
    );
    picker.addEventListener("change", () => {
      if (picker.value !== "") void install(page.id, picker, picker.value);
    });
    const uninstall = make("button", { className: "ghost", type: "button", textContent: "Uninstall" });
    uninstall.addEventListener("click", async () => {
      if (uninstall.dataset.armed !== "1") {
        uninstall.dataset.armed = "1";
        uninstall.textContent = "Really uninstall?";
        return;
      }
      try {
        setStatus(await library({ op: "uninstall", noteSetId: page.local.noteSetId }));
      } catch (err) {
        setStatus(err.message, true);
      }
      await refreshAfterChange(page.id);
    });
    box.append(picker, uninstall);
  }

  const share = make("button", { className: "ghost", type: "button", textContent: "Copy link" });
  share.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(page.shareLink);
      share.textContent = "Link copied";
    } catch {
      share.textContent = page.shareLink;
    }
    setTimeout(() => (share.textContent = "Copy link"), 2500);
  });
  box.append(share);
  return box;
}

function mapSvg(page) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 1000 1000");
  svg.setAttribute("class", "c-map");
  const map = page.map;
  const P = (i) => [40 + map.x[i] * 920, 40 + map.y[i] * 920];
  const step = Math.max(1, Math.floor(map.x.length / 600));
  let d = "";
  for (let i = 0; i < map.x.length; i += step) {
    const [x, y] = P(i);
    d += `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }
  const road = document.createElementNS(SVG, "path");
  road.setAttribute("d", `${d}Z`);
  road.setAttribute("class", "road");
  svg.append(road);

  const [sx, sy] = P(map.startIndex);
  const sf = document.createElementNS(SVG, "rect");
  Object.entries({ x: sx - 7, y: sy - 7, width: 14, height: 14, class: "sf" }).forEach(([k, v]) => sf.setAttribute(k, String(v)));
  svg.append(sf);

  const textOf = new Map(page.callouts.map((c) => [c.id, c.text]));
  for (const note of map.notes) {
    const [x, y] = P(note.index);
    const dot = document.createElementNS(SVG, "circle");
    dot.setAttribute("cx", x.toFixed(1));
    dot.setAttribute("cy", y.toFixed(1));
    dot.setAttribute("r", "11");
    dot.setAttribute("class", "pt");
    const title = document.createElementNS(SVG, "title");
    title.textContent = textOf.get(note.id) ?? "";
    dot.append(title);
    svg.append(dot);
  }
  return svg;
}

function tabBody(page) {
  switch (state.tab) {
    case "details": {
      const box = make("div", {}, page.readme.trim() === "" ? make("p", { className: "c-meta", textContent: "No description." }) : markdown(page.readme));
      if (page.screenshots.length > 0) {
        box.append(
          make(
            "div",
            { className: "c-shots" },
            ...page.screenshots.map((url, i) => {
              const img = make("img", { src: url, alt: "", loading: "lazy" });
              img.addEventListener("click", () => openLightbox(page.screenshots, i));
              return img;
            }),
          ),
        );
      }
      return box;
    }
    case "callouts":
      return make(
        "ol",
        { className: "c-callouts" },
        ...page.callouts.map((c) =>
          make(
            "li",
            {},
            make("span", { className: "m", textContent: `${c.metresFromStart} m` }),
            make("div", {}, make("div", { textContent: c.text }), make("div", { className: "short", textContent: `Short: ${c.textShort}` })),
          ),
        ),
      );
    case "map":
      return page.map === null
        ? make("p", { className: "c-meta", textContent: "No map of this track has been shared yet. It appears after someone drives it with Exxeed signed in." })
        : make("div", {}, mapSvg(page), make("p", { className: "c-meta", textContent: "Hover a point to read its callout. The orange square is the start/finish line." }));
    case "changelog":
      return make(
        "div",
        { className: "c-changelog" },
        ...page.versions.map((v) =>
          make(
            "div",
            { className: `v${v.withdrawn ? " withdrawn" : ""}` },
            make("strong", { textContent: `v${v.version}` }),
            make("span", { className: "c-meta", textContent: ` · ${date(v.publishedAt)}${v.withdrawn ? " · withdrawn by the author" : ""}` }),
            v.changelog ? make("div", { textContent: v.changelog }) : null,
            v.changes.length > 0 ? make("ul", {}, ...v.changes.map((c) => make("li", { textContent: c }))) : null,
            v.version === 1 && !v.changelog ? make("div", { className: "c-meta", textContent: "First release" }) : null,
          ),
        ),
      );
    default:
      return make("div");
  }
}

function facts(page) {
  const f = page.facts;
  const dl = make("dl", { className: "c-facts" });
  const add = (label, value) => value !== null && value !== undefined && value !== "" && dl.append(make("div", {}, make("dt", { textContent: label }), make("dd", {}, value)));
  add("Track", page.trackLabel);
  add("Car class", page.carClass?.toUpperCase());
  add("Callouts", String(f.callouts));
  add("Author", page.authorName);
  add("Published", f.publishedAt ? date(f.publishedAt) : null);
  add("Updated", date(page.updatedAt));
  add("Map", f.mapVersion === null ? "not shared yet" : `v${f.mapVersion}`);
  if (f.source !== null) {
    const link = make("a", { href: "#", textContent: f.source.title ?? "Source video" });
    link.addEventListener("click", (e) => {
      e.preventDefault();
      if (f.source.url) void content({ op: "openExternal", url: f.source.url }).catch((err) => setStatus(err.message, true));
    });
    add("Adapted from", make("span", {}, link, f.source.channel ? ` by ${f.source.channel}` : ""));
  }
  return dl;
}

function renderPage() {
  const page = state.page;
  if (page === null) return;
  const tabs = make(
    "div",
    { className: "c-tabs" },
    ...[
      ["details", "Details"],
      ["callouts", `Callouts (${page.callouts.length})`],
      ["map", "Map"],
      ["changelog", `Changelog (${page.versions.length})`],
    ].map(([id, label]) => {
      const b = make("button", { type: "button", textContent: label, className: state.tab === id ? "on" : "" });
      b.addEventListener("click", () => {
        state.tab = id;
        renderPage();
      });
      return b;
    }),
  );

  el("c-page").replaceChildren(
    make(
      "div",
      { className: "c-head" },
      icon(page, true),
      make(
        "div",
        {},
        make("h1", { textContent: page.title }),
        make("div", { className: "c-byline", textContent: `by ${page.authorName} · ${page.trackLabel}${page.carClass ? ` · ${page.carClass.toUpperCase()}` : ""}` }),
        make(
          "div",
          { className: "c-stats" },
          make("span", { textContent: `★ ${page.stars}` }),
          make("span", { textContent: `${page.downloads} downloads` }),
          make("span", { textContent: `v${page.latestVersion}` }),
          make("span", { textContent: `updated ${date(page.updatedAt)}` }),
        ),
        page.summary ? make("div", { className: "c-summary", textContent: page.summary }) : null,
        make("div", { style: "height:10px" }),
        actions(page),
      ),
    ),
    tabs,
    make("div", { className: "c-body" }, make("div", {}, tabBody(page)), facts(page)),
  );
}

// -- Lightbox -------------------------------------------------------------------

let lightbox = { urls: [], index: 0 };
function openLightbox(urls, index) {
  lightbox = { urls, index };
  el("lightbox-img").src = urls[index];
  el("lightbox").hidden = false;
}
el("lightbox").addEventListener("click", () => (el("lightbox").hidden = true));
document.addEventListener("keydown", (e) => {
  if (el("lightbox").hidden) return;
  if (e.key === "Escape") el("lightbox").hidden = true;
  if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
    const n = lightbox.urls.length;
    lightbox.index = (lightbox.index + (e.key === "ArrowRight" ? 1 : n - 1)) % n;
    el("lightbox-img").src = lightbox.urls[lightbox.index];
  }
});

// -- Opening pre-filtered ---------------------------------------------------------

/**
 * The one way in with filters set: the session banner, Track Coach's "Find in
 * Content", and later share links. `{ trackKey, carClass }` from anywhere.
 */
document.addEventListener("open-content", async (e) => {
  const { trackKey = null, carClass = null } = e.detail ?? {};
  // The menus first, or their first load would reset the filters set below.
  if (!loaded) {
    loaded = true;
    await loadFacets();
  }
  el("c-search").value = "";
  el("c-starred").checked = false;
  el("c-installed").checked = false;
  el("c-track").value = keyOf(trackKey);
  // A layout the catalog did not list yet: add it, so the filter still holds.
  if (trackKey !== null && el("c-track").value === "") {
    el("c-track").append(make("option", { value: keyOf(trackKey), textContent: `Track ${trackKey.trackId}` }));
    el("c-track").value = keyOf(trackKey);
  }
  el("c-class").value = carClass ?? "";
  document.querySelector('.section-btn[data-section="content"]')?.click();
  void search(true);
});

// -- Wiring -------------------------------------------------------------------------

el("c-search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void search(true), 250);
});
for (const id of ["c-track", "c-class", "c-starred", "c-installed", "c-sort"]) {
  el(id).addEventListener("change", () => void search(true));
}
el("c-more").addEventListener("click", () => void search(false));

// First visit loads; later visits keep where you were.
let loaded = false;
document.querySelector('.section-btn[data-section="content"]')?.addEventListener("click", () => {
  if (loaded) return;
  loaded = true;
  void loadFacets().then(() => search(true));
});

// Signing in or out changes starring and the Starred filter.
window.exxeed?.onAccountChanged?.(() => {
  if (loaded) void loadFacets();
});
