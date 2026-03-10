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
DEFAULT_LIMIT = 25       # per subreddit, RSS may not always honor exactly
MAX_ITEMS_TOTAL = 200    # safety cap

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

def parse_rss(xml_bytes, subreddit):
    out = []
    try:
        root = ET.fromstring(xml_bytes)
    except Exception:
        return out

    tag = root.tag.lower()

    # -------- RSS 2.0 --------
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
            html = desc

            media_url = ""
            m = re.search(r'<img[^>]+src="([^"]+)"', html, flags=re.IGNORECASE)
            if m:
                media_url = m.group(1)

            nsfw = bool(re.search(r"\bnsfw\b", title, flags=re.IGNORECASE))


            out.append({
                "id": comments or link or f"{subreddit}:{title}:{date_ms}",
                "subreddit": subreddit,
                "title": title,
                "dateMs": date_ms,
                "permalink": comments or link,
                "outboundUrl": link or comments,
                "mediaUrl": media_url or None,
                "contentHtml": html or "",
                "isNsfw": nsfw,
            })

        return out

    # -------- Atom --------
    if tag.endswith("feed"):
        ns = {"a": "http://www.w3.org/2005/Atom"}

        for entry in root.findall("a:entry", ns):
            title_el = entry.find("a:title", ns)
            title = title_el.text.strip() if title_el is not None and title_el.text else "(untitled)"

            link = ""
            for l in entry.findall("a:link", ns):
                if l.get("rel") == "alternate":
                    link = l.get("href")
                    break
            if not link:
                l = entry.find("a:link", ns)
                if l is not None:
                    link = l.get("href")

            updated_el = entry.find("a:updated", ns)
            date_ms = int(time.time() * 1000)
            if updated_el is not None and updated_el.text:
                try:
                    dt = datetime.fromisoformat(updated_el.text.replace("Z", "+00:00"))
                    date_ms = int(dt.timestamp() * 1000)
                except Exception:
                    pass

            summary_el = entry.find("a:summary", ns)
            html = summary_el.text if summary_el is not None and summary_el.text else ""

            # Extract image
            media_url = ""
            img_match = re.search(r'<img[^>]+src="([^"]+)"', html, flags=re.IGNORECASE)
            if img_match:
                media_url = img_match.group(1)
            
            # Extract video
            video_match = re.search(r'<video[^>]+src="([^"]+)"', html, flags=re.IGNORECASE)
            if video_match:
                media_url = video_match.group(1)

            nsfw = bool(re.search(r"\bnsfw\b", title, flags=re.IGNORECASE))

            out.append({
                "id": comments or link or f"{subreddit}:{title}:{date_ms}",
                "subreddit": subreddit,
                "title": title,
                "dateMs": date_ms,
                "permalink": comments or link,
                "outboundUrl": link or comments,
                "mediaUrl": media_url or None,
                "contentHtml": html or "",
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
            posts = parse_rss(xml, sub)
            if hide_nsfw:
                posts = [p for p in posts if not p.get("isNsfw")]
            all_posts.extend(posts)
        except Exception:
            errors.append(sub)

    # Deduplicate by permalink/outbound
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
