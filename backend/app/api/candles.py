from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, HTTPException, Query, status

from app.db.mongo import get_db
from app.domain.timeframes import Timeframe
from app.models.schemas import CandlesOut
from app.services.candles import DEFAULT_LIMIT, MAX_LIMIT, get_candles

router = APIRouter(prefix="/api/candles", tags=["candles"])


@router.get("/{symbol}", response_model=CandlesOut)
async def read_candles(
    symbol: str,
    timeframe: Timeframe = Query(default=Timeframe.D1),
    start: datetime | None = Query(default=None, alias="from"),
    end: datetime | None = Query(default=None, alias="to"),
    limit: int = Query(default=DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
):
    """OHLCV bars.

    Only 5m/1h/1d are stored; the rest are resampled on read from the finest
    stored series that reaches far enough back. ``source_timeframe`` reports
    which one was actually used.
    """
    if (start and start.tzinfo is None) or (end and end.tzinfo is None):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "from/to must include a timezone offset, e.g. 2026-08-01T00:00:00Z",
        )
    if start and end and start > end:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "from must be before to")

    return await get_candles(
        get_db(), symbol.strip().upper(), timeframe, start=start, end=end, limit=limit
    )
