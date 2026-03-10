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

def extract_first(regex, html):
    if not html:
        return ""
    m = re.search(regex, html, flags=re.IGNORECASE | re.DOTALL)
    return m.group(1).strip() if m else ""

def looks_like_image(url: str) -> bool:
    u = (url or "").lower()
    return (
        u.endswith(".png") or u.endswith(".jpg") or u.endswith(".jpeg") or u.endswith(".gif") or u.endswith(".webp")
        or "i.redd.it/" in u or "preview.redd.it/" in u or "i.imgur.com/" in u
    )

def looks_like_mp4(url: str) -> bool:
    return (url or "").lower().endswith(".mp4")

def parse_rfc822_ms(pub: str) -> int:
    if not pub:
        return int(time.time() * 1000)
    for fmt in ("%a, %d %b %Y %H:%M:%S %Z", "%a, %d %b %Y %H:%M:%S %z"):
        try:
            dt = datetime.strptime(pub, fmt)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return int(dt.timestamp() * 1000)
        except Exception:
            pass
    return int(time.time() * 1000)

def parse_iso_ms(s: str) -> int:
    if not s:
        return int(time.time() * 1000)
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return int(dt.timestamp() * 1000)
    except Exception:
        return int(time.time() * 1000)

def get_child_text_by_suffix(parent, suffix: str) -> str:
    """Return text of the first child whose tag endswith(suffix), namespace-agnostic."""
    if parent is None:
        return ""
    for ch in list(parent):
        if ch.tag.lower().endswith(suffix.lower()) and (ch.text or "").strip():
            return (ch.text or "").strip()
    return ""

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
            title = (item.findtext("title") or "").strip() or "(untitled)"
            link = (item.findtext("link") or "").strip()
            comments = (item.findtext("comments") or "").strip() or link

            pub = (item.findtext("pubDate") or "").strip()
            date_ms = parse_rfc822_ms(pub)

            # Prefer <content:encoded> (namespace) then <description>
            content_html = get_child_text_by_suffix(item, "encoded")
            if not content_html:
                content_html = (item.findtext("description") or "").strip()

            # Media candidates
            media_url = ""
            video_url = ""

            # 1) <enclosure url="...">
            enc = item.find("enclosure")
            if enc is not None:
                u = (enc.attrib.get("url") or "").strip()
                t = (enc.attrib.get("type") or "").strip().lower()
                if u:
                    if looks_like_mp4(u) or t.startswith("video/"):
                        video_url = u
                    elif looks_like_image(u) or t.startswith("image/"):
                        media_url = u

            # 2) <media:content url="..."> / <media:thumbnail url="..."> (namespace-agnostic)
            if not media_url:
                for ch in list(item):
                    t = ch.tag.lower()
                    if t.endswith("content") or t.endswith("thumbnail"):
                        u = (ch.attrib.get("url") or "").strip()
                        if u and looks_like_image(u):
                            media_url = u
                            break

            # 3) HTML scan (video first, then img)
            if not video_url:
                v = extract_first(r'<video[^>]+src="([^"]+)"', content_html)
                if v and looks_like_mp4(v):
                    video_url = v
            if not media_url:
                img = extract_first(r'<img[^>]+src="([^"]+)"', content_html)
                if img:
                    media_url = img

            nsfw = bool(re.search(r"\bnsfw\b", title, flags=re.IGNORECASE))

            out.append({
                "id": comments or link or f"{subreddit}:{title}:{date_ms}",
                "subreddit": subreddit,
                "title": title,
                "dateMs": date_ms,
                "permalink": comments or link,
                "outboundUrl": link or comments,
                "mediaUrl": media_url or None,
                "videoUrl": video_url or None,
                "contentHtml": content_html or "",
                "isNsfw": nsfw,
            })

        return out

    # ---------------- Atom ----------------
    if tag.endswith("feed"):
        ns = {"a": "http://www.w3.org/2005/Atom"}

        for entry in root.findall("a:entry", ns):
            title = (entry.findtext("a:title", default="", namespaces=ns) or "").strip() or "(untitled)"

            # Prefer rel="alternate" for permalink
            link = ""
            for l in entry.findall("a:link", ns):
                if (l.get("rel") or "").strip() == "alternate":
                    link = (l.get("href") or "").strip()
                    break
            if not link:
                l = entry.find("a:link", ns)
                if l is not None:
                    link = (l.get("href") or "").strip()

            updated = (entry.findtext("a:updated", default="", namespaces=ns) or "").strip()
            published = (entry.findtext("a:published", default="", namespaces=ns) or "").strip()
            date_ms = parse_iso_ms(updated or published)

            # Prefer <content> over <summary> (Reddit commonly uses content for the HTML)
            content_el = entry.find("a:content", ns)
            content_html = ""
            if content_el is not None and (content_el.text or "").strip():
                content_html = (content_el.text or "").strip()
            if not content_html:
                summary = (entry.findtext("a:summary", default="", namespaces=ns) or "").strip()
                content_html = summary

            media_url = ""
            video_url = ""

            # Atom can carry media via link rel="enclosure"
            for l in entry.findall("a:link", ns):
                if (l.get("rel") or "").strip() == "enclosure":
                    href = (l.get("href") or "").strip()
                    typ = (l.get("type") or "").strip().lower()
                    if href:
                        if looks_like_mp4(href) or typ.startswith("video/"):
                            video_url = href
                        elif looks_like_image(href) or typ.startswith("image/"):
                            media_url = href

            # HTML scan (video first, then img)
            if not video_url:
                v = extract_first(r'<video[^>]+src="([^"]+)"', content_html)
                if v and looks_like_mp4(v):
                    video_url = v
            if not media_url:
                img = extract_first(r'<img[^>]+src="([^"]+)"', content_html)
                if img:
                    media_url = img

            nsfw = bool(re.search(r"\bnsfw\b", title, flags=re.IGNORECASE))

            out.append({
                "id": link or f"{subreddit}:{title}:{date_ms}",
                "subreddit": subreddit,
                "title": title,
                "dateMs": date_ms,
                "permalink": link,
                "outboundUrl": link,
                "mediaUrl": media_url or None,
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
