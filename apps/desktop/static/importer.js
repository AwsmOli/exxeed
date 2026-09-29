// The YouTube importer window. Draws, and asks main to do everything else —
// every network call, every file, every key stays in the main process
// (apps/desktop/src/importer.ts). The window never holds a secret.

const el = (id) => document.getElementById(id);

const call = async (request) => {
  const response = await window.exxeed.importer(request);
  if (!response.ok) throw new Error(response.error);
  return response.value;
};

const state = {
  context: null,
  tab: "session",
  week: [],
  /** { trackId, trackName, configName, carName, carId, cars? } */
  race: null,
  trackInfo: null,
  results: [],
  video: null,
  transcript: null,
  /** DraftCallout[] as main returns them, edited in place. */
  callouts: [],
};

const fmtTime = (ms) => {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
};

const parseTime = (value) => {
  const parts = String(value).trim().split(":");
  if (parts.length < 2 || parts.some((p) => !/^\d+$/.test(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0) * 1000;
};

const setStatus = (id, text, kind = "") => {
  const node = el(id);
  node.className = `status small ${kind}`;
  node.textContent = "";
  if (kind === "busy") {
    const spin = document.createElement("span");
    spin.className = "spinner";
    node.append(spin, ` ${text}`);
  } else {
    node.textContent = text;
  }
};

const make = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
};

// ---------------------------------------------------------------------------
// Race
// ---------------------------------------------------------------------------

const showTab = (tab) => {
  state.tab = tab;
  for (const b of document.querySelectorAll("[data-tab]")) b.classList.toggle("on", b.dataset.tab === tab);
  for (const p of document.querySelectorAll("[data-panel]")) p.hidden = p.dataset.panel !== tab;
  if (tab === "week" && state.week.length === 0) void loadWeek(false);
};

const renderSession = () => {
  const s = state.context?.session;
  el("session-text").textContent =
    s == null
      ? "No iRacing session is running. Start one (and Start in Exxeed), or pick from this week's races."
      : `${s.carName} at ${s.trackName}${s.configName ? ` — ${s.configName}` : ""}`;
};

const loadWeek = async (refresh) => {
  setStatus("week-status", "Loading this week's official races…", "busy");
  try {
    const week = await call({ op: "raceWeek", refresh });
    state.week = week.entries;
    const when = new Date(week.fetchedAt).toLocaleString();
    if (week.stale) setStatus("week-status", `Showing the schedule from ${when} — could not refresh: ${week.stale}`, "bad");
    else setStatus("week-status", `${week.entries.length} official series · iRacing schedule from ${when}`);
    renderWeek();
  } catch (err) {
    setStatus("week-status", err.message, "bad");
  }
};

const renderWeek = () => {
  const q = el("week-filter").value.trim().toLowerCase();
  const shown = state.week.filter((e) =>
    q === "" ||
    `${e.seriesName} ${e.category} ${e.trackName} ${e.configName} ${e.cars.join(" ")}`.toLowerCase().includes(q),
  );
  el("week-list").replaceChildren(
    ...shown.map((e) => {
      const li = make(
        "li",
        {},
        make("div", { className: "series", textContent: e.seriesName }),
        make("div", {
          className: "where",
          textContent: `${e.category ? `${e.category} · ` : ""}Wk ${e.week} · ${e.trackName}${e.configName ? ` — ${e.configName}` : ""}`,
        }),
        make("div", {
          className: "where",
          textContent: e.cars.length > 3 ? `${e.cars.length} cars` : e.cars.join(", "),
        }),
      );
      li.classList.toggle("on", state.race?.seriesName === e.seriesName);
      li.addEventListener("click", () => {
        // The schedule names tracks and cars but carries no ids; main matches
        // the track to a map by name, and the car to a class the same way.
        chooseRace({
          seriesName: e.seriesName,
          trackId: null,
          trackName: e.trackName,
          configName: e.configName,
          carName: e.cars[0] ?? "",
          carId: null,
          cars: e.cars.map((name) => ({ name, carId: null })),
        });
        renderWeek();
      });
      return li;
    }),
  );
};

/** The words a coach's video title would use: short names, no sponsor prefixes. */
const searchName = (name) => name.replace(/^(Global|Dallara|Fanatec)\s+/i, "").replace(/\s+-\s+.*$/, "");

const chooseRace = async (race) => {
  state.race = race;
  el("chosen").hidden = false;
  el("chosen-track").textContent = `${race.trackName}${race.configName ? ` — ${race.configName}` : ""}`;

  const select = el("chosen-car-select");
  const many = (race.cars?.length ?? 0) > 1;
  select.hidden = !many;
  el("chosen-car").hidden = many;
  if (many) {
    select.replaceChildren(...race.cars.map((c, i) => make("option", { value: String(i), textContent: c.name })));
    select.value = String(Math.max(0, race.cars.findIndex((c) => c.name === race.carName)));
  }
  el("chosen-car").textContent = race.carName || "no car chosen";

  el("query").value = `iRacing track guide ${searchName(race.carName)} ${race.trackName}`.replace(/\s+/g, " ").trim();
  await refreshTrackInfo();
};

const refreshTrackInfo = async () => {
  const race = state.race;
  if (race === null) return;
  el("chosen-map").textContent = "";
  try {
    const info = await call({ op: "trackInfo", track: trackRequest() });
    state.trackInfo = info;
    el("car-class").value = info.carClass;
    const map = make("span", {
      className: `badge ${info.mapped ? "good" : "warn"}`,
      textContent: info.mapped ? `mapped · ${info.turns.length} turns` : "not mapped yet",
    });
    const sets = info.noteSets.length > 0 ? make("span", { className: "badge", textContent: `${info.noteSets.length} note set(s)` }) : null;
    el("chosen-map").replaceChildren(map, sets ?? "");
    el("chosen-map").title = info.mapped
      ? "Callouts will be placed on this track's map and opened in the editor."
      : "No track map yet — callouts are saved and can be placed after you drive a lap here.";
  } catch (err) {
    el("chosen-map").textContent = err.message;
  }
  updateButtons();
};

const trackRequest = () => ({
  trackId: state.race.trackId ?? null,
  configName: state.race.configName ?? "",
  trackName: state.race.trackName,
  carName: state.race.carName,
  carId: state.race.carId ?? null,
});

// ---------------------------------------------------------------------------
// Search and the player
// ---------------------------------------------------------------------------

const ensureYtDlp = async () => {
  if (state.context.ytdlp) return true;
  if (!confirm("Searching and captions use yt-dlp, which is not installed.\n\nDownload it now from github.com/yt-dlp (about 18 MB)?")) {
    return false;
  }
  setStatus("search-status", "Downloading yt-dlp…", "busy");
  try {
    state.context.ytdlp = await call({ op: "installYtDlp" });
    setStatus("search-status", "yt-dlp installed");
    return true;
  } catch (err) {
    setStatus("search-status", err.message, "bad");
    return false;
  }
};

const search = async () => {
  const query = el("query").value.trim();
  if (query === "" || !(await ensureYtDlp())) return;
  setStatus("search-status", "Searching YouTube…", "busy");
  el("search-btn").disabled = true;
  try {
    state.results = await call({ op: "search", query });
    setStatus("search-status", state.results.length === 0 ? "Nothing found — try fewer words" : `${state.results.length} videos`);
    renderResults();
  } catch (err) {
    setStatus("search-status", err.message, "bad");
  } finally {
    el("search-btn").disabled = false;
  }
};

const renderResults = () => {
  el("results").replaceChildren(
    ...state.results.map((v) => {
      const bits = [v.channel, v.durationS ? fmtTime(v.durationS * 1000) : null, v.views ? `${v.views.toLocaleString()} views` : null];
      const li = make(
        "li",
        {},
        make("img", { src: v.thumbnail, alt: "", loading: "lazy" }),
        make("div", {}, make("div", { className: "title", textContent: v.title, title: v.title }), make("div", { className: "meta", textContent: bits.filter(Boolean).join(" · ") })),
      );
      li.classList.toggle("on", state.video?.id === v.id);
      li.addEventListener("click", () => chooseVideo(v));
      return li;
    }),
  );
};

let playerReady = false;

const chooseVideo = (video) => {
  state.video = video;
  state.transcript = null;
  renderResults();
  el("video-title").textContent = video.title;
  el("video-meta").textContent = [video.channel, video.durationS ? fmtTime(video.durationS * 1000) : null].filter(Boolean).join(" · ");
  el("open-yt").disabled = false;

  playerReady = false;
  const frame = make("iframe", {
    src: `https://www.youtube-nocookie.com/embed/${video.id}?enablejsapi=1&rel=0&modestbranding=1`,
    allow: "autoplay; encrypted-media; picture-in-picture; fullscreen",
    allowFullscreen: true,
    referrerPolicy: "strict-origin-when-cross-origin",
  });
  frame.addEventListener("load", () => {
    // The player's postMessage API only answers once told someone is listening.
    frame.contentWindow?.postMessage(JSON.stringify({ event: "listening", id: 1 }), "*");
    playerReady = true;
  });
  el("player").replaceChildren(frame);

  renderTranscript();
  void getTranscript();
};

const seek = (ms) => {
  const frame = el("player").querySelector("iframe");
  if (frame === null || !playerReady) return;
  const post = (func, args = []) => frame.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args }), "*");
  post("seekTo", [ms / 1000, true]);
  post("playVideo");
};

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

const getTranscript = async () => {
  const video = state.video;
  if (video === null || !(await ensureYtDlp())) return;
  el("transcript-btn").disabled = true;
  el("transcript-empty").hidden = false;
  el("transcript-empty").textContent = "";
  el("transcript-empty").append(make("span", { className: "spinner" }), " Fetching captions…");
  try {
    const transcript = await call({ op: "transcript", videoId: video.id });
    if (state.video?.id !== video.id) return;
    state.transcript = transcript;
  } catch (err) {
    if (state.video?.id !== video.id) return;
    el("transcript-empty").textContent = `No transcript: ${err.message}`;
  } finally {
    el("transcript-btn").disabled = false;
  }
  renderTranscript();
  updateButtons();
};

const renderTranscript = () => {
  const t = state.transcript;
  const q = el("transcript-filter").value.trim().toLowerCase();
  if (t === null) {
    el("transcript").replaceChildren();
    el("transcript-empty").hidden = false;
    if (state.video === null) el("transcript-empty").textContent = "The transcript appears here. Click a timestamp to jump the video to it.";
    return;
  }
  el("transcript-empty").hidden = true;
  el("video-meta").textContent = [
    state.video.channel,
    state.video.durationS ? fmtTime(state.video.durationS * 1000) : null,
    t.kind === "auto" ? "auto-generated captions" : "uploader's captions",
  ].filter(Boolean).join(" · ");

  el("transcript").replaceChildren(
    ...t.lines.map((line) => {
      const ts = make("span", { className: "ts", textContent: fmtTime(line.startMs) });
      ts.addEventListener("click", () => seek(line.startMs));
      const li = make("li", {}, ts, make("span", { textContent: line.text }));
      li.dataset.ms = String(line.startMs);
      li.classList.toggle("hit", q !== "" && line.text.toLowerCase().includes(q));
      return li;
    }),
  );
  if (q !== "") el("transcript").querySelector("li.hit")?.scrollIntoView({ block: "center" });
};

// ---------------------------------------------------------------------------
// Callouts
// ---------------------------------------------------------------------------

const providerLabel = () => {
  const a = state.context.accounts;
  const info = state.context.providers.find((p) => p.id === a.provider);
  const ready = !info.needsKey || a.hasKey[a.provider];
  return { info, ready, text: `${info.label} · ${a.model}${ready ? "" : " — add an API key under AI model"}` };
};

const updateButtons = () => {
  const haveInput = state.race !== null && state.transcript !== null;
  const p = providerLabel();
  el("provider-line").textContent = p.text;
  el("convert-btn").disabled = !haveInput || !p.ready;
  el("convert-btn").textContent = `Convert with ${p.info.label.split(" (")[0]}`;
  el("copy-btn").disabled = !haveInput;
  el("paste-btn").disabled = state.race === null;
  el("add-btn").disabled = state.race === null;
  el("import-btn").disabled = state.race === null || state.video === null || state.callouts.length === 0;
  el("import-btn").textContent = state.trackInfo?.mapped === false ? "Save for later" : "Import";
};

const showParsed = (parsed) => {
  state.callouts = parsed.callouts.map((c) => ({ ...c }));
  state.layoutWarning = parsed.layoutWarning ?? null;
  const layout = parsed.layoutWarning
    ? [make("li", { textContent: `Different layout? ${parsed.layoutWarning}`, style: "color: var(--bad); font-weight: 600" })]
    : [];
  el("problems").replaceChildren(...layout, ...parsed.problems.map((p) => make("li", { textContent: p })));
  renderCallouts();
};

const convert = async () => {
  setStatus("convert-status", "Asking the model — a long guide can take a minute…", "busy");
  el("convert-btn").disabled = true;
  try {
    const result = await call({ op: "convert", track: trackRequest(), video: videoRequest() });
    el("paste").value = result.reply;
    showParsed(result.parsed);
    setStatus("convert-status", `${result.parsed.callouts.length} callouts — check them, then import`, "good");
  } catch (err) {
    setStatus("convert-status", err.message, "bad");
  } finally {
    updateButtons();
  }
};

const videoRequest = () => ({ id: state.video.id, title: state.video.title, channel: state.video.channel });

const copyPrompt = async () => {
  try {
    const prompt = await call({ op: "prompt", track: trackRequest(), video: videoRequest() });
    await navigator.clipboard.writeText(prompt);
    el("paste-box").open = true;
    setStatus("convert-status", "Copied. Paste it into any AI chat, then paste its answer below.", "good");
  } catch (err) {
    setStatus("convert-status", err.message, "bad");
  }
};

const usePasted = async () => {
  try {
    showParsed(await call({ op: "parse", track: trackRequest(), reply: el("paste").value }));
    setStatus("convert-status", `${state.callouts.length} callouts read from the reply`, "good");
  } catch (err) {
    setStatus("convert-status", err.message, "bad");
  }
  updateButtons();
};

const renderCallouts = () => {
  el("callouts-empty").hidden = state.callouts.length > 0;
  const valid = state.trackInfo?.mapped ? new Set(state.trackInfo.turns) : null;

  el("callouts").replaceChildren(
    ...state.callouts.map((c, i) => {
      const turn = make("input", { type: "number", min: "1", value: String(c.turn), title: "Turn" });
      turn.addEventListener("change", () => {
        c.turn = Math.max(1, Math.round(Number(turn.value)) || 1);
        turn.style.borderColor = valid !== null && !valid.has(c.turn) ? "var(--bad)" : "";
      });
      if (valid !== null && !valid.has(c.turn)) turn.style.borderColor = "var(--bad)";

      const through = make("input", { type: "number", min: "1", value: c.throughTurn ?? "", placeholder: "–", title: "Through turn (for a sequence)" });
      through.addEventListener("change", () => {
        const n = Math.round(Number(through.value));
        c.throughTurn = through.value === "" || !(n > c.turn) ? null : n;
      });

      const conf = make("span", {
        className: `conf ${c.confidence !== null && c.confidence < 0.6 ? "low" : ""}`,
        textContent: c.confidence === null ? "" : `${Math.round(c.confidence * 100)}%`,
        title: "How sure the model was",
      });

      const ts = make("input", { type: "text", value: c.sourceMs === null ? "" : fmtTime(c.sourceMs), placeholder: "m:ss", title: "Where in the video", style: "width: 64px; padding: 2px 5px" });
      ts.addEventListener("change", () => {
        c.sourceMs = parseTime(ts.value);
      });
      const jump = make("button", { type: "button", className: "link small", textContent: "▶", title: "Play from here" });
      jump.addEventListener("click", () => c.sourceMs !== null && seek(c.sourceMs));

      const remove = make("button", { type: "button", className: "link small", textContent: "Remove", style: "color: var(--muted)" });
      remove.addEventListener("click", () => {
        state.callouts.splice(i, 1);
        renderCallouts();
        updateButtons();
      });

      const text = make("textarea", { rows: 2, value: c.text, placeholder: "Full callout" });
      text.addEventListener("input", () => (c.text = text.value));
      const short = make("input", { type: "text", className: "short", value: c.textShort, placeholder: "Short form, 2–4 words" });
      short.addEventListener("input", () => (short.value.trim() === "" ? (c.textShort = "") : (c.textShort = short.value)));

      return make(
        "li",
        {},
        make("div", { className: "head" }, make("span", { className: "small muted", textContent: "Corner" }), turn, officialLabel(c), make("span", { className: "small muted", textContent: "to" }), through, conf, make("span", { className: "grow" }), ts, jump, remove),
        text,
        short,
      );
    }),
  );
};

/**
 * "official T5" when the app has learned the numbering, "coach: T5" when only
 * this guide says so — so a corner whose number looks off can be spotted before
 * importing rather than after.
 */
const officialLabel = (c) => {
  const known = state.trackInfo?.official?.[String(c.turn)];
  if (known !== undefined) return make("span", { className: "small muted", textContent: `official T${known}` });
  if (c.coachTurn !== null && c.coachTurn !== undefined) return make("span", { className: "small muted", textContent: `coach: T${c.coachTurn}` });
  return null;
};

const addCallout = () => {
  state.callouts.push({ turn: (state.callouts.at(-1)?.turn ?? 0) + 1, throughTurn: null, coachTurn: null, text: "", textShort: "", confidence: null, sourceMs: null });
  renderCallouts();
  updateButtons();
  el("callouts").lastElementChild?.querySelector("textarea")?.focus();
};

const doImport = async () => {
  const callouts = state.callouts.filter((c) => c.text.trim() !== "");
  if (callouts.length === 0) return;
  setStatus("import-status", "Importing and rendering…", "busy");
  try {
    const result = await call({
      op: "import",
      request: { track: trackRequest(), video: videoRequest(), carClass: el("car-class").value.trim(), callouts, layoutWarning: state.layoutWarning ?? null },
    });
    const extra = [...(result.warnings ?? []), ...(result.unresolved ?? [])];
    setStatus("import-status", result.message + (extra.length > 0 ? ` (${extra.length} warning${extra.length === 1 ? "" : "s"} — see the editor)` : ""), result.ok ? "good" : "bad");
    if (!result.placed) void loadSaved();
    void refreshTrackInfo();
  } catch (err) {
    setStatus("import-status", err.message, "bad");
  }
};

const loadSaved = async () => {
  try {
    const saved = await call({ op: "saved" });
    el("saved-box").hidden = saved.length === 0;
    el("saved").replaceChildren(
      ...saved.map((s) => {
        const place = make("button", { type: "button", className: "small", textContent: s.mapped ? "Import now" : "Waiting for a map", disabled: !s.mapped });
        place.addEventListener("click", async () => {
          try {
            const result = await call({ op: "placeSaved", file: s.file });
            setStatus("import-status", result.message, result.ok ? "good" : "bad");
          } catch (err) {
            setStatus("import-status", err.message, "bad");
          }
        });
        return make("li", {}, make("div", { className: "row" }, make("div", { className: "grow" }, make("div", { className: "series", textContent: s.trackName }), make("div", { className: "where", textContent: `${s.count} callouts · ${s.title}` })), place));
      }),
    );
  } catch {
    el("saved-box").hidden = true;
  }
};

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

const openAccounts = () => {
  const a = state.context.accounts;

  el("ai-provider").replaceChildren(...state.context.providers.map((p) => make("option", { value: p.id, textContent: p.label })));
  el("ai-provider").value = a.provider;
  el("ai-model").value = a.model;
  el("ai-base").value = a.baseUrl;
  syncProvider(false);
  setStatus("accounts-status", state.context.secureStorage ? "" : "This system has no secure storage — accounts cannot be saved.", state.context.secureStorage ? "" : "bad");
  el("accounts").showModal();
};

const syncProvider = (resetModel) => {
  const id = el("ai-provider").value;
  const info = state.context.providers.find((p) => p.id === id);
  if (resetModel) el("ai-model").value = info.defaultModel;
  el("ai-base-wrap").hidden = id !== "openai-compatible";
  el("ai-key").value = "";
  el("ai-key").placeholder = state.context.accounts.hasKey[id] ? "saved — leave empty to keep" : info.needsKey ? "" : "optional";
  el("ai-key-link").hidden = info.keyUrl === null;
};

const saveAccounts = async (event) => {
  event.preventDefault();
  try {
    state.context.accounts = await call({
      op: "saveAccounts",
      // The window never sees a saved key, so an empty key field means "keep".
      ai: { provider: el("ai-provider").value, model: el("ai-model").value.trim(), baseUrl: el("ai-base").value.trim(), key: el("ai-key").value.trim() },
    });
    el("accounts").close();
    updateButtons();
  } catch (err) {
    setStatus("accounts-status", err.message, "bad");
  }
};

// ---------------------------------------------------------------------------

const refreshContext = async () => {
  state.context = await call({ op: "context" });
  renderSession();
  const s = state.context.session;
  if (s != null && state.tab === "session") void chooseRace({ ...s, cars: null });
};

const init = async () => {
  for (const b of document.querySelectorAll("[data-tab]")) b.addEventListener("click", () => showTab(b.dataset.tab));
  el("session-refresh").addEventListener("click", () => void refreshContext());
  el("week-filter").addEventListener("input", renderWeek);
  el("week-refresh").addEventListener("click", () => void loadWeek(true));
  el("chosen-car-select").addEventListener("change", () => {
    const car = state.race.cars[Number(el("chosen-car-select").value)];
    void chooseRace({ ...state.race, carName: car.name, carId: car.carId });
  });
  el("m-apply").addEventListener("click", () => {
    const track = el("m-track").value.trim();
    if (track === "") return;
    void chooseRace({ trackId: Number(el("m-track-id").value) || null, trackName: track, configName: el("m-config").value.trim(), carName: el("m-car").value.trim(), carId: null, cars: null });
  });
  el("search-btn").addEventListener("click", () => void search());
  el("query").addEventListener("keydown", (e) => e.key === "Enter" && void search());
  el("transcript-btn").addEventListener("click", () => void getTranscript());
  el("transcript-filter").addEventListener("input", renderTranscript);
  el("open-yt").addEventListener("click", () => state.video && void call({ op: "openVideo", videoId: state.video.id, atMs: 0 }));
  el("convert-btn").addEventListener("click", () => void convert());
  el("copy-btn").addEventListener("click", () => void copyPrompt());
  el("paste-btn").addEventListener("click", () => void usePasted());
  el("add-btn").addEventListener("click", addCallout);
  el("import-btn").addEventListener("click", () => void doImport());
  el("accounts-btn").addEventListener("click", openAccounts);
  el("accounts-cancel").addEventListener("click", () => el("accounts").close());
  el("accounts-form").addEventListener("submit", (e) => void saveAccounts(e));
  el("ai-provider").addEventListener("change", () => syncProvider(true));
  el("ai-key-link").addEventListener("click", () => {
    const info = state.context.providers.find((p) => p.id === el("ai-provider").value);
    if (info.keyUrl) window.open(info.keyUrl);
  });

  const STAGES = { piper: "Installing Piper (first time only)", voice: "Downloading a voice (first time only)", render: "Rendering audio" };
  window.exxeed.onImporterProgress?.(({ stage, received, total }) => {
    if (stage === "render") return setStatus("import-status", `${STAGES.render} — ${received} of ${total} clips`, "busy");
    if (stage in STAGES) {
      return setStatus("import-status", `${STAGES[stage]}… ${total > 0 ? `${Math.round((received / total) * 100)}%` : ""}`, "busy");
    }
    if (total > 0) setStatus("search-status", `Downloading yt-dlp… ${Math.round((received / total) * 100)}%`, "busy");
  });

  await refreshContext();
  showTab(state.context.session != null ? "session" : "week");
  updateButtons();
  void loadSaved();
};

void init();
