"""Read path: pick a base series, load it, resample, cache.

Only 5m/1h/1d are stored. Everything else is derived per request, so a derived
series can never drift from its source and changing the bucketing rules needs no
backfill.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from cachetools import TTLCache
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.core.logging import get_logger
from app.domain.timeframes import DURATIONS, Timeframe, allowed_sources
from app.services.resample import resample

log = get_logger(__name__)

DEFAULT_LIMIT = 500
MAX_LIMIT = 5000

# One short TTL rather than a long one for out-of-hours: an entry cached while
# the market was shut would otherwise survive well into the next session.
# Resampling a few thousand bars costs milliseconds, so there is little to win.
_cache: TTLCache = TTLCache(maxsize=512, ttl=60)


class CandleResult(dict):
    pass


def _cache_key(symbol, target, start, end, limit) -> tuple:
    return (symbol, target.value, start, end, limit)


async def _load_base(
    db: AsyncIOMotorDatabase,
    symbol: str,
    source: Timeframe,
    start: datetime | None,
    end: datetime | None,
    fetch_limit: int | None,
) -> list[dict[str, Any]]:
    query: dict[str, Any] = {"symbol": symbol, "timeframe": source.value}
    ts_filter: dict[str, Any] = {}
    if start is not None:
        ts_filter["$gte"] = start
    if end is not None:
        ts_filter["$lte"] = end
    if ts_filter:
        query["ts"] = ts_filter

    projection = {"_id": 0, "ts": 1, "o": 1, "h": 1, "l": 1, "c": 1, "v": 1, "final": 1}

    if fetch_limit is None:
        cursor = db.candles.find(query, projection).sort("ts", 1)
        return [doc async for doc in cursor]

    # Take the newest slice, then flip back to ascending.
    cursor = db.candles.find(query, projection).sort("ts", -1).limit(fetch_limit)
    rows = [doc async for doc in cursor]
    rows.reverse()
    return rows


def _source_fetch_limit(source: Timeframe, target: Timeframe, limit: int) -> int:
    """How many base bars are needed to build ``limit`` target bars.

    One extra bucket of padding, because slicing the base series can clip the
    oldest bucket in half; that partial bucket is trimmed off after resampling.
    """
    if source is target:
        return limit
    ratio = max(1, int(DURATIONS[target] / DURATIONS[source]))
    return limit * ratio + ratio


async def get_candles(
    db: AsyncIOMotorDatabase,
    symbol: str,
    target: Timeframe,
    *,
    start: datetime | None = None,
    end: datetime | None = None,
    limit: int = DEFAULT_LIMIT,
    now: datetime | None = None,
    use_cache: bool = True,
) -> dict[str, Any]:
    limit = max(1, min(limit, MAX_LIMIT))
    key = _cache_key(symbol, target, start, end, limit)
    if use_cache and key in _cache:
        return _cache[key]

    now = now or datetime.now(UTC)
    best: tuple[Timeframe, list[dict]] | None = None

    # Finest source first. Stop as soon as one has the requested depth; a coarser
    # base only wins when the finer one cannot reach far enough back.
    for source in allowed_sources(target):
        fetch_limit = None if start is not None else _source_fetch_limit(source, target, limit)
        rows = await _load_base(db, symbol, source, start, end, fetch_limit)
        if not rows:
            continue

        bars = resample(rows, source, target, now=now)
        if start is None and len(bars) > limit:
            bars = bars[-limit:]

        if best is None or len(bars) > len(best[1]):
            best = (source, bars)
        if len(bars) >= limit:
            break

    if best is None:
        result = {
            "symbol": symbol,
            "timeframe": target.value,
            "source_timeframe": None,
            "derived": False,
            "has_volume": False,
            "count": 0,
            "bars": [],
        }
    else:
        source, bars = best
        result = {
            "symbol": symbol,
            "timeframe": target.value,
            "source_timeframe": source.value,
            "derived": source is not target,
            "has_volume": any(b["v"] is not None for b in bars),
            "count": len(bars),
            "bars": bars,
        }

    if use_cache:
        _cache[key] = result
    return result


def clear_cache() -> None:
    _cache.clear()
