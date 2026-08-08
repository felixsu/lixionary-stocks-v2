"""RSS news source.

Fetches the configured Indonesian feeds (Antara, CNBC Indonesia, Detik,
Kontan, Google News queries — all verified working) and normalizes entries.
Per-feed failures are logged and skipped; one broken feed must never stop the
cycle.
"""

from __future__ import annotations

import asyncio
import calendar
import html
import re
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlparse

import feedparser
import httpx

from app.core.config import settings
from app.core.logging import get_logger

log = get_logger(__name__)

_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

_TAG_RE = re.compile(r"<[^>]+>")


def _clean(text: str | None, limit: int = 500) -> str:
    """Strip tags/entities from RSS summaries; they routinely embed HTML."""
    if not text:
        return ""
    out = html.unescape(_TAG_RE.sub(" ", text))
    out = re.sub(r"\s+", " ", out).strip()
    return out[:limit]


def _source_of(entry: Any, feed_url: str) -> str:
    # Google News aggregates: the real publisher sits in entry.source.
    src = getattr(entry, "source", None)
    if src is not None and getattr(src, "title", None):
        return str(src.title)
    return urlparse(feed_url).netloc.removeprefix("www.")


def _published_at(entry: Any) -> datetime | None:
    for attr in ("published_parsed", "updated_parsed"):
        parsed = getattr(entry, attr, None)
        if parsed:
            return datetime.fromtimestamp(calendar.timegm(parsed), UTC)
    return None


def normalize_entries(
    raw: bytes | str, feed_url: str, category: str
) -> list[dict[str, Any]]:
    """Parse one feed document into normalized item dicts (pure, testable)."""
    parsed = feedparser.parse(raw)
    now = datetime.now(UTC)
    items: list[dict[str, Any]] = []
    for entry in parsed.entries:
        url = getattr(entry, "link", None)
        title = _clean(getattr(entry, "title", None), 300)
        if not url or not title:
            continue
        items.append(
            {
                "url": url,
                "guid": getattr(entry, "id", None) or url,
                "title": title,
                "source": _source_of(entry, feed_url),
                "feed_category": category,
                "summary": _clean(getattr(entry, "summary", None)),
                "published_at": _published_at(entry) or now,
                "lang": "id",
            }
        )
    return items


async def fetch_all_feeds() -> list[dict[str, Any]]:
    """Fetch every configured feed concurrently; failures skip that feed."""
    feeds = settings.news_feed_list

    async with httpx.AsyncClient(
        headers={"User-Agent": _UA}, timeout=15.0, follow_redirects=True
    ) as client:

        async def one(category: str, url: str) -> list[dict[str, Any]]:
            try:
                resp = await client.get(url)
                resp.raise_for_status()
                return normalize_entries(resp.content, url, category)
            except Exception as exc:  # noqa: BLE001 - one bad feed must not stop the cycle
                log.warning("rss.feed_failed", url=url, error=str(exc))
                return []

        results = await asyncio.gather(*(one(c, u) for c, u in feeds))

    # Dedupe within the batch (Google News queries overlap with direct feeds).
    seen: set[str] = set()
    items: list[dict[str, Any]] = []
    for item in (i for sub in results for i in sub):
        if item["url"] in seen:
            continue
        seen.add(item["url"])
        items.append(item)
    return items
