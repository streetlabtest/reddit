"use strict";

/*
  Calm Feed: minimalist, allowlisted subreddit reader (RSS).

  This is a static GitHub Pages-friendly implementation. Because browsers enforce CORS,
  RSS is fetched through a public CORS proxy (AllOrigins).
*/

const STORAGE_KEY = "calmFeed.settings.v1";

// Public CORS proxy endpoint.
// AllOrigins supports /raw?url=... which returns the upstream body with permissive CORS headers.
const PROXY_BASE = "https://api.allorigins.win/raw?url=";

const DEFAULT_SETTINGS = Object.freeze({
  subreddits: ["cats"],
  sort: "hot",       // "hot" | "new" | "top"
  topTime: "day",    // "day" | "week" | "month" | "year" | "all"
  limit: 25,         // 5..100
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
refreshFeed().catch(() => { /* errors already reported */ });

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
    setStatus("Reset to defaults. Refreshing…");
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
    const parsed = JSON.parse(raw);
    return sanitizeSettings(parsed);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitizeSettings(settings)));
}

function sanitizeSettings(maybe) {
  const s = { ...DEFAULT_SETTINGS, ...(maybe || {}) };

  s.subreddits = Array.isArray(s.subreddits) ? s.subreddits : DEFAULT_SETTINGS.subreddits;
  s.subreddits = s.subreddits
    .map(normalizeSubreddit)
    .filter(Boolean);

  if (s.subreddits.length === 0) s.subreddits = [...DEFAULT_SETTINGS.subreddits];

  if (!["hot", "new", "top"].includes(s.sort)) s.sort = DEFAULT_SETTINGS.sort;
  if (!["day", "week", "month", "year", "all"].includes(s.topTime)) s.topTime = DEFAULT_SETTINGS.topTime;

  s.limit = Number.isFinite(Number(s.limit)) ? Math.round(Number(s.limit)) : DEFAULT_SETTINGS.limit;
  s.limit = clamp(s.limit, 5, 100);

  s.hideNsfw = Boolean(s.hideNsfw);

  // de-duplicate
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
  s = s.replace(/[^\w]+/g, ""); // keep a-zA-Z0-9_
  return s.toLowerCase();
}

function buildRssUrl(subreddit, settings) {
  const base = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/`;
  const sortPath = settings.sort ? `${settings.sort}/` : "";
  const url = new URL(`${base}${sortPath}.rss`);

  url.searchParams.set("limit", String(settings.limit));
  if (settings.sort === "top") url.searchParams.set("t", settings.topTime);

  return url.toString();
}

function proxied(url) {
  return `${PROXY_BASE}${encodeURIComponent(url)}`;
}

async function refreshFeed() {
  const settings = sanitizeSettings(currentSettings);
  const subs = settings.subreddits;

  els.feed.innerHTML = "";
  setStatus(`Loading r/${subs.join(", r/")}…`);

  const allPosts = [];
  const errors = [];

  for (const sub of subs) {
    try {
      const rssUrl = buildRssUrl(sub, settings);
      const xmlText = await fetchTextWithTimeout(proxied(rssUrl), 15000);
      const posts = parseRedditFeed(xmlText, sub);

      const filtered = settings.hideNsfw ? posts.filter(p => !p.isNsfw) : posts;
      allPosts.push(...filtered);
    } catch (e) {
      errors.push(`r/${sub}`);
    }
  }

  const deduped = dedupePosts(allPosts);
  deduped.sort((a, b) => b.dateMs - a.dateMs);

  renderFeed(deduped);

  const now = new Date();
  const stamp = `${now.toLocaleDateString()} ${now.toLocaleTimeString()}`;

  if (deduped.length === 0 && errors.length > 0) {
    setStatus(`Failed to load: ${errors.join(", ")}. (Proxy/rate-limit issues are common.) Updated: ${stamp}`);
    return;
  }

  if (errors.length > 0) {
    setStatus(`Loaded ${deduped.length} posts. Failed: ${errors.join(", ")}. Updated: ${stamp}`);
  } else {
    setStatus(`Loaded ${deduped.length} posts. Updated: ${stamp}`);
  }
}

async function fetchTextWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      cache: "no-store"
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function parseRedditFeed(xmlText, subreddit) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");

  // Detect parse errors
  if (doc.querySelector("parsererror")) {
    throw new Error("Bad XML (parsererror).");
  }

  const rssItems = Array.from(doc.querySelectorAll("item"));
  if (rssItems.length > 0) return rssItems.map(el => parseRssItem(el, subreddit)).filter(Boolean);

  const atomEntries = Array.from(doc.querySelectorAll("entry"));
  if (atomEntries.length > 0) return atomEntries.map(el => parseAtomEntry(el, subreddit)).filter(Boolean);

  throw new Error("No RSS/Atom items found.");
}

function parseRssItem(item, subreddit) {
  const title = text(item, "title");
  const link = text(item, "link");

  const pubDateRaw = text(item, "pubDate") || text(item, "dc\\:date") || text(item, "date");
  const dateMs = parseDateMs(pubDateRaw);

  const contentHtml =
    text(item, "content\\:encoded") ||
    text(item, "description") ||
    "";

  // Reddit often includes a comments permalink. If not, we fall back to <comments> or <link>.
  const commentsCandidate = text(item, "comments") || link;
  const permalink = pickPermalink(commentsCandidate, link, contentHtml);

  const outboundUrl = extractOutboundUrl(contentHtml, permalink) || link || permalink;
  const mediaUrl = extractMediaUrl(item, contentHtml) || null;

  const isNsfw = detectNsfw(title, item);

  return {
    id: permalink || link || `${subreddit}:${title}:${dateMs}`,
    subreddit,
    title: title || "(untitled)",
    dateMs,
    permalink,
    outboundUrl,
    mediaUrl,
    isNsfw
  };
}

function parseAtomEntry(entry, subreddit) {
  const title = text(entry, "title");

  const altLinkEl = entry.querySelector('link[rel="alternate"]');
  const firstLinkEl = entry.querySelector("link");

  const link =
    (altLinkEl && altLinkEl.getAttribute("href")) ||
    (firstLinkEl && firstLinkEl.getAttribute("href")) ||
    "";

  const updatedRaw = text(entry, "updated") || text(entry, "published");
  const dateMs = parseDateMs(updatedRaw);

  const contentHtml =
    text(entry, "content") ||
    text(entry, "summary") ||
    "";

  const permalink = pickPermalink(link, "", contentHtml);
  const outboundUrl = extractOutboundUrl(contentHtml, permalink) || link || permalink;
  const mediaUrl = extractMediaUrl(entry, contentHtml) || null;

  const isNsfw = detectNsfw(title, entry);

  return {
    id: permalink || link || `${subreddit}:${title}:${dateMs}`,
    subreddit,
    title: title || "(untitled)",
    dateMs,
    permalink,
    outboundUrl,
    mediaUrl,
    isNsfw
  };
}

function text(root, selector) {
  const el = root.querySelector(selector);
  return (el && el.textContent ? el.textContent.trim() : "");
}

function parseDateMs(raw) {
  if (!raw) return Date.now();
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : Date.now();
}

function pickPermalink(a, b, contentHtml) {
  // Prefer a Reddit comments URL if present.
  const candidates = [a, b, extractFirstRedditPermalink(contentHtml)].filter(Boolean);
  for (const c of candidates) {
    if (looksLikeRedditPermalink(c)) return c;
  }
  return candidates[0] || "";
}

function looksLikeRedditPermalink(url) {
  return /\/comments\/[a-z0-9]+/i.test(url);
}

function extractFirstRedditPermalink(contentHtml) {
  const links = extractLinksFromHtml(contentHtml);
  return links.find(u => looksLikeRedditPermalink(u)) || "";
}

function extractOutboundUrl(contentHtml, permalink) {
  const links = extractLinksFromHtml(contentHtml);

  // Prefer a non-permalink absolute URL.
  for (const u of links) {
    if (!u.startsWith("http")) continue;
    if (permalink && normalizeUrl(u) === normalizeUrl(permalink)) continue;
    return u;
  }
  return "";
}

function extractMediaUrl(itemEl, contentHtml) {
  // 1) media:content / media:thumbnail (RSS style)
  const media = itemEl.querySelector("media\\:content, media\\:thumbnail");
  if (media) {
    const u = media.getAttribute("url");
    if (u) return u;
  }

  // 2) first <img src="..."> in HTML content
  const img = extractFirstImgFromHtml(contentHtml);
  if (img) return img;

  // 3) first link that looks like an image
  const links = extractLinksFromHtml(contentHtml);
  const imgLink = links.find(looksLikeImageUrl);
  return imgLink || "";
}

function extractLinksFromHtml(html) {
  if (!html) return [];
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const anchors = Array.from(doc.querySelectorAll("a"));
  const hrefs = anchors
    .map(a => a.getAttribute("href") || "")
    .map(s => s.trim())
    .filter(s => s.startsWith("http"));
  return hrefs;
}

function extractFirstImgFromHtml(html) {
  if (!html) return "";
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const img = doc.querySelector("img");
  const src = img ? (img.getAttribute("src") || "").trim() : "";
  return src.startsWith("http") ? src : "";
}

function looksLikeImageUrl(url) {
  if (!url) return false;
  const u = url.toLowerCase();
  if (/\.(png|jpe?g|gif|webp)(\?|#|$)/i.test(u)) return true;
  // Common Reddit image hosts even when extensions vary.
  if (u.includes("i.redd.it/") || u.includes("preview.redd.it/")) return true;
  return false;
}

function detectNsfw(title, itemEl) {
  const t = (title || "").toLowerCase();
  if (/\bnsfw\b/.test(t)) return true;

  const categories = Array.from(itemEl.querySelectorAll("category"))
    .map(c => (c.textContent || c.getAttribute("term") || "").toLowerCase())
    .join(" ");

  return /\bnsfw\b/.test(categories);
}

function dedupePosts(posts) {
  const seen = new Set();
  const out = [];
  for (const p of posts) {
    const key = normalizeUrl(p.permalink || p.outboundUrl || p.id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function normalizeUrl(u) {
  try {
    return new URL(u).toString();
  } catch {
    return String(u || "");
  }
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
  badge.textContent = `r/${p.subreddit}`;

  const time = document.createElement("span");
  time.textContent = formatRelativeTime(p.dateMs);

  meta.appendChild(badge);
  meta.appendChild(time);

  const titleLink = document.createElement("a");
  titleLink.className = "titlelink";
  titleLink.href = p.outboundUrl || p.permalink || "#";
  titleLink.target = "_blank";
  titleLink.rel = "noopener noreferrer";
  titleLink.textContent = p.title;

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
  body.appendChild(actions);

  article.appendChild(body);

  if (p.mediaUrl && looksLikeImageUrl(p.mediaUrl)) {
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
