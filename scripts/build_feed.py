#!/usr/bin/env python3
"""
Fetch subreddit RSS (server-side) and build a static feed.json.

- Reads upstream subreddit list from subreddits_source.txt (repo root).
- Extracts title, sanitized text, one image (if any), one video (if any), comments URL, external URL.
- Strips common Reddit RSS noise (e.g., "submitted by /u/..." and [link] [comments]).
- Spaces requests out and retries 429/5xx responses (honouring Retry-After) to
  avoid Reddit's rate limiting.
- Merges with the previous feed.json so a subreddit that fails to fetch keeps its
  last good items instead of disappearing.
- Writes feed.json suitable for a static GitHub Pages site.
"""

from __future__ import annotations

import json
import os
import re
import sys
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

REQUEST_DELAY_SECONDS = 4        # pause between subreddit requests
MAX_ATTEMPTS = 4                 # per subreddit, including the first try
BACKOFF_BASE_SECONDS = 8         # 8s, 16s, 32s when no Retry-After is given
MAX_RETRY_AFTER_SECONDS = 120
RETRY_STATUSES = {429, 500, 502, 503, 504}

MAX_ITEM_AGE_DAYS = 7            # retained items older than this are dropped
MAX_ITEMS_PER_SUB = 50

REDDIT_DOMAINS = {"www.reddit.com", "reddit.com", "old.reddit.com", "np.reddit.com", "redd.it"}
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


def _host(url: str) -> str:
    try:
        return urlparse(url).netloc.lower()
    except Exception:
        return ""


def _is_reddit_url(url: str) -> bool:
    try:
        host = urlparse(url).netloc.lower()
    except Exception:
        return False
    return host in REDDIT_DOMAINS


def _looks_like_image(url: str) -> bool:
    if not url:
        return False
    if IMG_EXT_RE.search(url):
        return True
    h = _host(url)
    if h in IMAGE_HOST_HINTS:
        return True
    if "preview.redd.it" in h or "redditmedia.com" in h:
        return True
    return False



def _normalize_subreddit(s: str) -> str:
    s = s.strip()
    s = re.sub(r"^/r/", "", s, flags=re.IGNORECASE)
    s = re.sub(r"[^A-Za-z0-9_]+", "", s)
    return s


def _read_subreddits_source(path: str) -> List[str]:
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
    Returns (text, image_url, external_url)
    """
    soup = BeautifulSoup(html or "", "html.parser")
    for tag in soup(["script", "style"]):
        tag.decompose()

    # Remove introductory "submitted by..." paragraphs if present
    first_p = soup.find("p")
    if first_p and "submitted by" in first_p.get_text(" ", strip=True).lower():
        first_p.decompose()

    external_url = None
    image_url = None

    # First pass: images inside the content
    img = soup.find("img", src=True)
    if img:
        image_url = img["src"].strip()

    # Look for external links / image links
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if not href:
            continue
        if not _is_reddit_url(href) and not href.startswith("/r/") and not href.startswith("/u/"):
            if not external_url:
                external_url = href
        if not image_url and _looks_like_image(href):
            image_url = href

    # Clean visible text and strip common RSS noise tokens like [link] [comments]
    raw_text = soup.get_text(" ", strip=True) or ""
    raw_text = re.sub(r"submitted by\s+/u/\S+.*?(?=\s|$)", "", raw_text, flags=re.IGNORECASE)
    raw_text = re.sub(r"\[link\]|\[comments\]", "", raw_text, flags=re.IGNORECASE)
    text = _clean_text(raw_text)

    return text, image_url, external_url


def _to_epoch(entry: Any) -> int:
    for key in ("published_parsed", "updated_parsed"):
        t = getattr(entry, key, None)
        if t:
            return int(time.mktime(t))
    return int(time.time())


def _extract_image_from_entry_fields(entry: Any) -> Optional[str]:
    mc = getattr(entry, "media_content", None)
    if mc and isinstance(mc, list):
        for obj in mc:
            if isinstance(obj, dict):
                url = (obj.get("url") or "").strip()
                if _looks_like_image(url):
                    return url
    links = getattr(entry, "links", None)
    if links and isinstance(links, list):
        for l in links:
            if not isinstance(l, dict):
                continue
            href = (l.get("href") or "").strip()
            rel = (l.get("rel") or "").lower()
            type_ = (l.get("type") or "").lower()
            if rel == "enclosure" and (type_.startswith("image/") or _looks_like_image(href)):
                return href
            if _looks_like_image(href):
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


def _retry_delay(resp: Optional[requests.Response], attempt: int) -> float:
    if resp is not None:
        ra = (resp.headers.get("Retry-After") or "").strip()
        if ra.isdigit():
            return min(float(ra), MAX_RETRY_AFTER_SECONDS)
    return min(BACKOFF_BASE_SECONDS * (2 ** (attempt - 1)), MAX_RETRY_AFTER_SECONDS)


def fetch_rss(url: str) -> feedparser.FeedParserDict:
    headers = {"User-Agent": USER_AGENT, "Accept": "application/rss+xml, application/xml;q=0.9, */*;q=0.8"}
    for attempt in range(1, MAX_ATTEMPTS + 1):
        resp: Optional[requests.Response] = None
        try:
            resp = requests.get(url, headers=headers, timeout=TIMEOUT_SECONDS)
            if resp.status_code not in RETRY_STATUSES:
                resp.raise_for_status()
                return feedparser.parse(resp.content)
            if attempt == MAX_ATTEMPTS:
                resp.raise_for_status()
        except (requests.ConnectionError, requests.Timeout):
            if attempt == MAX_ATTEMPTS:
                raise
        delay = _retry_delay(resp, attempt)
        print(f"  retrying {url} in {delay:.0f}s (attempt {attempt}/{MAX_ATTEMPTS})")
        time.sleep(delay)
    raise RuntimeError("unreachable")


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

        # fallback to feed fields
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


def _load_previous(path: str) -> Dict[str, Any]:
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _previous_items_by_sub(prev: Dict[str, Any]) -> Dict[str, List[FeedItem]]:
    fields = set(FeedItem.__dataclass_fields__)
    out: Dict[str, List[FeedItem]] = {}
    for raw in prev.get("items") or []:
        if not isinstance(raw, dict) or not fields.issubset(raw):
            continue
        it = FeedItem(**{k: raw[k] for k in fields})
        out.setdefault(it.subreddit.lower(), []).append(it)
    return out


def _merge(fresh: List[FeedItem], old: List[FeedItem], min_created: int) -> List[FeedItem]:
    by_id: Dict[str, FeedItem] = {}
    for it in old:
        by_id[it.id] = it
    for it in fresh:  # fresh copies win
        by_id[it.id] = it
    kept = [it for it in by_id.values() if it.created_utc >= min_created]
    kept.sort(key=lambda x: x.created_utc, reverse=True)
    return kept[:MAX_ITEMS_PER_SUB]


def main() -> None:
    subs = _read_subreddits_source(SUBREDDITS_SOURCE_PATH)
    prev = _load_previous(OUTPUT_PATH)
    prev_items = _previous_items_by_sub(prev)
    prev_fetched = prev.get("last_fetched_utc") or {}

    now = datetime.now(timezone.utc)
    min_created = int(now.timestamp()) - MAX_ITEM_AGE_DAYS * 24 * 60 * 60

    all_items: List[FeedItem] = []
    errors: Dict[str, str] = {}
    last_fetched: Dict[str, str] = {}

    for i, sub in enumerate(subs):
        if i > 0:
            time.sleep(REQUEST_DELAY_SECONDS)
        old = prev_items.get(sub.lower(), [])
        try:
            fresh = build_items_for_subreddit(sub)
            last_fetched[sub] = now.isoformat()
        except Exception as e:
            errors[sub] = str(e)
            fresh = []
            if prev_fetched.get(sub):
                last_fetched[sub] = prev_fetched[sub]
        all_items.extend(_merge(fresh, old, min_created))

    if len(errors) == len(subs):
        # Keep the previous feed.json untouched rather than publishing an empty one.
        print("All subreddits failed; leaving existing feed.json unchanged.", file=sys.stderr)
        for k, v in errors.items():
            print(f"  - {k}: {v}", file=sys.stderr)
        raise SystemExit(1)

    # dedupe by comments_url (cross-posts can share a thread)
    dedup: Dict[str, FeedItem] = {}
    for it in all_items:
        if it.comments_url not in dedup or it.created_utc > dedup[it.comments_url].created_utc:
            dedup[it.comments_url] = it

    items_sorted = sorted(dedup.values(), key=lambda x: x.created_utc, reverse=True)

    out: Dict[str, Any] = {
        "generated_at_utc": now.isoformat(),
        "subreddits_source": subs,
        "errors": errors,
        "last_fetched_utc": last_fetched,
        "items": [asdict(x) for x in items_sorted],
    }

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    print(f"Wrote {OUTPUT_PATH} with {len(items_sorted)} items from {len(subs)} subreddits.")
    if errors:
        print("Errors (previous items kept):")
        for k, v in errors.items():
            print(f"  - {k}: {v}")


if __name__ == "__main__":
    main()
