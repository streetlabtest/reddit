/* Quiet Feed client
   - Loads feed.json (built by GitHub Actions)
   - Local controls:
       * allowed subreddits (textarea)
       * ban list (negative keywords, comma separated)
       * show text-only toggle
   - Session cap: 25 posts per session (sessionStorage)
   - Text truncation with "Show more"
   - Video support (mp4/webm) via native <video> control (no autoplay)
   - No display of total feed size; status shows "25 posts per session" + updated label
*/

const STORAGE_KEYS = {
  subreddits: "quietfeed.subreddits",
  banlist: "quietfeed.banlist",
  showTextOnly: "quietfeed.showTextOnly",
  page: "quietfeed.page"
};

const SESSION_KEYS = {
  seenIds: "quietfeed.sessionSeenIds" // sessionStorage
};

const DEFAULTS = {
  subreddits: ["EarthPorn", "NatureIsFuckingLit", "Eyebleach", "CozyPlaces", "mildlyinteresting"],
  banlist: "politics, war, shooting, death, violence, election",
  showTextOnly: false,
  perPage: 20,
  sessionCap: 25,
  textPreviewChars: 700
};

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

function getSessionSeenSet() {
  const arr = loadJSON(SESSION_KEYS.seenIds, [], sessionStorage);
  const set = new Set(Array.isArray(arr) ? arr : []);
  return set;
}

function setSessionSeenSet(set) {
  saveJSON(SESSION_KEYS.seenIds, Array.from(set), sessionStorage);
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

function buildCard(item, sessionSeenSet) {
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

  // If there's an image, show it (image after text)
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

  // If there's a video, show a native player (no autoplay)
  if (item.video) {
    const wrap = document.createElement("div");
    wrap.className = "img";
    const video = document.createElement("video");
    video.controls = true;
    video.preload = "metadata";
    video.playsInline = true;
    // Do not set autoplay; user initiates.
    video.src = item.video;
    wrap.appendChild(video);
    card.appendChild(wrap);
  }

  const meta = document.createElement("div");
  meta.className = "meta";

  // Show subreddit only (no author/submitter)
  const left = document.createElement("span");
  left.textContent = `/r/${escapeText(item.subreddit || "")}`;
  meta.appendChild(left);

  const comments = document.createElement("a");
  comments.href = item.comments_url;
  comments.target = "_blank";
  comments.rel = "noopener noreferrer";
  comments.textContent = "Comments";
  meta.appendChild(comments);

  if (item.external_url) {
    const open = document.createElement("a");
    open.href = item.external_url;
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    open.textContent = "Open";
    meta.appendChild(open);
  }

  card.appendChild(meta);

  // Mark as seen
  if (item.id) {
    sessionSeenSet.add(item.id);
  }

  return card;
}

async function loadFeed() {
  const res = await fetch("feed.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`feed.json request failed (${res.status})`);
  return await res.json();
}

function getStateFromUI() {
  const banlistRaw = document.getElementById("banlist").value || "";
  const banWords = banlistRaw
    .split(",")
    .map(w => w.trim().toLowerCase())
    .filter(Boolean);

  const showTextOnly = document.getElementById("showTextOnly").checked;

  const subsText = document.getElementById("subreddits").value || "";
  const allowedSubs = uniqNormSubs(subsText.split("\n"));

  return { banWords, showTextOnly, allowedSubs };
}

function persistStateFromUI() {
  const banlist = document.getElementById("banlist").value || "";
  saveJSON(STORAGE_KEYS.banlist, banlist);
  const showTextOnly = document.getElementById("showTextOnly").checked;
  saveJSON(STORAGE_KEYS.showTextOnly, showTextOnly);
  const subsText = document.getElementById("subreddits").value || "";
  const allowedSubs = uniqNormSubs(subsText.split("\n"));
  saveJSON(STORAGE_KEYS.subreddits, allowedSubs);
}

function restoreUIFromStorage() {
  const subs = loadJSON(STORAGE_KEYS.subreddits, DEFAULTS.subreddits);
  const banlist = loadJSON(STORAGE_KEYS.banlist, DEFAULTS.banlist);
  const showTextOnly = loadJSON(STORAGE_KEYS.showTextOnly, DEFAULTS.showTextOnly);

  document.getElementById("subreddits").value = (subs || []).join("\n");
  document.getElementById("banlist").value = banlist || "";
  document.getElementById("showTextOnly").checked = !!showTextOnly;
}

function setPager(page, totalPages, stopReached) {
  document.getElementById("pageInfo").textContent = `Page ${page} / ${Math.max(totalPages, 1)}`;
  document.getElementById("prev").disabled = page <= 1;
  document.getElementById("next").disabled = stopReached || page >= totalPages;
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

function applyFilters(items, allowedSubs, banWords, showTextOnly) {
  return (items || []).filter(it => {
    if (!subredditAllowed(it.subreddit, allowedSubs)) return false;
    if (!titleAllowed(it.title, banWords)) return false;
    if (!showTextOnly && it.is_text_only) return false;
    return true;
  });
}

function render(items, page, perPage) {
  const feedEl = document.getElementById("feed");
  feedEl.innerHTML = "";

  const sessionSeen = getSessionSeenSet();
  const alreadySeenCount = sessionSeen.size;

  if (alreadySeenCount >= DEFAULTS.sessionCap) {
    feedEl.appendChild(buildStopScreen());
    setPager(1, 1, true);
    return;
  }

  if (!items || items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "card";
    empty.textContent = "No posts match your filters.";
    feedEl.appendChild(empty);
    setPager(1, 1, false);
    return;
  }

  const totalPages = Math.ceil(items.length / perPage);
  const p = clamp(page, 1, totalPages);

  const start = (p - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);

  let stopReached = false;

  for (const it of pageItems) {
    if (sessionSeen.size >= DEFAULTS.sessionCap) {
      stopReached = true;
      break;
    }
    feedEl.appendChild(buildCard(it, sessionSeen));
  }

  setSessionSeenSet(sessionSeen);

  if (sessionSeen.size >= DEFAULTS.sessionCap) {
    stopReached = true;
    feedEl.appendChild(buildStopScreen());
  }

  setPager(p, totalPages, stopReached);
  saveJSON(STORAGE_KEYS.page, p);
}

function wireEvents(app) {
  const banEl = document.getElementById("banlist");
  const showTextOnlyEl = document.getElementById("showTextOnly");

  const saveBtn = document.getElementById("saveSettings");
  const resetBtn = document.getElementById("resetSettings");

  const prevBtn = document.getElementById("prev");
  const nextBtn = document.getElementById("next");

  function rerender(resetToFirstPage = false) {
    const { banWords, showTextOnly, allowedSubs } = getStateFromUI();
    const filtered = applyFilters(app.items, allowedSubs, banWords, showTextOnly);

    const pageStored = loadJSON(STORAGE_KEYS.page, 1);
    const page = resetToFirstPage ? 1 : pageStored;

    persistStateFromUI();

    const seen = getSessionSeenSet().size;
    // Display static "25 posts per session" + updated label is handled on load; keep status minimal here
    const remaining = Math.max(0, DEFAULTS.sessionCap - seen);
    const capMsg = remaining > 0 ? `${remaining} remaining this session` : `Session limit reached`;
    setStatus(`${DEFAULTS.sessionCap} posts per session • ${capMsg}`);

    render(filtered, page, DEFAULTS.perPage);
    app.filtered = filtered;
  }

  banEl.addEventListener("input", () => rerender(true));
  showTextOnlyEl.addEventListener("change", () => rerender(true));

  saveBtn.addEventListener("click", () => rerender(true));

  resetBtn.addEventListener("click", () => {
    document.getElementById("subreddits").value = DEFAULTS.subreddits.join("\n");
    document.getElementById("banlist").value = DEFAULTS.banlist;
    document.getElementById("showTextOnly").checked = DEFAULTS.showTextOnly;
    saveJSON(STORAGE_KEYS.page, 1);
    sessionStorage.removeItem(SESSION_KEYS.seenIds);
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

(async function main() {
  restoreUIFromStorage();
  setStatus("Loading…");

  try {
    const data = await loadFeed();
    const items = data.items || [];

    const updatedLabel = humanUpdatedLabel(data.generated_at_utc) || "";
    setStatus(`${DEFAULTS.sessionCap} posts per session • ${updatedLabel}`);

    const app = { items, filtered: [] };
    wireEvents(app);
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
