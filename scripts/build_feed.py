#!/usr/bin/env python3
"""
Fetch subreddit RSS (server-side) and build a static feed.json.

Upstream fetch list is read from subreddits_source.txt (repo root by default).
The browser then applies the *local* allowlist (localStorage) on top.

Design goals:
- Avoid Reddit API / keys; use public RSS endpoints.
- Store only what the client needs: title, text, one image, comments URL, external URL.
- Do not include author/submitter info.
- Output is deterministic and stable.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

import requests
import feedparser
from bs4 import BeautifulSoup


SUBREDDITS_SOURCE_PATH = "subreddits_source.txt"
RSS_TEMPLATE = "https://www.reddit.com/r/{sub}/new/.rss"
USER_AGENT = "quiet-feed/1.2 (GitHub Actions; +https://pages.github.com/)"
TIMEOUT_SECONDS = 20
MAX_ENTRIES_PER_SUB = 25
OUTPUT_PATH = "feed.json"


REDDIT_DOMAINS = {"www.reddit.com", "reddit.com", "old.reddit.com", "np.reddit.com", "redd.it"}
# Media hosts that frequently serve images without a file extension
IMAGE_HOST_HINTS = {
    "i.redd.it",
    "preview.redd.it",
    "external-preview.redd.it",
    "i.imgur.com",
    "imgur.com",
    "redditmedia.com",
    "i.redditmedia.com",
}
IMG_EXT_RE = re.compile(r"\.(png|jpe?g|gif|webp)(\?.*)?$", re.IGNORECASE)


def _is_reddit_url(url: str) -> bool:
    try:
        host = urlparse(url).netloc.lower()
    except Exception:
        return False
    return host in REDDIT_DOMAINS


def _host(url: str) -> str:
    try:
        return urlparse(url).netloc.lower()
    except Exception:
        return ""


def _looks_like_image(url: str) -> bool:
    if not url:
        return False
    if IMG_EXT_RE.search(url):
        return True
    h = _host(url)
    if h in IMAGE_HOST_HINTS:
        return True
    # Some Reddit preview URLs include "format=" or "width=" but no extension
    if "preview.redd.it" in h or "redditmedia.com" in h:
        return True
    return False


def _normalize_subreddit(s: str) -> str:
    s = s.strip()
    s = re.sub(r"^/r/", "", s, flags=re.IGNORECASE)
    s = re.sub(r"[^A-Za-z0-9_]+", "", s)
    return s


def _read_subreddits_source(path: str) -> List[str]:
    """
    Reads one subreddit per line; supports:
      - blank lines
      - comments starting with '#'
      - entries like '/r/foo'
    """
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw_lines = f.read().splitlines()
    except FileNotFoundError:
        raise SystemExit(f"Missing {path}. Create it at repo root with one subreddit per line.")

    subs: List[str] = []
    for line in raw_lines:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        subs.append(_normalize_subreddit(line))

    subs = [s for s in subs if s]
    subs = sorted(set(subs), key=str.lower)
    if not subs:
        raise SystemExit(f"{path} contains no valid subreddit names.")
    return subs


def _clean_text(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _extract_from_content_html(html: str) -> Tuple[str, Optional[str], Optional[str]]:
    """
    Returns: (text, image_url, external_url)
    external_url is the first non-Reddit hyperlink (if any).
    image_url is first <img src> or first image-like hyperlink.
    """
    soup = BeautifulSoup(html or "", "html.parser")
    for tag in soup(["script", "style"]):
        tag.decompose()

    first_p = soup.find("p")
    if first_p and "submitted by" in first_p.get_text(" ", strip=True).lower():
        first_p.decompose()

    external_url = None
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if not href:
            continue
        if _is_reddit_url(href) or href.startswith("/r/") or href.startswith("/u/"):
            continue
        external_url = href
        break

    image_url = None
    img = soup.find("img", src=True)
    if img:
        image_url = img["src"].strip()

    if not image_url:
        for a in soup.find_all("a", href=True):
            href = a["href"].strip()
            if _looks_like_image(href):
                image_url = href
                break

    text = _clean_text(soup.get_text(" ", strip=True))
    return text, image_url, external_url


def _to_epoch(entry: Any) -> int:
    for key in ("published_parsed", "updated_parsed"):
        t = getattr(entry, key, None)
        if t:
            return int(time.mktime(t))
    return int(time.time())


def _extract_image_from_entry_fields(entry: Any) -> Optional[str]:
    """
    Practical improvement (2.5): use feedparser media/enclosure fields when present.
    """
    # media_content is common in some feeds
    mc = getattr(entry, "media_content", None)
    if mc and isinstance(mc, list):
        for obj in mc:
            url = (obj.get("url") or "").strip() if isinstance(obj, dict) else ""
            if _looks_like_image(url):
                return url

    # links rel=enclosure sometimes contains image previews
    links = getattr(entry, "links", None)
    if links and isinstance(links, list):
        for l in links:
            if not isinstance(l, dict):
                continue
            rel = (l.get("rel") or "").lower()
            href = (l.get("href") or "").strip()
            type_ = (l.get("type") or "").lower()
            if rel == "enclosure" and (type_.startswith("image/") or _looks_like_image(href)):
                return href
            if _looks_like_image(href):
                # fall back to any image-like link if nothing else found
                return href

    return None


@dataclass(frozen=True)
class FeedItem:
    id: str
    subreddit: str
    title: str
    text: str
    image: Optional[str]
    comments_url: str
    external_url: Optional[str]
    created_utc: int
    is_text_only: bool


def fetch_rss(url: str) -> feedparser.FeedParserDict:
    headers = {"User-Agent": USER_AGENT, "Accept": "application/rss+xml, application/xml;q=0.9, */*;q=0.8"}
    resp = requests.get(url, headers=headers, timeout=TIMEOUT_SECONDS)
    resp.raise_for_status()
    return feedparser.parse(resp.content)


def build_items_for_subreddit(sub: str) -> List[FeedItem]:
    parsed = fetch_rss(RSS_TEMPLATE.format(sub=sub))

    items: List[FeedItem] = []
    for entry in (parsed.entries or [])[:MAX_ENTRIES_PER_SUB]:
        title = _clean_text(getattr(entry, "title", "") or "")
        comments_url = getattr(entry, "link", "") or ""
        if not comments_url:
            continue

        content_html = ""
        if getattr(entry, "content", None):
            try:
                content_html = entry.content[0].value or ""
            except Exception:
                content_html = ""
        if not content_html:
            content_html = getattr(entry, "summary", "") or ""

        text, image_url, external_url = _extract_from_content_html(content_html)

        # Robustness: if no image found in HTML, try feedparser media/enclosure fields
        if not image_url:
            image_url = _extract_image_from_entry_fields(entry)

        created = _to_epoch(entry)

        is_text_only = bool(text) and not image_url and not external_url

        raw_id = getattr(entry, "id", "") or comments_url
        stable_id = re.sub(r"[^A-Za-z0-9:_-]+", "", raw_id)

        items.append(
            FeedItem(
                id=stable_id,
                subreddit=sub,
                title=title,
                text=text,
                image=image_url,
                comments_url=comments_url,
                external_url=external_url,
                created_utc=created,
                is_text_only=is_text_only,
            )
        )

    return items


def main() -> None:
    subs = _read_subreddits_source(SUBREDDITS_SOURCE_PATH)

    all_items: List[FeedItem] = []
    errors: Dict[str, str] = {}

    for sub in subs:
        try:
            all_items.extend(build_items_for_subreddit(sub))
        except Exception as e:
            errors[sub] = str(e)

    dedup: Dict[str, FeedItem] = {}
    for it in all_items:
        if it.comments_url not in dedup or it.created_utc > dedup[it.comments_url].created_utc:
            dedup[it.comments_url] = it

    items_sorted = sorted(dedup.values(), key=lambda x: x.created_utc, reverse=True)

    out: Dict[str, Any] = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "subreddits_source": subs,
        "errors": errors,
        "items": [asdict(x) for x in items_sorted],
    }

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    print(f"Wrote {OUTPUT_PATH} with {len(items_sorted)} items from {len(subs)} subreddits.")
    if errors:
        print("Errors:")
        for k, v in errors.items():
            print(f"  - {k}: {v}")


if __name__ == "__main__":
    main()