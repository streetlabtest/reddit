/* Quiet Feed client (final)
   - Show Comments default: OFF
   - Time-of-day background theme (CSS variables)
   - Breath interstitial on Next pagination (6s animation, continue immediately)
   - Meal check note on open if >3.5h since last activity (subtle status note, dismiss or auto-hide)
   - Settings are stored only where they differ from DEFAULTS, so default changes reach users who never customised them
*/

const APP_VERSION = "quietfeed-20260925-1";
const SESSION_IDLE_RESET_MS = 30 * 60 * 1000; // session resets after inactivity

const MEAL_NUDGE_THRESHOLD_MS = 3.5 * 60 * 60 * 1000; // 3.5 hours
const MEAL_NUDGE_AUTOHIDE_MS = 30 * 1000; // 30 seconds

const STORAGE_KEYS = {
  appVersion: "quietfeed.appVersion",
  lastActiveMs: "quietfeed.lastActiveMs",
  subreddits: "quietfeed.subreddits",
  banlist: "quietfeed.banlist",
  showTextOnly: "quietfeed.showTextOnly",
  showComments: "quietfeed.showComments",
  page: "quietfeed.page", // pages viewed this session (display only)
  feedGeneratedAt: "quietfeed.feedGeneratedAt",
  seenPersistent: "quietfeed.seenPersistent"
};

const SESSION_KEYS = {
  seenIds: "quietfeed.sessionSeenIds",
  seed: "quietfeed.sessionSeed",
  pageIds: "quietfeed.sessionPageIds"
};

const DEFAULTS = {
  subreddits: null,      // null = every subreddit available in feed.json
  banlist: "politics, war, shooting, death, violence, election",
  showTextOnly: false,
  showComments: false,   // EDIT (1): default unchecked
  perPage: 10,
  sessionCap: 25,
  textPreviewChars: 700,
  persistentSeenCap: 3000
};

/* ----------------- utilities ----------------- */

function loadJSON(key, fallback, storage = localStorage) {
  try {
    const v = storage.getItem(key);
    if (!v) return fallback;
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

function saveJSON(key, value, storage = localStorage) {
  storage.setItem(key, JSON.stringify(value));
}

function setStatus(msg) {
  document.getElementById("statusText").textContent = msg;
}


function asText(s) {
  return (s ?? "").toString();
}

function isProbablyEmptyText(t) {
  if (!t) return true;
  const cleaned = t.replace(/\s+/g, " ").trim();
  return cleaned.length < 3;
}

function uniqNormSubs(lines) {
  const out = [];
  const seen = new Set();
  for (const raw of lines) {
    const s = (raw || "").trim().replace(/^\/r\//i, "");
    if (!s) continue;
    const norm = s.replace(/[^A-Za-z0-9_]+/g, "");
    if (!norm) continue;
    const key = norm.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(norm);
  }
  return out;
}

function humanUpdatedLabel(isoUtc) {
  if (!isoUtc) return null;
  const d = new Date(isoUtc);
  if (Number.isNaN(d.getTime())) return null;

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday.getTime() - 24 * 60 * 60 * 1000);

  if (d >= startOfToday) return "Updated today";
  if (d >= startOfYesterday) return "Updated yesterday";

  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `Updated ${yyyy}-${mm}-${dd}`;
}

function truncateText(text, maxChars) {
  const t = (text || "").trim();
  if (t.length <= maxChars) return { preview: t, truncated: false };
  const cut = t.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  const preview = (lastSpace > 200 ? cut.slice(0, lastSpace) : cut).trim();
  return { preview, truncated: true };
}

function debounce(fn, ms) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Whole-word (or whole-phrase) matching, so "war" does not hide "software" or "reward".
function buildBanMatcher(banWords) {
  if (!banWords || banWords.length === 0) return null;
  const alts = banWords.map(w => escapeRegExp(w).replace(/\s+/g, "\\s+"));
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alts.join("|")})(?![\\p{L}\\p{N}_])`, "iu");
}

function postAllowed(item, banMatcher) {
  if (!banMatcher) return true;
  return !banMatcher.test(item.title || "") && !banMatcher.test(item.text || "");
}

function subredditAllowed(itemSub, allowedSet) {
  if (!allowedSet) return true;
  return allowedSet.has((itemSub || "").toLowerCase());
}

function clearSessionState() {
  sessionStorage.removeItem(SESSION_KEYS.seenIds);
  sessionStorage.removeItem(SESSION_KEYS.seed);
  sessionStorage.removeItem(SESSION_KEYS.pageIds);
  sessionStorage.removeItem("quietfeed.sessionShuffledIds"); // legacy key
  saveJSON(STORAGE_KEYS.page, 1, localStorage);
}

/* ----------------- time-of-day theming (EDIT 2) ----------------- */

function applyTimeOfDayTheme() {
  const hour = new Date().getHours();

  // Calm palettes; do not use high-contrast color shifts.
  // Night: 21–5, Morning: 6–11, Afternoon: 12–17, Evening: 18–20.
  let bg, panel, panel2;

  if (hour >= 21 || hour <= 5) {
    // Night: cool blue-black
    bg = "#0a0d12";
    panel = "#101826";
    panel2 = "#0c1420";
  } else if (hour >= 6 && hour <= 11) {
    // Morning: warm amber-dark (dawn)
    bg = "#131008";
    panel = "#1e190c";
    panel2 = "#17130a";
  } else if (hour >= 12 && hour <= 17) {
    // Afternoon: neutral dark (most awake)
    bg = "#131518";
    panel = "#191e24";
    panel2 = "#151820";
  } else {
    // Evening: deep purple-dusk
    bg = "#0f0c18";
    panel = "#161224";
    panel2 = "#12101c";
  }

  const r = document.documentElement;
  r.style.setProperty("--bg", bg);
  r.style.setProperty("--panel", panel);
  r.style.setProperty("--panel2", panel2);
}

/* ----------------- migration / session model ----------------- */

function migrateIfNeeded() {
  const stored = loadJSON(STORAGE_KEYS.appVersion, null, localStorage);
  if (stored === APP_VERSION) return;

  // User settings are kept. Only values that differ from DEFAULTS are stored
  // (see saveSettings), so changed defaults still reach users who never edited them.
  // Drop stored values that merely equal the current defaults.
  saveSettings(loadSettings());

  // Session state layout may have changed between versions.
  clearSessionState();

  saveJSON(STORAGE_KEYS.appVersion, APP_VERSION, localStorage);
}

function touchLastActive() {
  saveJSON(STORAGE_KEYS.lastActiveMs, Date.now(), localStorage);
}

// Returns the previous last-active timestamp (before this call refreshed it).
function maybeResetSessionForMobile() {
  const last = loadJSON(STORAGE_KEYS.lastActiveMs, null, localStorage);
  const now = Date.now();
  if (typeof last === "number" && now - last > SESSION_IDLE_RESET_MS) {
    clearSessionState();
  }
  touchLastActive();
  return typeof last === "number" ? last : null;
}

/* ----------------- meal nudge (EDIT 3b) ----------------- */

let mealNudgeTimer = null;
let mealNudgeVisible = false;
let lastBaseStatus = "";

// `previousActiveMs` must be read before anything refreshes lastActiveMs.
function showMealNudgeIfNeeded(previousActiveMs) {
  const now = Date.now();

  if (typeof previousActiveMs === "number" && (now - previousActiveMs) >= MEAL_NUDGE_THRESHOLD_MS) {
    // Show a faint note in the status area; no popup.
    mealNudgeVisible = true;
    renderStatusWithMealNote();

    // Auto-hide after 30 seconds for this session
    if (mealNudgeTimer) clearTimeout(mealNudgeTimer);
    mealNudgeTimer = setTimeout(() => {
      mealNudgeVisible = false;
      renderStatusWithMealNote();
    }, MEAL_NUDGE_AUTOHIDE_MS);
  }
}

function renderStatusWithMealNote(baseStatusText = lastBaseStatus) {
  const el = document.getElementById("statusText");
  if (!el) return;
  lastBaseStatus = baseStatusText || "";

  // Use lightweight DOM update; no external deps.
  el.textContent = "";
  const span = document.createElement("span");
  span.textContent = baseStatusText || "";
  el.appendChild(span);

  if (!mealNudgeVisible) return;

  const note = document.createElement("span");
  note.className = "statusNote";
  note.style.marginLeft = "10px";
  note.textContent = "Have you eaten recently?";
  el.appendChild(note);

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "noteDismiss";
  dismiss.textContent = "Dismiss";
  dismiss.addEventListener("click", () => {
    mealNudgeVisible = false;
    if (mealNudgeTimer) clearTimeout(mealNudgeTimer);
    renderStatusWithMealNote();
  });
  el.appendChild(dismiss);
}

/* ----------------- seen tracking ----------------- */

function getSessionSeenSet() {
  const arr = loadJSON(SESSION_KEYS.seenIds, [], sessionStorage);
  return new Set(Array.isArray(arr) ? arr : []);
}

function setSessionSeenSet(set) {
  saveJSON(SESSION_KEYS.seenIds, Array.from(set), sessionStorage);
}

function getPersistentSeenSet() {
  const arr = loadJSON(STORAGE_KEYS.seenPersistent, [], localStorage);
  return new Set(Array.isArray(arr) ? arr : []);
}

function setPersistentSeenSet(set) {
  const arr = Array.from(set);
  const trimmed = arr.length > DEFAULTS.persistentSeenCap ? arr.slice(arr.length - DEFAULTS.persistentSeenCap) : arr;
  saveJSON(STORAGE_KEYS.seenPersistent, trimmed, localStorage);
}

/* ----------------- randomization stable per session ----------------- */

function hashStringToSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function getSessionSeed() {
  let seed = loadJSON(SESSION_KEYS.seed, null, sessionStorage);
  if (typeof seed !== "string" || !seed) {
    seed = Math.random().toString(36).slice(2);
    saveJSON(SESSION_KEYS.seed, seed, sessionStorage);
  }
  return seed;
}

// Order by a per-session hash of each id. Stable within a session, and posts that
// become eligible later (e.g. a subreddit is re-enabled) slot into the order
// instead of being left out of a stored list.
function sessionOrder(items) {
  const seed = getSessionSeed();
  const rank = new Map(items.map(it => [it.id, hashStringToSeed(`${seed}:${it.id}`)]));
  return items.slice().sort((a, b) => rank.get(a.id) - rank.get(b.id));
}

/* ----------------- breath interstitial (EDIT 3a) ----------------- */

function buildBreathInterstitial(onContinue) {
  const card = document.createElement("article");
  card.className = "card breathCard";

  const title = document.createElement("div");
  title.className = "breathTitle";
  title.textContent = "Take a slow breath.";
  card.appendChild(title);

  const phase = document.createElement("div");
  phase.className = "breathPhase";
  phase.textContent = "inhale";
  card.appendChild(phase);

  const viz = document.createElement("div");
  viz.className = "breathViz animate";
  card.appendChild(viz);

  const phaseTimer = setTimeout(() => { phase.textContent = "exhale"; }, 4000);

  const btnRow = document.createElement("div");
  btnRow.className = "row";
  btnRow.style.justifyContent = "center";
  btnRow.style.marginTop = "20px";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn ghost";
  btn.textContent = "Continue";
  btn.addEventListener("click", () => {
    clearTimeout(phaseTimer);
    onContinue();
  });

  btnRow.appendChild(btn);
  card.appendChild(btnRow);

  return card;
}

function showBreathThenContinue(nextAction) {
  const feedEl = document.getElementById("feed");
  if (!feedEl) return nextAction();

  const nextBtn = document.getElementById("next");
  if (nextBtn) nextBtn.disabled = true;

  // Insert full-width card at top of feed
  const interstitial = buildBreathInterstitial(() => {
    interstitial.remove();
    if (nextBtn) nextBtn.disabled = false;
    nextAction();
  });

  feedEl.prepend(interstitial);
  window.scrollTo({ top: 0, behavior: "instant" });
}

/* ----------------- rendering ----------------- */

function buildStopScreen() {
  const card = document.createElement("article");
  card.className = "card stopScreen";

  const h2 = document.createElement("h2");
  h2.textContent = "You have reached this session’s limit.";
  card.appendChild(h2);

  const p = document.createElement("p");
  p.textContent = "You can resume later.";
  card.appendChild(p);

  return card;
}

function buildCard(item, sessionSeenSet, persistentSeenSet, showComments) {
  const card = document.createElement("article");
  card.className = "card";

  const h2 = document.createElement("h2");
  h2.textContent = asText(item.title || "(untitled)");
  card.appendChild(h2);

  const fullText = item.text || "";
  const hasText = !isProbablyEmptyText(fullText);

  if (hasText) {
    const { preview, truncated } = truncateText(fullText, DEFAULTS.textPreviewChars);

    const p = document.createElement("p");
    p.className = "text";
    p.textContent = preview;
    card.appendChild(p);

    if (truncated) {
      const moreRow = document.createElement("div");
      moreRow.className = "moreRow";

      const btn = document.createElement("button");
      btn.className = "moreBtn";
      btn.type = "button";
      btn.textContent = "Show more";
      btn.addEventListener("click", () => {
        const expanded = btn.getAttribute("data-expanded") === "true";
        if (expanded) {
          p.textContent = preview;
          btn.textContent = "Show more";
          btn.setAttribute("data-expanded", "false");
        } else {
          p.textContent = fullText;
          btn.textContent = "Show less";
          btn.setAttribute("data-expanded", "true");
        }
      });

      moreRow.appendChild(btn);
      card.appendChild(moreRow);
    }
  }

  if (item.image) {
    const wrap = document.createElement("div");
    wrap.className = "img";
    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = "";
    img.src = item.image;
    wrap.appendChild(img);
    card.appendChild(wrap);
  }

  const meta = document.createElement("div");
  meta.className = "meta";

  const left = document.createElement("span");
  left.textContent = `/r/${asText(item.subreddit || "")}`;
  meta.appendChild(left);

  if (showComments) {
    const comments = document.createElement("a");
    comments.href = item.comments_url;
    comments.target = "_blank";
    comments.rel = "noopener noreferrer";
    comments.textContent = "Comments";
    meta.appendChild(comments);
  }

  if (item.external_url) {
    const open = document.createElement("a");
    open.href = item.external_url;
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    open.textContent = "Open";
    meta.appendChild(open);
  }

  card.appendChild(meta);

  if (item.id) {
    sessionSeenSet.add(item.id);
    persistentSeenSet.add(item.id);
  }

  return card;
}

function setPager(page, nextEnabled) {
  document.getElementById("pageInfo").textContent = `Page ${page}`;
  document.getElementById("next").disabled = !nextEnabled;
}

async function loadFeed() {
  const res = await fetch("feed.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`feed.json request failed (${res.status})`);
  return await res.json();
}

/* ----------------- settings ----------------- */

function subsKey(subs) {
  return (subs || []).map(s => s.toLowerCase()).sort().join("|");
}

function loadSettings() {
  const subs = loadJSON(STORAGE_KEYS.subreddits, DEFAULTS.subreddits);
  return {
    banlist: loadJSON(STORAGE_KEYS.banlist, DEFAULTS.banlist),
    showTextOnly: !!loadJSON(STORAGE_KEYS.showTextOnly, DEFAULTS.showTextOnly),
    showComments: !!loadJSON(STORAGE_KEYS.showComments, DEFAULTS.showComments),
    subreddits: Array.isArray(subs) ? uniqNormSubs(subs) : null
  };
}

function saveOrClear(key, value, isDefault) {
  if (isDefault) localStorage.removeItem(key);
  else saveJSON(key, value);
}

// Stores only values that differ from DEFAULTS. `available` (the feed's subreddits)
// lets a selection of "everything" be stored as the default.
function saveSettings(settings, available = null) {
  saveOrClear(STORAGE_KEYS.banlist, settings.banlist, settings.banlist === DEFAULTS.banlist);
  saveOrClear(STORAGE_KEYS.showTextOnly, settings.showTextOnly, settings.showTextOnly === DEFAULTS.showTextOnly);
  saveOrClear(STORAGE_KEYS.showComments, settings.showComments, settings.showComments === DEFAULTS.showComments);

  const subs = settings.subreddits;
  const isAll = subs === null || (available !== null && subsKey(subs) === subsKey(available));
  saveOrClear(STORAGE_KEYS.subreddits, subs, isAll);
}

function banWordsOf(settings) {
  return (settings.banlist || "").split(",").map(w => w.trim().toLowerCase()).filter(Boolean);
}

/* ----------------- settings UI ----------------- */

function renderSubredditChoices(available, settings) {
  const box = document.getElementById("subreddits");
  box.textContent = "";
  const chosen = settings.subreddits ? new Set(settings.subreddits.map(s => s.toLowerCase())) : null;

  for (const sub of available) {
    const label = document.createElement("label");
    label.className = "toggle";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = sub;
    input.checked = !chosen || chosen.has(sub.toLowerCase());
    const span = document.createElement("span");
    span.textContent = `/r/${sub}`;
    label.append(input, span);
    box.appendChild(label);
  }
}

function writeSettingsToUI(available, settings) {
  document.getElementById("banlist").value = settings.banlist || "";
  document.getElementById("showTextOnly").checked = settings.showTextOnly;
  document.getElementById("showComments").checked = settings.showComments;
  renderSubredditChoices(available, settings);
}

function readSettingsFromUI(available) {
  const checked = Array.from(document.querySelectorAll("#subreddits input[type=checkbox]"))
    .filter(el => el.checked)
    .map(el => el.value);
  return {
    banlist: document.getElementById("banlist").value || "",
    showTextOnly: document.getElementById("showTextOnly").checked,
    showComments: document.getElementById("showComments").checked,
    subreddits: checked.length === available.length ? null : checked
  };
}

function renderFeedNote(data) {
  const el = document.getElementById("feedNote");
  if (!el) return;
  const failed = Object.keys(data.errors || {});
  el.textContent = failed.length
    ? `The last update could not refresh ${failed.map(s => "/r/" + s).join(", ")}; any earlier posts from them are still shown.`
    : "";
  el.hidden = failed.length === 0;
}

/* ----------------- filtering + ordering ----------------- */

function applyFilters(items, settings) {
  const allowedSet = settings.subreddits
    ? new Set(settings.subreddits.map(s => s.toLowerCase()))
    : null;
  const banMatcher = buildBanMatcher(banWordsOf(settings));
  return (items || []).filter(it => {
    if (!it || !it.id) return false;
    if (!subredditAllowed(it.subreddit, allowedSet)) return false;
    if (!postAllowed(it, banMatcher)) return false;
    if (!settings.showTextOnly && it.is_text_only) return false;
    return true;
  });
}

/* ----------------- rendering the feed ----------------- */

// The current page is a stored list of post ids. A page is only drawn fresh (the next
// unseen posts in session order) when there is no current page, so seen posts never
// shift an offset and nothing is skipped.
function renderFeed(app) {
  const feedEl = document.getElementById("feed");
  feedEl.innerHTML = "";

  const eligible = sessionOrder(applyFilters(app.items, app.settings));
  const byId = new Map(eligible.map(it => [it.id, it]));

  const sessionSeen = getSessionSeenSet();
  const persistentSeen = getPersistentSeenSet();

  let pageIds = loadJSON(SESSION_KEYS.pageIds, [], sessionStorage);
  pageIds = (Array.isArray(pageIds) ? pageIds : []).filter(id => byId.has(id));

  if (pageIds.length === 0) {
    const budget = DEFAULTS.sessionCap - sessionSeen.size;
    if (budget > 0) {
      pageIds = eligible
        .filter(it => !persistentSeen.has(it.id))
        .slice(0, Math.min(DEFAULTS.perPage, budget))
        .map(it => it.id);
    }
  }
  saveJSON(SESSION_KEYS.pageIds, pageIds, sessionStorage);

  for (const id of pageIds) {
    feedEl.appendChild(buildCard(byId.get(id), sessionSeen, persistentSeen, app.settings.showComments));
  }

  setSessionSeenSet(sessionSeen);
  setPersistentSeenSet(persistentSeen);

  const capReached = sessionSeen.size >= DEFAULTS.sessionCap;
  const unseenLeft = eligible.some(it => !persistentSeen.has(it.id));

  if (capReached) {
    feedEl.appendChild(buildStopScreen());
  } else if (pageIds.length === 0) {
    const empty = document.createElement("div");
    empty.className = "card";
    empty.textContent = "No posts match your filters (or you have already seen them).";
    feedEl.appendChild(empty);
  }

  const page = loadJSON(STORAGE_KEYS.page, 1);
  setPager(typeof page === "number" ? page : 1, !capReached && unseenLeft);
  renderSessionStatus(app, sessionSeen.size);
}

function renderSessionStatus(app, seenThisSession) {
  const remaining = Math.max(0, DEFAULTS.sessionCap - seenThisSession);
  const capMsg = remaining > 0 ? `${remaining} remaining this session` : "Session limit reached";
  const upd = app.updatedLabel ? ` • ${app.updatedLabel}` : "";
  renderStatusWithMealNote(`${DEFAULTS.sessionCap} posts per session • ${capMsg}${upd}`);
  const bar = document.getElementById("progressBar");
  if (bar) bar.style.setProperty("--pct", `${Math.round((seenThisSession / DEFAULTS.sessionCap) * 100)}%`);
}

/* ----------------- events + lifecycle ----------------- */

function installActivityHooks() {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      maybeResetSessionForMobile();
    } else {
      touchLastActive();
    }
  });

  window.addEventListener("pageshow", () => {
    maybeResetSessionForMobile();
  });

  window.addEventListener("pagehide", () => {
    touchLastActive();
  });
}

function wireEvents(app) {
  const settingsEl = document.querySelector(".settings");

  function applySettingsFromUI() {
    touchLastActive();
    app.settings = readSettingsFromUI(app.available);
    saveSettings(app.settings, app.available);
    renderFeed(app);
  }

  document.getElementById("banlist").addEventListener("input", debounce(applySettingsFromUI, 300));
  for (const id of ["showTextOnly", "showComments", "subreddits"]) {
    document.getElementById(id).addEventListener("change", applySettingsFromUI);
  }

  document.getElementById("saveSettings").addEventListener("click", () => {
    settingsEl.removeAttribute("open");
  });

  document.getElementById("resetSettings").addEventListener("click", () => {
    writeSettingsToUI(app.available, {
      banlist: DEFAULTS.banlist,
      showTextOnly: DEFAULTS.showTextOnly,
      showComments: DEFAULTS.showComments,
      subreddits: DEFAULTS.subreddits
    });
    clearSessionState();
    applySettingsFromUI();
  });

  document.getElementById("next").addEventListener("click", () => {
    showBreathThenContinue(() => {
      touchLastActive();
      const page = loadJSON(STORAGE_KEYS.page, 1);
      saveJSON(STORAGE_KEYS.page, (typeof page === "number" ? page : 1) + 1);
      sessionStorage.removeItem(SESSION_KEYS.pageIds);
      renderFeed(app);
      window.scrollTo({ top: 0, behavior: "instant" });
    });
  });
}

/* ----------------- main ----------------- */

(async function main() {
  applyTimeOfDayTheme();
  migrateIfNeeded();
  const previousActiveMs = maybeResetSessionForMobile();
  installActivityHooks();

  setStatus("Loading…");

  try {
    const data = await loadFeed();
    const items = data.items || [];

    if (data.generated_at_utc) {
      saveJSON(STORAGE_KEYS.feedGeneratedAt, data.generated_at_utc, localStorage);
    }

    // Only subreddits present in feed.json can be shown; offer exactly those.
    const available = uniqNormSubs(
      Array.isArray(data.subreddits_source) && data.subreddits_source.length
        ? data.subreddits_source
        : items.map(it => it.subreddit)
    );

    const settings = loadSettings();
    saveSettings(settings, available);

    const app = {
      items,
      available,
      settings,
      updatedLabel: humanUpdatedLabel(data.generated_at_utc) || ""
    };

    writeSettingsToUI(available, settings);
    renderFeedNote(data);
    wireEvents(app);
    renderFeed(app);
    showMealNudgeIfNeeded(previousActiveMs);
  } catch (e) {
    console.error(e);
    setStatus("Failed to load feed.json.");
    const feedEl = document.getElementById("feed");
    feedEl.innerHTML = "";
    const card = document.createElement("div");
    card.className = "card";
    card.textContent = "Could not load feed.json. Ensure GitHub Actions has generated it and GitHub Pages is serving the repository root.";
    feedEl.appendChild(card);
  }
})();
