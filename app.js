"use strict";

const STORAGE_KEY = "calmFeed.settings.v2";

const DEFAULT_SETTINGS = Object.freeze({
  subreddits: ["cats"],     // UI-only; global feed is produced by GitHub Actions
  sort: "hot",
  topTime: "day",
  limit: 25,
  hideNsfw: true,
  showTextOnly: false       // (a) OFF by default: hide text-only posts
});

const els = {
  refreshBtn: document.getElementById("refreshBtn"),
  toggleSettingsBtn: document.getElementById("toggleSettingsBtn"),
  settingsPanel: document.getElementById("settingsPanel"),
  settingsForm: document.getElementById("settingsForm"),
  subsInput: document.getElementById("subsInput"),
  sortSelect: document.getElementById("sortSelect"),
  timeSelect: document.getElementById("timeSelect"),
  topTimeField: document.getElementById("topTimeField"),
  limitInput: document.getElementById("limitInput"),
  hideNsfwInput: document.getElementById("hideNsfwInput"),
  showTextOnlyInput: document.getElementById("showTextOnlyInput"),
  resetBtn: document.getElementById("resetBtn"),
  status: document.getElementById("status"),
  feed: document.getElementById("feed")
};

let currentSettings = loadSettings();

initUI();
refreshFeed();

function initUI() {
  applySettingsToForm(currentSettings);
  updateTopTimeVisibility();

  els.refreshBtn.addEventListener("click", () => refreshFeed());
  els.toggleSettingsBtn.addEventListener("click", toggleSettings);
  els.sortSelect.addEventListener("change", updateTopTimeVisibility);

  els.settingsForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const next = readSettingsFromForm();
    currentSettings = next;
    saveSettings(next);
    setStatus("Saved. Refreshing…");
    refreshFeed();
  });

  els.resetBtn.addEventListener("click", () => {
    currentSettings = { ...DEFAULT_SETTINGS };
    saveSettings(currentSettings);
    applySettingsToForm(currentSettings);
    updateTopTimeVisibility();
    setStatus("Reset. Refreshing…");
    refreshFeed();
  });
}

function toggleSettings() {
  const isHidden = els.settingsPanel.classList.contains("hidden");
  els.settingsPanel.classList.toggle("hidden", !isHidden);
  els.toggleSettingsBtn.setAttribute("aria-expanded", String(isHidden));
}

function updateTopTimeVisibility() {
  const show = els.sortSelect.value === "top";
  els.topTimeField.style.display = show ? "block" : "none";
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return sanitizeSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitizeSettings(settings)));
}

function sanitizeSettings(maybe) {
  const s = { ...DEFAULT_SETTINGS, ...(maybe || {}) };

  s.subreddits = Array.isArray(s.subreddits) ? s.subreddits : [...DEFAULT_SETTINGS.subreddits];
  s.subreddits = s.subreddits.map(normalizeSubreddit).filter(Boolean);
  if (s.subreddits.length === 0) s.subreddits = [...DEFAULT_SETTINGS.subreddits];

  if (!["hot", "new", "top"].includes(s.sort)) s.sort = DEFAULT_SETTINGS.sort;
  if (!["day", "week", "month", "year", "all"].includes(s.topTime)) s.topTime = DEFAULT_SETTINGS.topTime;

  s.limit = Number.isFinite(Number(s.limit)) ? Math.round(Number(s.limit)) : DEFAULT_SETTINGS.limit;
  s.limit = clamp(s.limit, 5, 100);

  s.hideNsfw = Boolean(s.hideNsfw);
  s.showTextOnly = Boolean(s.showTextOnly);

  s.subreddits = Array.from(new Set(s.subreddits));
  return s;
}

function applySettingsToForm(settings) {
  els.subsInput.value = settings.subreddits.join("\n");
  els.sortSelect.value = settings.sort;
  els.timeSelect.value = settings.topTime;
  els.limitInput.value = String(settings.limit);
  els.hideNsfwInput.checked = settings.hideNsfw;
  els.showTextOnlyInput.checked = settings.showTextOnly;
}

function readSettingsFromForm() {
  const subs = els.subsInput.value
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(normalizeSubreddit);

  return sanitizeSettings({
    subreddits: subs,
    sort: els.sortSelect.value,
    topTime: els.timeSelect.value,
    limit: Number(els.limitInput.value),
    hideNsfw: els.hideNsfwInput.checked,
    showTextOnly: els.showTextOnlyInput.checked
  });
}

function normalizeSubreddit(input) {
  if (!input) return "";
  let s = input.trim();
  s = s.replace(/^\/?r\//i, "");
  s = s.replace(/^\/+|\/+$/g, "");
  s = s.replace(/[^\w]+/g, "");
  return s.toLowerCase();
}

async function refreshFeed() {
  els.feed.innerHTML = "";
  setStatus("Loading…");

  try {
    const basePath = location.pathname.endsWith("/") ? location.pathname : location.pathname + "/";
    const url = `${location.origin}${basePath}feed.json?v=${Date.now()}`;

    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    let posts = Array.isArray(data.posts) ? data.posts : [];

    // Apply (a) filter: hide text-only posts unless user enables them.
    const showTextOnly = currentSettings.showTextOnly;
    posts = posts.filter(p => showTextOnly || !isTextOnlyPost(p));

    renderFeed(posts);

    const stamp = (data.generatedAt || "").replace("T", " ").replace("Z", " UTC");
    if (data.errors && data.errors.length) {
      setStatus(`Loaded ${posts.length} posts. Failed: r/${data.errors.join(", r/")}. Updated: ${stamp || "recently"}`);
    } else {
      setStatus(`Loaded ${posts.length} posts. Updated: ${stamp || "recently"}`);
    }
  } catch {
    setStatus("Failed to load feed.json (see console).");
    renderFeed([]);
  }
}

function isTextOnlyPost(p) {
  const hasMedia = Boolean(p && (p.mediaUrl || p.videoUrl));
  if (hasMedia) return false;

  // If contentHtml contains ONLY the common "submitted by" / link/comments boilerplate,
  // treat it as text-only (we'll also remove it from display regardless).
  const raw = String(p.contentHtml || "").trim();
  if (!raw) return true;

  const cleaned = cleanRedditBoilerplate(raw).trim();
  return cleaned.length === 0;
}

function renderFeed(posts) {
  els.feed.innerHTML = "";

  if (!posts || posts.length === 0) {
    const empty = document.createElement("div");
    empty.className = "hint";
    empty.textContent = "No posts to display.";
    els.feed.appendChild(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const p of posts) frag.appendChild(renderPost(p));
  els.feed.appendChild(frag);
}

function renderPost(p) {
  const article = document.createElement("article");
  article.className = "post";

  const body = document.createElement("div");
  body.className = "post-body";

  const meta = document.createElement("div");
  meta.className = "meta";

  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = `r/${p.subreddit || "?"}`;

  const time = document.createElement("span");
  time.textContent = formatRelativeTime(Number(p.dateMs) || Date.now());

  meta.appendChild(badge);
  meta.appendChild(time);

  const titleLink = document.createElement("a");
  titleLink.className = "titlelink";
  titleLink.href = p.outboundUrl || p.permalink || "#";
  titleLink.target = "_blank";
  titleLink.rel = "noopener noreferrer";
  titleLink.textContent = p.title || "(untitled)";

  const actions = document.createElement("div");
  actions.className = "post-actions";

  const comments = document.createElement("a");
  comments.href = p.permalink || p.outboundUrl || "#";
  comments.target = "_blank";
  comments.rel = "noopener noreferrer";
  comments.textContent = "Comments";

  actions.appendChild(comments);

  body.appendChild(meta);
  body.appendChild(titleLink);

  // (b) Remove "submitted by /u/..." and link/comments boilerplate from contentHtml.
  const cleanedHtml = cleanRedditBoilerplate(String(p.contentHtml || ""));
  const excerptHtml = excerptHtmlSafe(cleanedHtml);

  if (excerptHtml) {
    const content = document.createElement("div");
    content.className = "post-content";
    content.innerHTML = excerptHtml;
    body.appendChild(content);
  }

  body.appendChild(actions);
  article.appendChild(body);

  // Media: show only the main media block (not inline content thumbnails)
  if (p.videoUrl && looksLikeMp4(p.videoUrl)) {
    const media = document.createElement("div");
    media.className = "media";

    const video = document.createElement("video");
    video.controls = true;
    video.preload = "metadata";
    video.src = p.videoUrl;

    media.appendChild(video);
    article.appendChild(media);
  } else if (p.mediaUrl && looksLikeImageUrl(p.mediaUrl)) {
    const media = document.createElement("div");
    media.className = "media";

    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.src = p.mediaUrl;

    media.appendChild(img);
    article.appendChild(media);
  }

  return article;
}

function cleanRedditBoilerplate(html) {
  if (!html) return "";

  // Parse to DOM to remove unwanted elements and attributes safely.
  const temp = document.createElement("div");
  temp.innerHTML = html;

  // Drop potentially unsafe tags.
  temp.querySelectorAll("script, iframe, object, embed, style").forEach(n => n.remove());

  // Remove event handlers.
  temp.querySelectorAll("*").forEach(el => {
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
    }
  });

  // Remove common "submitted by" text blocks and [link] [comments] patterns:
  // Approach: remove anchors/strings that match those patterns.
  // 1) Remove anchors linking to user profiles (/user/ or /u/)
  temp.querySelectorAll('a[href*="/user/"], a[href*="/u/"]').forEach(a => a.remove());

  // 2) Remove bracket links like [link] [comments] if present as anchors
  temp.querySelectorAll("a").forEach(a => {
    const t = (a.textContent || "").trim().toLowerCase();
    if (t === "link" || t === "comments") a.remove();
  });

  // 3) Remove literal "submitted by" phrases in text nodes (best-effort)
  const text = (temp.textContent || "").toLowerCase();
  if (text.includes("submitted by")) {
    // If the entire block is just boilerplate, clear it.
    // Otherwise, we rely on excerpting below.
  }

  return temp.innerHTML;
}

function excerptHtmlSafe(html) {
  const s = String(html || "").trim();
  if (!s) return "";

  // Build a clean excerpt: allow only a small set of tags, strip images (handled separately).
  const temp = document.createElement("div");
  temp.innerHTML = s;

  // Remove images from excerpt (keeps layout clean; media is rendered below)
  temp.querySelectorAll("img").forEach(img => img.remove());

  // Allowlist tags; unwrap others
  const allowed = new Set(["A", "P", "BR", "EM", "STRONG", "B", "I", "UL", "OL", "LI", "BLOCKQUOTE", "CODE"]);
  temp.querySelectorAll("*").forEach(el => {
    if (!allowed.has(el.tagName)) {
      // unwrap element
      const parent = el.parentNode;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
    } else if (el.tagName === "A") {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    }
  });

  // If after cleaning the text is empty, do not render.
  const plain = (temp.textContent || "").trim();
  if (!plain) return "";

  return temp.innerHTML;
}

function looksLikeImageUrl(url) {
  const u = String(url || "").toLowerCase();
  if (!u) return false;
  if (/\.(png|jpe?g|gif|webp)(\?|#|$)/i.test(u)) return true;
  if (u.includes("i.redd.it/") || u.includes("preview.redd.it/") || u.includes("i.imgur.com/")) return true;
  return false;
}

function looksLikeMp4(url) {
  const u = String(url || "").toLowerCase();
  return u.endsWith(".mp4");
}

function formatRelativeTime(dateMs) {
  const diff = Date.now() - dateMs;
  const abs = Math.abs(diff);

  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;

  if (abs < minute) return "just now";
  if (abs < hour) return `${Math.floor(abs / minute)}m`;
  if (abs < day) return `${Math.floor(abs / hour)}h`;
  if (abs < week) return `${Math.floor(abs / day)}d`;
  return `${Math.floor(abs / week)}w`;
}

function setStatus(msg) {
  els.status.textContent = msg;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
