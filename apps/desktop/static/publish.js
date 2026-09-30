// Publishing the open note set as a callout pack (M8). The dialog asks main for
// the state and sends the request; ownership, numbering and refusing stale audio
// are the server's to decide.

const $ = (id) => document.getElementById(id);

const call = async (request) => {
  const response = await window.exxeed.publish(request);
  if (!response.ok) throw new Error(response.error);
  return response.value;
};

let state = null;

const setStatus = (text, kind = "") => {
  $("pub-status").textContent = text;
  $("pub-status").className = kind;
};

const when = (iso) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/** The header badge: which version this set is, and whether it has moved on since. */
function renderBadge(s) {
  const badge = $("pub-badge");
  const p = s?.published;
  if (!p || p.latestVersion === null) {
    badge.hidden = true;
    $("publish-open").textContent = "Publish…";
    return;
  }
  badge.hidden = false;
  const ahead = p.changes.length > 0;
  badge.textContent = `v${p.latestVersion}${ahead ? " · edited" : ""} · ★ ${p.starCount} · ${p.downloadCount} downloads`;
  badge.title = ahead ? "This set has changed since the published version" : "Matches the published version";
  $("publish-open").textContent = ahead ? "Publish update…" : "Publish…";
}

function fill(s) {
  const p = s.published;
  const fields = p?.fields ?? s.suggested;
  $("pub-title").value = fields.title;
  $("pub-summary").value = fields.summary;
  $("pub-readme").value = fields.readme;
  $("pub-visibility").value = fields.visibility;
  $("pub-changelog").value = "";

  const isUpdate = p !== null && p.latestVersion !== null;
  $("pub-heading").textContent = isUpdate ? `Publish v${p.latestVersion + 1}` : "Publish callout pack";
  $("pub-lead").textContent = isUpdate
    ? "Installers get this version before their next session, with the list below as its changelog."
    : `${s.noteCount} callouts. Published versions can't be edited — improving the pack means publishing the next version.`;

  $("pub-update").hidden = !isUpdate;
  if (isUpdate) {
    $("pub-latest").textContent = `v${p.latestVersion}`;
    const lines = p.changes.length > 0 ? p.changes : ["No callout has changed — publishing now only updates the page."];
    $("pub-changes").replaceChildren(
      ...lines.map((line) => {
        const li = document.createElement("li");
        li.textContent = line;
        return li;
      }),
    );
  }

  renderMedia(s);

  $("pub-history").hidden = !(p && p.versions.length > 0);
  if (p) {
    $("pub-versions").replaceChildren(
      ...p.versions.map((v) => {
        const li = document.createElement("li");
        if (v.withdrawn) li.className = "withdrawn";
        const ver = document.createElement("span");
        ver.className = "v";
        ver.textContent = `v${v.version}`;
        const log = document.createElement("span");
        log.className = "log";
        log.textContent = v.changelog || (v.version === 1 ? "First release" : "—");
        const date = document.createElement("span");
        date.className = "when";
        date.textContent = `${when(v.publishedAt)} · ${v.downloads} ↓${v.withdrawn ? " · withdrawn" : ""}`;
        li.append(ver, log, date);
        if (!v.withdrawn) {
          const withdraw = document.createElement("button");
          withdraw.textContent = "Withdraw";
          withdraw.title = "Hide this version from new installs. People already on it keep it and are offered the latest.";
          withdraw.addEventListener("click", () => void doWithdraw(v, withdraw));
          li.append(withdraw);
        }
        return li;
      }),
    );
  }

  // Say up front what would stop a publish, rather than after the click.
  const go = $("pub-go");
  go.textContent = isUpdate ? `Publish v${p.latestVersion + 1}` : "Publish";
  if (!s.signedIn) {
    go.disabled = true;
    setStatus("Sign in from the main window to publish.", "bad");
  } else if (s.installed) {
    go.disabled = true;
    setStatus("This is someone else's pack, installed here.", "bad");
  } else if (s.dirtyCount > 0) {
    go.disabled = true;
    setStatus(
      `Render the audio first: ${s.dirtyCount} callout${s.dirtyCount === 1 ? " has" : "s have"} changed since it was rendered.`,
      "bad",
    );
  } else if (s.noteCount === 0) {
    go.disabled = true;
    setStatus("Add some callouts first.", "bad");
  } else {
    go.disabled = false;
    setStatus("");
  }
}

/** The page's icon and screenshots — only once the pack exists on the server. */
function renderMedia(s) {
  const p = s.published;
  $("pub-media-section").hidden = p === null;
  if (p === null) return;
  $("pub-media").replaceChildren(
    ...p.media.map((m) => {
      const img = document.createElement("img");
      img.src = m.url;
      img.alt = "";
      if (m.kind === "icon") img.className = "icon";
      const remove = document.createElement("button");
      remove.textContent = "×";
      remove.title = m.kind === "icon" ? "Remove the icon" : "Remove this screenshot";
      remove.addEventListener("click", () => void mediaOp({ op: "removeMedia", mediaId: m.id }));
      const figure = document.createElement("figure");
      figure.append(img, remove);
      return figure;
    }),
  );
  $("pub-shot").disabled = p.media.filter((m) => m.kind === "screenshot").length >= 8;
}

async function mediaOp(request) {
  setStatus(request.op === "addMedia" ? "Uploading…" : "Removing…");
  try {
    state = await call(request);
    renderBadge(state);
    renderMedia(state);
    setStatus("");
  } catch (err) {
    setStatus(err.message, "bad");
  }
}

async function refreshState() {
  try {
    state = await call({ op: "state" });
    renderBadge(state);
    return state;
  } catch (err) {
    setStatus(err.message, "bad");
    return null;
  }
}

async function open() {
  setStatus("Loading…");
  $("publish").showModal();
  const s = await refreshState();
  if (s !== null) fill(s);
}

async function doPublish() {
  const go = $("pub-go");
  go.disabled = true;
  setStatus("Publishing…");
  try {
    state = await call({
      op: "publish",
      fields: {
        title: $("pub-title").value,
        summary: $("pub-summary").value,
        readme: $("pub-readme").value,
        visibility: $("pub-visibility").value,
      },
      changelog: $("pub-changelog").value,
    });
    renderBadge(state);
    fill(state);
    setStatus(`Published v${state.published?.latestVersion}.`, "ok");
  } catch (err) {
    setStatus(err.message, "bad");
    go.disabled = false;
  }
}

async function doWithdraw(version, button) {
  // Two clicks rather than a confirm() — the viewer can suppress dialogs, and
  // this cannot be undone from the app.
  if (button.dataset.armed !== "1") {
    button.dataset.armed = "1";
    button.textContent = "Really withdraw?";
    return;
  }
  button.disabled = true;
  try {
    state = await call({ op: "withdraw", versionId: version.id });
    renderBadge(state);
    fill(state);
    setStatus(`Withdrew v${version.version}.`, "ok");
  } catch (err) {
    setStatus(err.message, "bad");
    button.disabled = false;
  }
}

$("publish-open").addEventListener("click", () => void open());
$("pub-icon").addEventListener("click", () => void mediaOp({ op: "addMedia", kind: "icon" }));
$("pub-shot").addEventListener("click", () => void mediaOp({ op: "addMedia", kind: "screenshot" }));
$("pub-cancel").addEventListener("click", () => $("publish").close());
$("pub-go").addEventListener("click", () => void doPublish());

// The badge is worth having before anyone opens the dialog. Saving or rendering
// changes whether the set has moved on from its published version.
void refreshState();
$("save").addEventListener("click", () => setTimeout(() => void refreshState(), 800));
$("render").addEventListener("click", () => setTimeout(() => void refreshState(), 800));
