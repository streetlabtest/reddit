"use strict";

const STORAGE_KEY = "calmFeed.settings.v1";

const DEFAULT_SETTINGS = Object.freeze({
  subreddits: ["cats"], // UI-only; actual feed is produced by GitHub Actions
  sort: "hot",
  topTime: "day",
  limit: 25,
  hideNsfw: true
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
    setStatus("Saved locally. Refreshing…");
    refreshFeed();
  });

  els.resetBtn.addEventListener("click", () => {
    currentSettings = { ...DEFAULT_SETTINGS };
    saveSettings(currentSettings);
    applySettingsToForm(currentSettings);
    updateTopTimeVisibility();
    setStatus("Reset locally. Refreshing…");
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

  s.subreddits = Array.from(new Set(s.subreddits));
  return s;
}

function applySettingsToForm(settings) {
  els.subsInput.value = settings.subreddits.join("\n");
  els.sortSelect.value = settings.sort;
  els.timeSelect.value = settings.topTime;
  els.limitInput.value = String(settings.limit);
  els.hideNsfwInput.checked = settings.hideNsfw;
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
    hideNsfw: els.hideNsfwInput.checked
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
    const posts = Array.isArray(data.posts) ? data.posts : [];

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

  // Content text/HTML (sanitized)
  if (p.contentHtml) {
    const content = document.createElement("div");
    content.className = "post-content";

    const temp = document.createElement("div");
    temp.innerHTML = String(p.contentHtml);

    // Remove dangerous tags entirely
    temp.querySelectorAll("script, iframe, object, embed").forEach(n => n.remove());

    // Strip event handler attributes (onload, onclick, etc.)
    temp.querySelectorAll("*").forEach(el => {
      for (const attr of Array.from(el.attributes)) {
        if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
      }
    });

    content.innerHTML = temp.innerHTML;
    body.appendChild(content);
  }

  body.appendChild(actions);
  article.appendChild(body);

  // Video (direct mp4 only)
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
    // Image
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

function looksLikeImageUrl(url) {
  const u = String(url || "").toLowerCase();
  if (!u) return false;
  if (/\.(png|jpe?g|gif|webp)(\?|#|$)/i.test(u)) return true;
  if (u.includes("i.redd.it/") || u.includes("preview.redd.it/")) return true;
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
