"""Scheduled ingestion jobs.

Every job is safe to run at any time: ingestion is an idempotent upsert, so a
duplicate or mistimed run costs a request, never data integrity.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime
from typing import Any

from motor.motor_asyncio import AsyncIOMotorDatabase

from app.core.logging import get_logger
from app.db.mongo import get_db
from app.domain.calendar import is_poll_window_open
from app.domain.timeframes import Timeframe
from app.services.candles import clear_cache
from app.services.coverage import refresh_all_coverage
from app.services.ingest import ingest, mark_symbol_polled
from app.services.symbols import enabled_symbols
from app.sources.yahoo import yahoo

log = get_logger(__name__)


async def _ingest_many(
    db: AsyncIOMotorDatabase,
    symbols: list[str],
    timeframe: Timeframe,
    *,
    period: str,
    kind: str,
    run_id: str,
) -> dict[str, Any]:
    """Fetch one timeframe for many symbols.

    Concurrency is bounded inside YahooSource, so gathering everything here is
    safe: at most ``fetch_concurrency`` requests are ever in flight.
    """

    async def one(symbol: str):
        result = await ingest(
            db, symbol, timeframe, period=period, kind=kind, run_id=run_id, source=yahoo
        )
        await mark_symbol_polled(db, symbol, error=result.error)
        return result

    results = await asyncio.gather(*(one(s) for s in symbols), return_exceptions=True)

    ok = failed = empty = 0
    upserted = 0
    for r in results:
        if isinstance(r, BaseException):
            failed += 1
            continue
        upserted += r.bars_upserted
        if r.status == "ok":
            ok += 1
        elif r.status == "empty":
            empty += 1
        else:
            failed += 1

    return {
        "run_id": run_id,
        "timeframe": timeframe.value,
        "symbols": len(symbols),
        "ok": ok,
        "empty": empty,
        "failed": failed,
        "bars_upserted": upserted,
    }


async def poll_all(
    db: AsyncIOMotorDatabase | None = None,
    *,
    run_id: str | None = None,
    force: bool = False,
    now: datetime | None = None,
) -> dict[str, Any]:
    """The 5m poll. No-ops outside the trading window unless forced."""
    db = db if db is not None else get_db()
    now = now or datetime.now(UTC)
    rid = run_id or uuid.uuid4().hex

    if not force and not is_poll_window_open(now):
        return {"run_id": rid, "skipped": "outside poll window"}

    if yahoo.breaker.is_open:
        log.warning("poll.skipped_breaker_open", **yahoo.breaker.state)
        return {"run_id": rid, "skipped": "circuit breaker open", **yahoo.breaker.state}

    symbols = await enabled_symbols(db)
    if not symbols:
        return {"run_id": rid, "skipped": "no enabled symbols"}

    # period=2d rather than 1d so a poll just after the open still spans the
    # previous session and cannot fall into a gap at the day boundary.
    summary = await _ingest_many(
        db, symbols, Timeframe.M5, period="2d", kind="poll", run_id=rid
    )
    clear_cache()
    log.info("poll.done", **summary)
    return summary


async def refresh_hourly(db: AsyncIOMotorDatabase | None = None, *, force: bool = False):
    db = db if db is not None else get_db()
    now = datetime.now(UTC)
    if not force and not is_poll_window_open(now):
        return {"skipped": "outside poll window"}
    symbols = await enabled_symbols(db)
    if not symbols:
        return {"skipped": "no enabled symbols"}
    summary = await _ingest_many(
        db, symbols, Timeframe.H1, period="5d", kind="refresh_1h", run_id=uuid.uuid4().hex
    )
    clear_cache()
    log.info("refresh_1h.done", **summary)
    return summary


async def close_of_day(db: AsyncIOMotorDatabase | None = None) -> dict[str, Any]:
    """Settle the day: pull the finished daily bar and top up hourly history."""
    db = db if db is not None else get_db()
    symbols = await enabled_symbols(db)
    if not symbols:
        return {"skipped": "no enabled symbols"}

    rid = uuid.uuid4().hex
    daily = await _ingest_many(
        db, symbols, Timeframe.D1, period="1mo", kind="close_of_day", run_id=rid
    )
    hourly = await _ingest_many(
        db, symbols, Timeframe.H1, period="1mo", kind="close_of_day", run_id=rid
    )
    await refresh_all_coverage(db)
    clear_cache()
    log.info("close_of_day.done", daily=daily, hourly=hourly)
    return {"daily": daily, "hourly": hourly}


async def nightly_daily(db: AsyncIOMotorDatabase | None = None) -> dict[str, Any]:
    """Re-pull a wider daily window to pick up upstream restatements."""
    db = db if db is not None else get_db()
    symbols = await enabled_symbols(db)
    if not symbols:
        return {"skipped": "no enabled symbols"}
    summary = await _ingest_many(
        db, symbols, Timeframe.D1, period="6mo", kind="nightly", run_id=uuid.uuid4().hex
    )
    clear_cache()
    log.info("nightly_daily.done", **summary)
    return summary


async def recalc_coverage(db: AsyncIOMotorDatabase | None = None) -> dict[str, Any]:
    db = db if db is not None else get_db()
    count = await refresh_all_coverage(db)
    log.info("coverage.refreshed", symbols=count)
    return {"symbols_refreshed": count}
