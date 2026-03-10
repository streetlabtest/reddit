#!/usr/bin/env python3
import json
import os
import re
import time
from datetime import datetime, timezone
from urllib.parse import urlencode
import urllib.request
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_PATH = os.path.join(ROOT, "feed.json")

DEFAULT_SUBS = ["cats"]
DEFAULT_SORT = "hot"     # hot | new | top
DEFAULT_TOP_T = "day"    # day | week | month | year | all
DEFAULT_LIMIT = 25
MAX_ITEMS_TOTAL = 200

UA = "CalmFeedGitHubActions/1.0 (+https://github.com/)"

def env_list(name, default):
    raw = os.environ.get(name, "")
    if not raw.strip():
        return default
    subs = []
    for s in raw.split(","):
        s = s.strip().lower()
        s = re.sub(r"^/?r/", "", s)
        s = re.sub(r"[^\w]", "", s)
        if s:
            subs.append(s)
    return list(dict.fromkeys(subs)) or default

def env_str(name, default, allowed=None):
    v = os.environ.get(name, default).strip().lower()
    if allowed and v not in allowed:
        return default
    return v

def env_int(name, default, lo, hi):
    try:
        v = int(os.environ.get(name, str(default)))
    except Exception:
        v = default
    return max(lo, min(hi, v))

def fetch_url(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read()

def build_rss_url(sub, sort, top_t, limit):
    base = f"https://www.reddit.com/r/{sub}/{sort}/.rss"
    params = {"limit": str(limit)}
    if sort == "top":
        params["t"] = top_t
    return base + "?" + urlencode(params)

def text(el, tag):
    child = el.find(tag)
    return (child.text or "").strip() if child is not None and child.text else ""

def extract_first(regex, html):
    if not html:
        return ""
    m = re.search(regex, html, flags=re.IGNORECASE | re.DOTALL)
    return m.group(1).strip() if m else ""

def parse_feed(xml_bytes, subreddit):
    out = []
    try:
        root = ET.fromstring(xml_bytes)
    except Exception:
        return out

    tag = root.tag.lower()

    # ---------------- RSS 2.0 ----------------
    if tag.endswith("rss"):
        channel = root.find("channel")
        if channel is None:
            return out

        for item in channel.findall("item"):
            title = text(item, "title") or "(untitled)"
            link = text(item, "link")
            comments = text(item, "comments") or link
            pub = text(item, "pubDate")

            date_ms = int(time.time() * 1000)
            try:
                dt = datetime.strptime(pub, "%a, %d %b %Y %H:%M:%S %Z")
                date_ms = int(dt.replace(tzinfo=timezone.utc).timestamp() * 1000)
            except Exception:
                pass

            desc = text(item, "description") or ""
            content_html = desc

            # Media extraction (best-effort):
            # 1) <media:content url="..."> or <media:thumbnail url="...">
            media_url = ""
            for ch in list(item):
                t = ch.tag.lower()
                if t.endswith("content") or t.endswith("thumbnail"):
                    u = ch.attrib.get("url", "").strip()
                    if u:
                        media_url = u
                        break

            # 2) <video src="..."> or <img src="..."> in HTML
            video_url = extract_first(r'<video[^>]+src="([^"]+)"', content_html)
            if video_url:
                media_url = media_url or ""
            img_url = extract_first(r'<img[^>]+src="([^"]+)"', content_html)

            nsfw = bool(re.search(r"\bnsfw\b", title, flags=re.IGNORECASE))

            out.append({
                "id": comments or link or f"{subreddit}:{title}:{date_ms}",
                "subreddit": subreddit,
                "title": title,
                "dateMs": date_ms,
                "permalink": comments or link,
                "outboundUrl": link or comments,
                "mediaUrl": img_url or media_url or None,
                "videoUrl": video_url or None,
                "contentHtml": content_html or "",
                "isNsfw": nsfw,
            })

        return out

    # ---------------- Atom ----------------
    if tag.endswith("feed"):
        ns = {"a": "http://www.w3.org/2005/Atom"}

        for entry in root.findall("a:entry", ns):
            title_el = entry.find("a:title", ns)
            title = title_el.text.strip() if title_el is not None and title_el.text else "(untitled)"

            link = ""
            for l in entry.findall("a:link", ns):
                if l.get("rel") == "alternate":
                    link = (l.get("href") or "").strip()
                    break
            if not link:
                l = entry.find("a:link", ns)
                if l is not None:
                    link = (l.get("href") or "").strip()

            updated_el = entry.find("a:updated", ns)
            date_ms = int(time.time() * 1000)
            if updated_el is not None and updated_el.text:
                try:
                    dt = datetime.fromisoformat(updated_el.text.replace("Z", "+00:00"))
                    date_ms = int(dt.timestamp() * 1000)
                except Exception:
                    pass

            summary_el = entry.find("a:summary", ns)
            content_html = summary_el.text if summary_el is not None and summary_el.text else ""

            # Atom summaries often include <img> tags for previews
            img_url = extract_first(r'<img[^>]+src="([^"]+)"', content_html)
            video_url = extract_first(r'<video[^>]+src="([^"]+)"', content_html)

            nsfw = bool(re.search(r"\bnsfw\b", title, flags=re.IGNORECASE))

            out.append({
                "id": link or f"{subreddit}:{title}:{date_ms}",
                "subreddit": subreddit,
                "title": title,
                "dateMs": date_ms,
                "permalink": link,
                "outboundUrl": link,
                "mediaUrl": img_url or None,
                "videoUrl": video_url or None,
                "contentHtml": content_html or "",
                "isNsfw": nsfw,
            })

        return out

    return out

def main():
    subs = env_list("CALMFEED_SUBS", DEFAULT_SUBS)
    sort = env_str("CALMFEED_SORT", DEFAULT_SORT, allowed={"hot","new","top"})
    top_t = env_str("CALMFEED_TOP_T", DEFAULT_TOP_T, allowed={"day","week","month","year","all"})
    limit = env_int("CALMFEED_LIMIT", DEFAULT_LIMIT, 5, 100)
    hide_nsfw = env_str("CALMFEED_HIDE_NSFW", "true", allowed={"true","false"}) == "true"

    all_posts = []
    errors = []

    for sub in subs:
        url = build_rss_url(sub, sort, top_t, limit)
        try:
            xml = fetch_url(url)
            posts = parse_feed(xml, sub)
            if hide_nsfw:
                posts = [p for p in posts if not p.get("isNsfw")]
            all_posts.extend(posts)
        except Exception:
            errors.append(sub)

    seen = set()
    deduped = []
    for p in all_posts:
        key = (p.get("permalink") or p.get("outboundUrl") or p.get("id") or "").strip()
        if not key or key in seen:
            continue
        seen.add(key)
        deduped.append(p)

    deduped.sort(key=lambda x: x.get("dateMs", 0), reverse=True)
    deduped = deduped[:MAX_ITEMS_TOTAL]

    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "settings": {"subs": subs, "sort": sort, "top_t": top_t, "limit": limit, "hide_nsfw": hide_nsfw},
        "errors": errors,
        "posts": deduped,
    }

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

if __name__ == "__main__":
    main()
