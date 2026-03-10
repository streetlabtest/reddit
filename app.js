"use strict";

const feedEl = document.getElementById("feed");
const statusEl = document.getElementById("status");
const refreshBtn = document.getElementById("refreshBtn");

refreshBtn.addEventListener("click", loadFeed);
loadFeed();

async function loadFeed() {
  feedEl.innerHTML = "";
  statusEl.textContent = "Loading…";

  try {
    const res = await fetch("./feed.json", { cache: "no-store" });
    if (!res.ok) throw new Error("feed.json not found");
    const data = await res.json();

    const posts = (data.posts || []).filter(p => !isTextOnly(p));

    render(posts);

    statusEl.textContent =
      `Loaded ${posts.length} posts. Updated: ${data.generatedAt || ""}`;
  } catch (e) {
    statusEl.textContent = "Failed to load feed.json.";
  }
}

function isTextOnly(p) {
  const hasMedia = !!p.mediaUrl || !!p.videoUrl;
  const text = (p.text || "").trim();
  return !hasMedia && text.length === 0;
}

function render(posts) {
  if (!posts.length) {
    feedEl.innerHTML = "<div>No posts to display.</div>";
    return;
  }

  for (const p of posts) {
    const card = document.createElement("article");
    card.className = "post";

    const title = document.createElement("h2");
    title.textContent = p.title;

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `r/${p.subreddit} • ${relativeTime(p.dateMs)}`;

    card.appendChild(title);
    card.appendChild(meta);

    if (p.text) {
      const body = document.createElement("div");
      body.textContent = p.text;
      card.appendChild(body);
    }

    if (p.mediaUrl) {
      const img = document.createElement("img");
      img.src = p.mediaUrl;
      img.loading = "lazy";
      card.appendChild(img);
    }

    if (p.videoUrl && p.videoUrl.endsWith(".mp4")) {
      const video = document.createElement("video");
      video.src = p.videoUrl;
      video.controls = true;
      card.appendChild(video);
    }

    const comments = document.createElement("a");
    comments.href = p.permalink;
    comments.target = "_blank";
    comments.textContent = "Comments";
    card.appendChild(comments);

    feedEl.appendChild(card);
  }
}

function relativeTime(ms) {
  const diff = Date.now() - ms;
  const h = Math.floor(diff / 3600000);
  if (h < 1) return "just now";
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
