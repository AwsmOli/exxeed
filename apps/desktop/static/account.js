// The account area, top right of the control window (M8). Draws what main says
// and sends requests; the session itself never reaches this page.

const el = (id) => document.getElementById(id);

const call = async (request) => {
  const response = await window.exxeed.account(request);
  if (!response.ok) throw new Error(response.error);
  return response.value;
};

let view = null;
let onboardingPrompted = false;
/** The email the code was sent to, between the two steps. */
let pendingEmail = "";

const PROVIDER_LABELS = { discord: "Continue with Discord", google: "Continue with Google" };

const setStatus = (id, text, bad = false) => {
  el(id).textContent = text;
  el(id).className = `form-status${bad ? " bad" : ""}`;
};

const initials = (name) =>
  (name ?? "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("") || "?";

function avatar(v) {
  if (v.avatarUrl) {
    const img = document.createElement("img");
    img.className = "avatar";
    img.src = v.avatarUrl;
    img.alt = "";
    // A provider avatar that fails to load falls back to initials.
    img.addEventListener("error", () => img.replaceWith(initialsAvatar(v)));
    return img;
  }
  return initialsAvatar(v);
}

function initialsAvatar(v) {
  const span = document.createElement("span");
  span.className = "avatar";
  span.textContent = initials(v.displayName);
  return span;
}

function render(v) {
  view = v;
  const button = el("account-btn");

  if (!v.available) {
    button.className = "account-btn signed-out";
    button.textContent = "Offline";
    button.title = "Cannot reach the Exxeed service. Click to retry.";
    button.disabled = false;
    el("account-menu").hidden = true;
    return;
  }
  button.title = "";

  if (!v.signedIn) {
    button.className = "account-btn signed-out";
    button.textContent = "Sign in";
    el("account-menu").hidden = true;
  } else {
    button.className = "account-btn";
    button.replaceChildren(avatar(v), document.createTextNode(v.displayName ?? "Account"));
    const who = el("account-who");
    const name = document.createElement("strong");
    name.textContent = v.displayName ?? "";
    who.replaceChildren(name, document.createTextNode(v.email ?? ""));
    // Just signed in: the dialog's job is done.
    if (el("signin").open) el("signin").close();
    // First sign-in: confirm the name that will appear on published content.
    // Once per launch, so "Later" means later rather than on the next refresh.
    if (!v.onboarded && !onboardingPrompted) {
      onboardingPrompted = true;
      openProfile(true);
    }
  }

  renderProviders(v);
}

function renderProviders(v) {
  const list = el("signin-providers");
  const enabled = Object.entries(v.providers).filter(([, on]) => on).map(([id]) => id);
  list.replaceChildren(
    ...enabled.map((id) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `provider ${id}`;
      b.textContent = PROVIDER_LABELS[id] ?? id;
      b.addEventListener("click", () => void signInWith(id));
      return b;
    }),
  );
  el("signin-or").hidden = enabled.length === 0;
  // The email step waits on the same listener, but its own text says what to do.
  if (v.waitingForBrowser && el("signin-code-step").hidden) {
    setStatus("signin-status", "Finish signing in in your browser…");
  }
}

async function signInWith(provider) {
  setStatus("signin-status", "Opening your browser…");
  try {
    await call({ op: "signInWith", provider });
    setStatus("signin-status", "Finish signing in in your browser…");
  } catch (err) {
    setStatus("signin-status", err.message, true);
  }
}

function showEmailStep() {
  el("signin-email-step").hidden = false;
  el("signin-code-step").hidden = true;
}

async function sendCode() {
  const email = el("signin-email").value.trim();
  el("signin-send").disabled = true;
  setStatus("signin-status", "Sending…");
  try {
    await call({ op: "sendEmailCode", email });
    pendingEmail = email;
    el("signin-code-lead").textContent =
      `We emailed ${email}. Click the link in it on this computer, or type the code if the email has one. ` +
      `It can take a minute to arrive.`;
    el("signin-email-step").hidden = true;
    el("signin-code-step").hidden = false;
    el("signin-code").value = "";
    el("signin-code").focus();
    setStatus("signin-status", "");
  } catch (err) {
    setStatus("signin-status", err.message, true);
  } finally {
    el("signin-send").disabled = false;
  }
}

async function verifyCode() {
  el("signin-verify").disabled = true;
  setStatus("signin-status", "Checking…");
  try {
    await call({ op: "verifyEmailCode", email: pendingEmail, code: el("signin-code").value });
    setStatus("signin-status", "");
  } catch (err) {
    setStatus("signin-status", err.message, true);
  } finally {
    el("signin-verify").disabled = false;
  }
}

function openSignIn() {
  showEmailStep();
  setStatus("signin-status", "");
  el("signin").showModal();
  el("signin-email").focus();
}

function openProfile(first) {
  el("profile-title").textContent = first ? "Choose your name" : "Edit profile";
  el("profile-cancel").textContent = first ? "Later" : "Cancel";
  el("profile-name").value = view?.displayName ?? "";
  setStatus("profile-status", "");
  el("profile").showModal();
  el("profile-name").select();
}

async function saveProfile() {
  el("profile-save").disabled = true;
  try {
    await call({ op: "saveProfile", displayName: el("profile-name").value });
    el("profile").close();
  } catch (err) {
    setStatus("profile-status", err.message, true);
  } finally {
    el("profile-save").disabled = false;
  }
}

el("account-btn").addEventListener("click", () => {
  if (view === null || !view.available) {
    void call({ op: "view" }).then(render, () => {});
    return;
  }
  if (!view.signedIn) openSignIn();
  else el("account-menu").hidden = !el("account-menu").hidden;
});

// Clicking anywhere else closes the menu.
document.addEventListener("click", (event) => {
  if (!event.target.closest(".account")) el("account-menu").hidden = true;
});

el("account-profile").addEventListener("click", () => {
  el("account-menu").hidden = true;
  openProfile(false);
});
el("account-signout").addEventListener("click", () => {
  el("account-menu").hidden = true;
  void call({ op: "signOut" }).catch(() => {});
});

el("signin-send").addEventListener("click", () => void sendCode());
el("signin-email").addEventListener("keydown", (e) => e.key === "Enter" && void sendCode());
el("signin-verify").addEventListener("click", () => void verifyCode());
el("signin-code").addEventListener("keydown", (e) => e.key === "Enter" && void verifyCode());
el("signin-back").addEventListener("click", showEmailStep);
el("signin-cancel").addEventListener("click", () => {
  if (view?.waitingForBrowser) void call({ op: "cancelBrowserSignIn" }).catch(() => {});
  el("signin").close();
});

el("profile-save").addEventListener("click", () => void saveProfile());
el("profile-name").addEventListener("keydown", (e) => e.key === "Enter" && void saveProfile());
el("profile-cancel").addEventListener("click", () => el("profile").close());

window.exxeed?.onAccountChanged(render);
void call({ op: "view" }).then(render, () => {});
