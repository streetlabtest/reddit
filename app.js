/* Quiet Feed client (final)
   Key fixes:
   - Mobile: do not rely on tab-close to reset sessions. Define session via inactivity timeout.
   - Updates: cache-bust with index.html script ?v=... and migrate storage with APP_VERSION.
*/

const APP_VERSION = "quietfeed-20260310-2";

/* Session model for mobile:
   If the app has been inactive for SESSION_IDLE_RESET_MS, start a new session by clearing session storage.
   This behaves like "close tab and reopen" even when mobile OS suspends/restores tabs.
*/
const SESSION_IDLE_RESET_MS = 30 * 60 * 1000; // 30 minutes

const STORAGE_KEYS = {
  appVersion: "quietfeed.appVersion",
  lastActiveMs: "quietfeed.lastActiveMs",
  subreddits: "quietfeed.subreddits",
  banlist: "quietfeed.banlist",
  showTextOnly: "quietfeed.showTextOnly",
  showComments: "quietfeed.showComments",
  page: "quietfeed.page",
  feedGeneratedAt: "quietfeed.feedGeneratedAt",
  seenPersistent: "quietfeed.seenPersistent"
};

const SESSION_KEYS = {
  seenIds: "quietfeed.sessionSeenIds",
  shuffledIds: "quietfeed.sessionShuffledIds"
};

const DEFAULTS = {
  subreddits: ["EarthPorn", "PsychologyMemes", "NatureIsFuckingLit", "SurrealMemes", "cats", "dankmemes"],
  banlist: "politics, war, shooting, death, violence, election",
  showTextOnly: false,
  showComments: true,
  perPage: 20,
  sessionCap: 25,
  textPreviewChars: 700,
  persistentSeenCap: 3000
};

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

function escapeText(s) {
  return (s ?? "").toString();
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
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

function titleAllowed(title, banWords) {
  if (!banWords || banWords.length === 0) return true;
  const t = (title || "").toLowerCase();
  return !banWords.some(word => t.includes(word));
}

function subredditAllowed(itemSub, allowedSubs) {
  if (!allowedSubs || allowedSubs.length === 0) return true;
  const set = new Set(allowedSubs.map(s => (s || "").toLowerCase()));
  return set.has((itemSub || "").toLowerCase());
}

/* ---------- storage migration / reset ---------- */

function migrateIfNeeded() {
  const stored = loadJSON(STORAGE_KEYS.appVersion, null, localStorage);
  if (stored === APP_VERSION) return;

  // Reset settings so you do not inherit old defaults from previous versions.
  // Keep persistent seen history by default (comment out if you want it cleared on upgrade).
  localStorage.removeItem(STORAGE_KEYS.subreddits);
  localStorage.removeItem(STORAGE_KEYS.banlist);
  localStorage.removeItem(STORAGE_KEYS.showTextOnly);
  localStorage.removeItem(STORAGE_KEYS.showComments);
  localStorage.removeItem(STORAGE_KEYS.page);

  // Also reset current session state.
  sessionStorage.removeItem(SESSION_KEYS.seenIds);
  sessionStorage.removeItem(SESSION_KEYS.shuffledIds);

  saveJSON(STORAGE_KEYS.appVersion, APP_VERSION, localStorage);
}

function touchLastActive() {
  saveJSON(STORAGE_KEYS.lastActiveMs, Date.now(), localStorage);
}

function maybeResetSessionForMobile() {
  const last = loadJSON(STORAGE_KEYS.lastActiveMs, null, localStorage);
  const now = Date.now();
  if (typeof last === "number" && now - last > SESSION_IDLE_RESET_MS) {
    // Consider this a new session
    sessionStorage.removeItem(SESSION_KEYS.seenIds);
    sessionStorage.removeItem(SESSION_KEYS.shuffledIds);
    saveJSON(STORAGE_KEYS.page, 1, localStorage);
  }
  touchLastActive();
}

/* ---------- seen tracking ---------- */

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

/* ---------- randomization (stable per session) ---------- */

function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStringToSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function shuffledIdsForSession(items, seedStr) {
  const stored = loadJSON(SESSION_KEYS.shuffledIds, null, sessionStorage);
  if (stored && Array.isArray(stored) && stored.length > 0) return stored;

  const seed = hashStringToSeed(seedStr);
  const rnd = mulberry32(seed);

  const ids = items.map(it => it.id).filter(Boolean);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }

  saveJSON(SESSION_KEYS.shuffledIds, ids, sessionStorage);
  return ids;
}

/* ---------- rendering ---------- */

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
  h2.textContent = escapeText(item.title || "(untitled)");
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

  if (item.video) {
    const wrap = document.createElement("div");
    wrap.className = "img";
    const video = document.createElement("video");
    video.controls = true;
    video.preload = "metadata";
    video.playsInline = true;
    video.src = item.video;
    wrap.appendChild(video);
    card.appendChild(wrap);
  }

  const meta = document.createElement("div");
  meta.className = "meta";

  const left = document.createElement("span");
  left.textContent = `/r/${escapeText(item.subreddit || "")}`;
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

function setPager(page, totalPages, stopReached) {
  document.getElementById("pageInfo").textContent = `Page ${page} / ${Math.max(totalPages, 1)}`;
  document.getElementById("prev").disabled = page <= 1;
  document.getElementById("next").disabled = stopReached || page >= totalPages;
}

async function loadFeed() {
  const res = await fetch("feed.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`feed.json request failed (${res.status})`);
  return await res.json();
}

/* ---------- UI state ---------- */

function getStateFromUI() {
  const banlistRaw = document.getElementById("banlist").value || "";
  const banWords = banlistRaw.split(",").map(w => w.trim().toLowerCase()).filter(Boolean);

  const showTextOnly = document.getElementById("showTextOnly").checked;
  const showComments = document.getElementById("showComments").checked;

  const subsText = document.getElementById("subreddits").value || "";
  const allowedSubs = uniqNormSubs(subsText.split("\n"));

  return { banWords, showTextOnly, showComments, allowedSubs };
}

function persistStateFromUI() {
  saveJSON(STORAGE_KEYS.banlist, document.getElementById("banlist").value || "");
  saveJSON(STORAGE_KEYS.showTextOnly, document.getElementById("showTextOnly").checked);
  saveJSON(STORAGE_KEYS.showComments, document.getElementById("showComments").checked);

  const subsText = document.getElementById("subreddits").value || "";
  saveJSON(STORAGE_KEYS.subreddits, uniqNormSubs(subsText.split("\n")));
}

function restoreUIFromStorage() {
  const subs = loadJSON(STORAGE_KEYS.subreddits, DEFAULTS.subreddits);
  const banlist = loadJSON(STORAGE_KEYS.banlist, DEFAULTS.banlist);
  const showTextOnly = loadJSON(STORAGE_KEYS.showTextOnly, DEFAULTS.showTextOnly);
  const showComments = loadJSON(STORAGE_KEYS.showComments, DEFAULTS.showComments);

  document.getElementById("subreddits").value = (subs || []).join("\n");
  document.getElementById("banlist").value = banlist || "";
  document.getElementById("showTextOnly").checked = !!showTextOnly;
  document.getElementById("showComments").checked = !!showComments;
}

/* ---------- filtering + ordering ---------- */

function applyFilters(items, allowedSubs, banWords, showTextOnly, persistentSeenSet) {
  return (items || []).filter(it => {
    if (!it || !it.id) return false;
    if (persistentSeenSet.has(it.id)) return false;
    if (!subredditAllowed(it.subreddit, allowedSubs)) return false;
    if (!titleAllowed(it.title, banWords)) return false;
    if (!showTextOnly && it.is_text_only) return false;
    return true;
  });
}

function render(items, page, perPage, showComments) {
  const feedEl = document.getElementById("feed");
  feedEl.innerHTML = "";

  const sessionSeen = getSessionSeenSet();
  const persistentSeen = getPersistentSeenSet();

  if (sessionSeen.size >= DEFAULTS.sessionCap) {
    feedEl.appendChild(buildStopScreen());
    setPager(1, 1, true);
    return;
  }

  if (!items || items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "card";
    empty.textContent = "No posts match your filters (or you have already seen them).";
    feedEl.appendChild(empty);
    setPager(1, 1, false);
    return;
  }

  const seedStr = [
    loadJSON(STORAGE_KEYS.feedGeneratedAt, "", localStorage),
    loadJSON(STORAGE_KEYS.subreddits, DEFAULTS.subreddits, localStorage).join("|"),
    loadJSON(STORAGE_KEYS.banlist, DEFAULTS.banlist, localStorage),
    loadJSON(STORAGE_KEYS.showTextOnly, DEFAULTS.showTextOnly, localStorage) ? "T" : "F"
  ].join("::");

  const idOrder = shuffledIdsForSession(items, seedStr);
  const byId = new Map(items.map(it => [it.id, it]));
  const randomized = idOrder.map(id => byId.get(id)).filter(Boolean);

  const totalPages = Math.ceil(randomized.length / perPage);
  const p = clamp(page, 1, totalPages);

  const start = (p - 1) * perPage;
  const pageItems = randomized.slice(start, start + perPage);

  let stopReached = false;

  for (const it of pageItems) {
    if (sessionSeen.size >= DEFAULTS.sessionCap) {
      stopReached = true;
      break;
    }
    feedEl.appendChild(buildCard(it, sessionSeen, persistentSeen, showComments));
  }

  setSessionSeenSet(sessionSeen);
  setPersistentSeenSet(persistentSeen);

  if (sessionSeen.size >= DEFAULTS.sessionCap) {
    stopReached = true;
    feedEl.appendChild(buildStopScreen());
  }

  setPager(p, totalPages, stopReached);
  saveJSON(STORAGE_KEYS.page, p);
}

/* ---------- events ---------- */

function wireEvents(app, updatedLabel) {
  const banEl = document.getElementById("banlist");
  const showTextOnlyEl = document.getElementById("showTextOnly");
  const showCommentsEl = document.getElementById("showComments");

  const saveBtn = document.getElementById("saveSettings");
  const resetBtn = document.getElementById("resetSettings");

  const prevBtn = document.getElementById("prev");
  const nextBtn = document.getElementById("next");

  function setSessionStatus() {
    const seenThisSession = getSessionSeenSet().size;
    const remaining = Math.max(0, DEFAULTS.sessionCap - seenThisSession);
    const capMsg = remaining > 0 ? `${remaining} remaining this session` : "Session limit reached";
    const upd = updatedLabel ? ` • ${updatedLabel}` : "";
    setStatus(`${DEFAULTS.sessionCap} posts per session • ${capMsg}${upd}`);
  }

  function rerender(resetToFirstPage = false) {
    touchLastActive();

    const { banWords, showTextOnly, showComments, allowedSubs } = getStateFromUI();
    const persistentSeen = getPersistentSeenSet();
    const filtered = applyFilters(app.items, allowedSubs, banWords, showTextOnly, persistentSeen);

    const pageStored = loadJSON(STORAGE_KEYS.page, 1);
    const page = resetToFirstPage ? 1 : pageStored;

    persistStateFromUI();
    setSessionStatus();
    render(filtered, page, DEFAULTS.perPage, showComments);
    app.filtered = filtered;
  }

  function resetSessionShuffleAndRerender() {
    sessionStorage.removeItem(SESSION_KEYS.shuffledIds);
    saveJSON(STORAGE_KEYS.page, 1, localStorage);
    rerender(true);
  }

  banEl.addEventListener("input", resetSessionShuffleAndRerender);
  showTextOnlyEl.addEventListener("change", resetSessionShuffleAndRerender);

  showCommentsEl.addEventListener("change", () => rerender(false));

  saveBtn.addEventListener("click", () => rerender(true));

  resetBtn.addEventListener("click", () => {
    document.getElementById("subreddits").value = DEFAULTS.subreddits.join("\n");
    document.getElementById("banlist").value = DEFAULTS.banlist;
    document.getElementById("showTextOnly").checked = DEFAULTS.showTextOnly;
    document.getElementById("showComments").checked = DEFAULTS.showComments;

    saveJSON(STORAGE_KEYS.page, 1, localStorage);

    sessionStorage.removeItem(SESSION_KEYS.seenIds);
    sessionStorage.removeItem(SESSION_KEYS.shuffledIds);

    rerender(true);
  });

  prevBtn.addEventListener("click", () => {
    const current = loadJSON(STORAGE_KEYS.page, 1);
    const next = Math.max(1, (current || 1) - 1);
    saveJSON(STORAGE_KEYS.page, next);
    rerender(false);
    window.scrollTo({ top: 0, behavior: "instant" });
  });

  nextBtn.addEventListener("click", () => {
    const current = loadJSON(STORAGE_KEYS.page, 1);
    const perPage = DEFAULTS.perPage;
    const totalPages = Math.ceil((app.filtered || []).length / perPage);
    const next = Math.min(totalPages, (current || 1) + 1);
    saveJSON(STORAGE_KEYS.page, next);
    rerender(false);
    window.scrollTo({ top: 0, behavior: "instant" });
  });

  rerender(false);
}

/* ---------- lifecycle hooks for mobile ---------- */

function installActivityHooks() {
  // When app goes to background/foreground, treat long gaps as new sessions.
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

/* ---------- main ---------- */

(async function main() {
  migrateIfNeeded();
  maybeResetSessionForMobile();
  installActivityHooks();

  restoreUIFromStorage();
  setStatus("Loading…");

  try {
    const data = await loadFeed();
    const items = data.items || [];

    if (data.generated_at_utc) {
      saveJSON(STORAGE_KEYS.feedGeneratedAt, data.generated_at_utc, localStorage);
    }
    const updatedLabel = humanUpdatedLabel(data.generated_at_utc) || "";

    const app = { items, filtered: [] };
    wireEvents(app, updatedLabel);
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


