"use strict";

const STORAGE_KEY = "calmFeed.settings.v3";

const DEFAULT_SETTINGS = Object.freeze({
  subreddits: ["cats"],        // UI-only
  sort: "hot",
  topTime: "day",
  limit: 25,
  hideNsfw: true,
  showTextOnly: false,         // off by default
  enableTitleFilter: true,     // on by default (optional but recommended)
  titleFilter: "dying, lost, cancer"
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
  enableTitleFilterInput: document.getElementById("enableTitleFilterInput"),
  titleFilterInput: document.getElementById("titleFilterInput"),
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
  updateTitleFilterEnabledUI();

  els.refreshBtn.addEventListener("click", () => refreshFeed());
  els.toggleSettingsBtn.addEventListener("click", toggleSettings);
  els.sortSelect.addEventListener("change", updateTopTimeVisibility);
  els.enableTitleFilterInput.addEventListener("change", updateTitleFilterEnabledUI);

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
    updateTitleFilterEnabledUI();
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

function updateTitleFilterEnabledUI() {
  els.titleFilterInput.disabled = !els.enableTitleFilterInput.checked;
  els.titleFilterInput.style.opacity = els.enableTitleFilterInput.checked ? "1" : "0.65";
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

  s.enableTitleFilter = Boolean(s.enableTitleFilter);
  s.titleFilter = String(s.titleFilter || "");

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

  els.enableTitleFilterInput.checked = settings.enableTitleFilter;
  els.titleFilterInput.value = settings.titleFilter;
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
    showTextOnly: els.showTextOnlyInput.checked,
    enableTitleFilter: els.enableTitleFilterInput.checked,
    titleFilter: els.titleFilterInput.value
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

    // Title keyword filter (optional)
    const filters = buildTitleFilters(currentSettings);
    if (filters.enabled && filters.keywords.length) {
      posts = posts.filter(p => !titleMatchesAny(String(p.title || ""), filters.keywords));
    }

    // Text-only filter (default hides text-only)
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

function buildTitleFilters(settings) {
  const enabled = Boolean(settings.enableTitleFilter);
  const keywords = String(settings.titleFilter || "")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  return { enabled, keywords };
}

function titleMatchesAny(title, keywords) {
  const t = String(title || "").toLowerCase();
  for (const k of keywords) {
    if (k && t.includes(k)) return true;
  }
  return false;
}

function isTextOnlyPost(p) {
  const hasMedia = Boolean(p && (p.mediaUrl || p.videoUrl));
  if (hasMedia) return false;

  const raw = String(p.contentHtml || "").trim();
  if (!raw) return true;

  const cleaned = extractMeaningfulText(raw).trim();
  return cleaned.length === 0;
}

function renderFeed(posts) {
  els.feed.innerHTML = "";

  if (!posts || posts.length === 0) {
    const empty = document.createElement("div");
    empty.className = "hint";
    empty.textContent = "No posts to display (or all were filtered).";
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

  // Clean and render excerpt (no "submitted by", no [link] [comments])
  const excerpt = buildExcerptHtml(p.contentHtml);
  if (excerpt) {
    const content = document.createElement("div");
    content.className = "post-content";
    content.innerHTML = excerpt;
    body.appendChild(content);
  }

  body.appendChild(actions);
  article.appendChild(body);

  // Media (kept separate and clean)
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

function buildExcerptHtml(contentHtml) {
  const raw = String(contentHtml || "").trim();
  if (!raw) return "";

  const temp = document.createElement("div");
  temp.innerHTML = raw;

  // Remove unsafe elements
  temp.querySelectorAll("script, iframe, object, embed, style").forEach(n => n.remove());

  // Remove images from excerpt (media rendered separately)
  temp.querySelectorAll("img").forEach(img => img.remove());

  // Remove user/profile links and typical boilerplate anchors
  temp.querySelectorAll('a[href*="/user/"], a[href*="/u/"]').forEach(a => a.remove());

  // Remove [link] [comments] anchors by text content
  temp.querySelectorAll("a").forEach(a => {
    const t = (a.textContent || "").trim().toLowerCase();
    if (t === "link" || t === "comments") a.remove();
  });

  // Remove “submitted by” text nodes / paragraphs
  removeTextMatching(temp, /\bsubmitted by\b/i);

  // Strip event handlers
  temp.querySelectorAll("*").forEach(el => {
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
    }
  });

  // Allowlist tags and unwrap others
  const allowed = new Set(["A", "P", "BR", "EM", "STRONG", "B", "I", "UL", "OL", "LI", "BLOCKQUOTE", "CODE"]);
  temp.querySelectorAll("*").forEach(el => {
    if (!allowed.has(el.tagName)) {
      const parent = el.parentNode;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
    } else if (el.tagName === "A") {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    }
  });

  // If nothing meaningful remains, return empty
  const plain = (temp.textContent || "").trim();
  if (!plain) return "";

  // Further: if it is ONLY the word "submitted by" etc., drop it
  if (!extractMeaningfulText(temp.innerHTML).trim()) return "";

  return temp.innerHTML;
}

function extractMeaningfulText(html) {
  const temp = document.createElement("div");
  temp.innerHTML = String(html || "");

  // Remove boilerplate elements
  temp.querySelectorAll("script, iframe, object, embed, style, img").forEach(n => n.remove());
  temp.querySelectorAll('a[href*="/user/"], a[href*="/u/"]').forEach(a => a.remove());
  temp.querySelectorAll("a").forEach(a => {
    const t = (a.textContent || "").trim().toLowerCase();
    if (t === "link" || t === "comments") a.remove();
  });
  removeTextMatching(temp, /\bsubmitted by\b/i);

  return (temp.textContent || "").replace(/\s+/g, " ").trim();
}

function removeTextMatching(root, regex) {
  // Remove whole <p>/<div>/<span> blocks whose text matches regex after trimming.
  const candidates = root.querySelectorAll("p, div, span, li, blockquote");
  candidates.forEach(el => {
    const t = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (t && regex.test(t)) {
      el.remove();
    }
  });

  // Also remove standalone text nodes containing the phrase
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const toClear = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const t = (node.nodeValue || "");
    if (regex.test(t)) toClear.push(node);
  }
  toClear.forEach(n => { n.nodeValue = ""; });
}

function looksLikeImageUrl(url) {
  const u = String(url || "").toLowerCase();
  if (!u) return false;
  if (/\.(png|jpe?g|gif|webp)(\?|#|$)/i.test(u)) return true;
  if (u.includes("i.redd.it/") || u.includes("preview.redd.it/") || u.includes("i.imgur.com/")) return true;
  return false;
}

function looksLikeMp4(url) {
  return String(url || "").toLowerCase().endsWith(".mp4");
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
