"""Fetch bars from the source and write them into ``candles``.

The write is an idempotent upsert keyed on ``(symbol, timeframe, ts)``. That key
is load-bearing rather than defensive: the most recent bar is still forming while
the 10-minute-delayed feed catches up, so every poll legitimately rewrites the
last few bars.
"""

from __future__ import annotations

import uuid
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime

from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo import UpdateOne

from app.core.logging import get_logger
from app.domain.timeframes import Timeframe
from app.sources.yahoo import Bar, RateLimited, SymbolNotFound, YahooSource, yahoo

log = get_logger(__name__)


@dataclass
class IngestResult:
    run_id: str
    symbol: str
    timeframe: str
    status: str  # ok | empty | failed
    bars_fetched: int = 0
    bars_upserted: int = 0
    bars_modified: int = 0
    first_ts: datetime | None = None
    last_ts: datetime | None = None
    error: str | None = None
    duration_ms: int = 0
    started_at: datetime = field(default_factory=lambda: datetime.now(UTC))


async def upsert_bars(
    db: AsyncIOMotorDatabase,
    symbol: str,
    timeframe: Timeframe,
    bars: list[Bar],
) -> tuple[int, int]:
    """Write bars, returning ``(upserted, modified)``."""
    if not bars:
        return (0, 0)

    now = datetime.now(UTC)
    ops = [
        UpdateOne(
            {"symbol": symbol, "timeframe": timeframe.value, "ts": bar.ts},
            {
                "$set": {
                    "o": bar.o,
                    "h": bar.h,
                    "l": bar.l,
                    "c": bar.c,
                    "v": bar.v,
                    "final": bar.final,
                    "ingested_at": now,
                },
                "$setOnInsert": {
                    "symbol": symbol,
                    "timeframe": timeframe.value,
                    "ts": bar.ts,
                    "src": "yahoo",
                },
            },
            upsert=True,
        )
        for bar in bars
    ]
    result = await db.candles.bulk_write(ops, ordered=False)
    return (result.upserted_count, result.modified_count)


async def ingest(
    db: AsyncIOMotorDatabase,
    symbol: str,
    timeframe: Timeframe,
    *,
    period: str | None = None,
    start: datetime | None = None,
    end: datetime | None = None,
    kind: str = "poll",
    run_id: str | None = None,
    source: YahooSource | None = None,
) -> IngestResult:
    """Fetch one symbol/timeframe and persist it, recording the attempt."""
    src = source or yahoo
    started = datetime.now(UTC)
    result = IngestResult(
        run_id=run_id or uuid.uuid4().hex,
        symbol=symbol,
        timeframe=timeframe.value,
        status="ok",
        started_at=started,
    )

    try:
        bars = await src.fetch(symbol, timeframe, period=period, start=start, end=end)
        result.bars_fetched = len(bars)
        if not bars:
            result.status = "empty"
        else:
            upserted, modified = await upsert_bars(db, symbol, timeframe, bars)
            result.bars_upserted = upserted
            result.bars_modified = modified
            result.first_ts = bars[0].ts
            result.last_ts = bars[-1].ts
    except SymbolNotFound as exc:
        result.status = "failed"
        result.error = f"symbol not found: {exc}"
    except RateLimited as exc:
        result.status = "failed"
        result.error = f"rate limited: {exc}"
    except Exception as exc:  # noqa: BLE001 - one bad symbol must not stop the batch
        result.status = "failed"
        result.error = f"{type(exc).__name__}: {exc}"

    result.duration_ms = int((datetime.now(UTC) - started).total_seconds() * 1000)
    await _record_run(db, result, kind)

    if result.status == "failed":
        log.warning(
            "ingest.failed", symbol=symbol, timeframe=timeframe.value, error=result.error
        )
    return result


async def _record_run(db: AsyncIOMotorDatabase, result: IngestResult, kind: str) -> None:
    doc = asdict(result)
    doc["kind"] = kind
    doc["finished_at"] = datetime.now(UTC)
    try:
        await db.ingest_runs.insert_one(doc)
    except Exception as exc:  # noqa: BLE001 - audit logging must never break ingestion
        log.warning("ingest.audit_write_failed", error=str(exc))


async def mark_symbol_polled(
    db: AsyncIOMotorDatabase, symbol: str, error: str | None = None
) -> None:
    await db.symbols.update_one(
        {"symbol": symbol},
        {"$set": {"last_poll_at": datetime.now(UTC), "last_error": error}},
    )
