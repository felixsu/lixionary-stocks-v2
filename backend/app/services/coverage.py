"""Per-symbol, per-timeframe extent of what we actually hold.

The read path uses this to pick which base series can serve a request, so it has
to reflect the store rather than what Yahoo theoretically offers.
"""

from __future__ import annotations

from datetime import datetime

from motor.motor_asyncio import AsyncIOMotorDatabase

from app.domain.timeframes import BASE_TIMEFRAMES, Timeframe


async def compute_coverage(
    db: AsyncIOMotorDatabase, symbol: str
) -> dict[str, dict[str, datetime | int]]:
    pipeline = [
        {"$match": {"symbol": symbol}},
        {
            "$group": {
                "_id": "$timeframe",
                "first": {"$min": "$ts"},
                "last": {"$max": "$ts"},
                "count": {"$sum": 1},
            }
        },
    ]
    out: dict[str, dict[str, datetime | int]] = {}
    async for row in db.candles.aggregate(pipeline):
        out[row["_id"]] = {
            "first": row["first"],
            "last": row["last"],
            "count": row["count"],
        }
    return out


async def refresh_coverage(db: AsyncIOMotorDatabase, symbol: str) -> dict:
    coverage = await compute_coverage(db, symbol)
    await db.symbols.update_one({"symbol": symbol}, {"$set": {"coverage": coverage}})
    return coverage


async def refresh_all_coverage(db: AsyncIOMotorDatabase) -> int:
    count = 0
    async for doc in db.symbols.find({}, {"symbol": 1}):
        await refresh_coverage(db, doc["symbol"])
        count += 1
    return count


def covers(
    coverage: dict, timeframe: Timeframe, start: datetime | None, end: datetime | None
) -> bool:
    """Whether the stored ``timeframe`` series spans the requested window."""
    entry = coverage.get(timeframe.value) if coverage else None
    if not entry or not entry.get("count"):
        return False
    if start is not None:
        first = entry.get("first")
        if first is None or first > start:
            return False
    if end is not None:
        last = entry.get("last")
        if last is None or last < end:
            return False
    return True


def available_base_timeframes(coverage: dict) -> list[Timeframe]:
    return [tf for tf in BASE_TIMEFRAMES if (coverage or {}).get(tf.value, {}).get("count")]
