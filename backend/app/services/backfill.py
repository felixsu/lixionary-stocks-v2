"""Seed a symbol's history, taking the maximum window Yahoo allows per interval.

The 5m window is the perishable one. Yahoo serves at most ~60 days of it and
rejects anything longer with HTTP 422, so intraday history older than that is
unrecoverable once missed. Grabbing the full window on subscribe and then
persisting is the only way to accumulate real intraday depth over time.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from motor.motor_asyncio import AsyncIOMotorDatabase

from app.core.config import settings
from app.core.logging import get_logger
from app.domain.timeframes import BASE_TIMEFRAMES, Timeframe
from app.services.coverage import refresh_coverage
from app.services.ingest import IngestResult, ingest
from app.sources.yahoo import YahooSource

log = get_logger(__name__)


#: Yahoo enforces its lookback caps as "within the last N days", measured against
#: its own clock at request time. Asking for exactly N days is a race with that
#: boundary: it succeeds or returns "The requested range must be within the last
#: 730 days" depending on how the two clocks line up. Stay a day inside.
BOUNDARY_SAFETY_DAYS = 1


def backfill_window(timeframe: Timeframe) -> dict[str, object]:
    """Fetch arguments giving the deepest history Yahoo will reliably serve."""
    now = datetime.now(UTC)
    max_days = {
        Timeframe.M5: settings.backfill_5m_days,
        Timeframe.H1: settings.backfill_1h_days,
    }.get(timeframe)

    if max_days is not None:
        return {"start": now - timedelta(days=max_days - BOUNDARY_SAFETY_DAYS), "end": now}
    return {"period": settings.backfill_1d_period}


async def backfill_symbol(
    db: AsyncIOMotorDatabase,
    symbol: str,
    *,
    run_id: str | None = None,
    source: YahooSource | None = None,
    timeframes: tuple[Timeframe, ...] = BASE_TIMEFRAMES,
) -> list[IngestResult]:
    rid = run_id or uuid.uuid4().hex
    results: list[IngestResult] = []

    for tf in timeframes:
        result = await ingest(
            db,
            symbol,
            tf,
            **backfill_window(tf),  # type: ignore[arg-type]
            kind="backfill",
            run_id=rid,
            source=source,
        )
        results.append(result)
        log.info(
            "backfill.timeframe_done",
            symbol=symbol,
            timeframe=tf.value,
            status=result.status,
            fetched=result.bars_fetched,
            upserted=result.bars_upserted,
        )

    await refresh_coverage(db, symbol)
    return results
