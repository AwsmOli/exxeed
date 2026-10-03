// Themes in the Content tab (M9): the same list-and-page as callout packs,
// for overlay themes. content.js owns the tab and hands over when "Themes" is
// picked; main answers through theme-content.ts.

const ask = async (request) => {
  const response = await window.exxeed.themeContent(request);
  if (!response.ok) throw new Error(response.error);
  return response.value;
};

/**
 * `ui` is content.js's own helpers (make, el, markdown, lightbox, status…), so
 * both kinds of content are built from the same parts and look the same.
 */
export function createThemes(ui) {
  const { el, make, setStatus, plural, date, markdown, openLightbox, star, signedIn } = ui;
  const state = { rows: [], offset: 0, selected: null, page: null, tab: "details", loading: false };

  const filters = () => ({
    text: el("c-search").value,
    sort: el("c-sort").value,
    starred: el("c-starred").checked,
    installed: el("c-installed").checked,
  });

  const initials = (row, big) =>
    make("div", { className: `c-icon${big ? " big" : ""}`, textContent: row.title.slice(0, 2).toUpperCase() });
  const icon = (row, big = false) =>
    row.iconUrl ? make("img", { className: `c-icon${big ? " big" : ""}`, src: row.iconUrl, alt: "" }) : initials(row, big);

  function useButton(row) {
    if (row.inUse) return make("span", { className: "chip", textContent: "In use" });
    const update = row.local?.origin === "installed" && row.latestVersion !== null && row.latestVersion > row.local.version;
    const label = row.local === null ? "Install" : update ? `Update to v${row.latestVersion}` : "Use";
    const b = make("button", { className: "ghost primary", textContent: label, type: "button" });
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
        make(
          "div",
          { className: "c-title" },
          row.title,
          row.visibility !== "public" ? make("span", { className: "chip vis", textContent: row.visibility }) : null,
        ),
        make("div", { className: "c-meta", textContent: `${row.authorName} · overlay theme` }),
        make("div", { className: "c-summary", textContent: row.summary }),
        make(
          "div",
          { className: "c-line" },
          make("span", { className: "c-meta", textContent: `★ ${row.stars} · ${row.downloads} ↓ · v${row.latestVersion}` }),
          useButton(row),
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
      const narrowed = f.text !== "" || f.starred || f.installed;
      el("c-results").append(
        make("li", {
          className: "c-empty",
          textContent: narrowed
            ? "Nothing matches. Try fewer filters."
            : "No themes yet. Make one in the Overlays tab with New…, then Publish…",
        }),
      );
    }
  }

  async function search(reset = true) {
    if (reset) {
      state.offset = 0;
      state.rows = [];
    }
    state.loading = true;
    setStatus("Searching…");
    try {
      const rows = await ask({ op: "browse", ...filters(), offset: state.offset });
      state.rows = reset ? rows : [...state.rows, ...rows];
      state.offset += rows.length;
      el("c-more").hidden = rows.length < 30;
      setStatus(state.rows.length === 0 ? "" : plural(state.rows.length, "theme"));
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      state.loading = false;
      renderResults();
    }
  }

  async function select(itemId) {
    state.selected = itemId;
    renderResults();
    el("c-page").replaceChildren(make("div", { className: "c-empty", textContent: "Loading…" }));
    try {
      state.page = await ask({ op: "page", itemId });
      renderPage();
    } catch (err) {
      el("c-page").replaceChildren(make("div", { className: "c-empty", textContent: err.message }));
    }
  }

  async function refresh(itemId) {
    await search(true);
    if (state.selected === itemId) await select(itemId);
  }

  async function install(itemId, button) {
    if (button) button.disabled = true;
    setStatus("Installing…");
    try {
      setStatus(await ask({ op: "install", itemId }));
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      if (button) button.disabled = false;
      await refresh(itemId);
    }
  }

  function starButton(page) {
    const b = make("button", {
      className: `ghost star${page.starred ? " on" : ""}`,
      type: "button",
      textContent: `${page.starred ? "★ Starred" : "☆ Star"} · ${page.stars}`,
      disabled: !signedIn(),
      title: signedIn() ? "" : "Sign in to star themes",
    });
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        const stars = await star(page.id, !page.starred);
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
    const box = make("div", { className: "c-actions" }, useButton(page), starButton(page));
    if (page.local?.origin === "installed") {
      const remove = make("button", { className: "ghost", type: "button", textContent: "Uninstall" });
      remove.addEventListener("click", async () => {
        if (remove.dataset.armed !== "1") {
          remove.dataset.armed = "1";
          remove.textContent = "Really uninstall?";
          return;
        }
        try {
          setStatus(await ask({ op: "uninstall", itemId: page.id }));
        } catch (err) {
          setStatus(err.message, true);
        }
        await refresh(page.id);
      });
      box.append(remove);
    }
    return box;
  }

  /** The theme's colours as a row of swatches: what it will look like, before installing it. */
  function swatches(page) {
    const box = make("div", { className: "c-swatches" });
    for (const s of page.swatches) {
      const chip = make("div", { className: "c-swatch", title: `${s.name}: ${s.value}` });
      const dot = make("i");
      // Validated in main (theme-content.ts): only colour values reach here.
      dot.style.background = s.value;
      chip.append(dot, make("span", { textContent: s.name }));
      box.append(chip);
    }
    return box;
  }

  function tabBody(page) {
    if (state.tab === "colours") {
      return page.swatches.length === 0
        ? make("div", { className: "c-empty", textContent: "This theme changes no colours." })
        : swatches(page);
    }
    if (state.tab === "changelog") {
      return make(
        "ul",
        { className: "c-changelog" },
        ...[...page.versions]
          .sort((a, b) => b.version - a.version)
          .map((v) =>
            make(
              "li",
              {},
              make("b", { textContent: `v${v.version}` }),
              make("span", { className: "c-meta", textContent: ` · ${date(v.publishedAt)}` }),
              make("div", { textContent: v.changelog || "No notes for this version." }),
            ),
          ),
      );
    }
    const shots =
      page.screenshots.length === 0
        ? null
        : make(
            "div",
            { className: "c-shots" },
            ...page.screenshots.map((url, i) => {
              const img = make("img", { src: url, alt: "", loading: "lazy" });
              img.addEventListener("click", () => openLightbox(page.screenshots, i));
              return img;
            }),
          );
    return make(
      "div",
      {},
      shots,
      page.readme.trim() !== ""
        ? markdown(page.readme)
        : make("div", { className: "c-empty", textContent: "The author has not written a description." }),
    );
  }

  function facts(page) {
    const dl = make("dl", { className: "c-facts" });
    const add = (term, value) => dl.append(make("dt", { textContent: term }), make("dd", {}, value));
    add("Kind", "Overlay theme");
    add("Based on", page.baseName);
    add("Settings changed", String(page.tokenCount));
    add("Author", page.authorName);
    add("Updated", date(page.updatedAt));
    if (page.local !== null) add("On this PC", page.local.origin === "mine" ? "Yours" : `Installed, v${page.local.version}`);
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
        ["colours", `Colours (${page.swatches.length})`],
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
          make(
            "h1",
            {},
            page.title,
            page.visibility !== "public" ? make("span", { className: "chip vis", textContent: page.visibility }) : null,
          ),
          make("div", { className: "c-byline", textContent: `by ${page.authorName} · overlay theme` }),
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

  return { search, clear: () => (state.selected = null) };
}
