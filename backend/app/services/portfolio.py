"""Portfolio positions: current holdings, enriched with stored prices.

One document per symbol — current state only, no transaction ledger. The
weighted-average math on purchases happens at entry time (in the frontend,
deterministically); the backend stores and prices what it's given.

IDX convention: 1 lot = 100 shares.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from motor.motor_asyncio import AsyncIOMotorDatabase

SHARES_PER_LOT = 100

_PROJECTION = {"_id": 0}
_CASH_ID = "portfolio_cash"


class PositionMissing(Exception):
    pass


async def _latest_closes(
    db: AsyncIOMotorDatabase, symbols: list[str]
) -> dict[str, tuple[float | None, float | None]]:
    """Last and previous 1d close per symbol, from the candle store."""
    out: dict[str, tuple[float | None, float | None]] = {}
    for symbol in symbols:
        cursor = (
            db.candles.find(
                {"symbol": symbol, "timeframe": "1d"}, {"_id": 0, "c": 1, "ts": 1}
            )
            .sort("ts", -1)
            .limit(2)
        )
        closes = [doc["c"] async for doc in cursor]
        out[symbol] = (
            closes[0] if len(closes) > 0 else None,
            closes[1] if len(closes) > 1 else None,
        )
    return out


def _enrich(doc: dict[str, Any], last: float | None, prev: float | None) -> dict[str, Any]:
    lots = doc["lots"]
    avg = doc["avg_price"]
    shares = lots * SHARES_PER_LOT
    cost = shares * avg
    value = shares * last if last is not None else None
    pnl = value - cost if value is not None else None
    return {
        **doc,
        "shares": shares,
        "cost": cost,
        "last_close": last,
        "prev_close": prev,
        "market_value": value,
        "pnl": pnl,
        "pnl_pct": (pnl / cost * 100) if pnl is not None and cost else None,
        "day_change_pct": (
            ((last - prev) / prev * 100) if last is not None and prev else None
        ),
    }


async def list_positions(db: AsyncIOMotorDatabase) -> dict[str, Any]:
    docs = [d async for d in db.positions.find({}, _PROJECTION).sort("symbol", 1)]
    closes = await _latest_closes(db, [d["symbol"] for d in docs])

    positions = [_enrich(d, *closes.get(d["symbol"], (None, None))) for d in docs]

    total_cost = sum(p["cost"] for p in positions)
    valued = [p for p in positions if p["market_value"] is not None]
    total_value = sum(p["market_value"] for p in valued)
    # Only positions with a price participate in the P&L total; unpriced cost is
    # reported separately so the numbers always reconcile.
    valued_cost = sum(p["cost"] for p in valued)
    total_pnl = total_value - valued_cost

    return {
        "positions": positions,
        "cash": await get_cash(db),
        "totals": {
            "cost": total_cost,
            "market_value": total_value,
            "pnl": total_pnl,
            "pnl_pct": (total_pnl / valued_cost * 100) if valued_cost else None,
            "unpriced_cost": total_cost - valued_cost,
        },
    }


async def get_cash(db: AsyncIOMotorDatabase) -> float:
    doc = await db.settings.find_one({"_id": _CASH_ID})
    return float(doc["amount"]) if doc else 0.0


async def set_cash(db: AsyncIOMotorDatabase, amount: float) -> dict[str, Any]:
    await db.settings.update_one(
        {"_id": _CASH_ID},
        {"$set": {"amount": amount, "updated_at": datetime.now(UTC)}},
        upsert=True,
    )
    return {"amount": amount}


async def upsert_position(
    db: AsyncIOMotorDatabase,
    symbol: str,
    lots: int,
    avg_price: float,
    notes: str | None = None,
) -> dict[str, Any]:
    sym = symbol.strip().upper()
    now = datetime.now(UTC)
    update: dict[str, Any] = {
        "$set": {"lots": lots, "avg_price": avg_price, "updated_at": now},
        "$setOnInsert": {"symbol": sym, "recommendation": None, "created_at": now},
    }
    if notes is not None:
        update["$set"]["notes"] = notes
    await db.positions.update_one({"symbol": sym}, update, upsert=True)
    doc = await db.positions.find_one({"symbol": sym}, _PROJECTION)
    closes = await _latest_closes(db, [sym])
    return _enrich(doc, *closes[sym])


async def delete_position(db: AsyncIOMotorDatabase, symbol: str) -> None:
    result = await db.positions.delete_one({"symbol": symbol.strip().upper()})
    if result.deleted_count == 0:
        raise PositionMissing(symbol)


async def store_recommendation(
    db: AsyncIOMotorDatabase, symbol: str, recommendation: dict[str, Any]
) -> None:
    result = await db.positions.update_one(
        {"symbol": symbol.strip().upper()},
        {"$set": {"recommendation": recommendation, "updated_at": datetime.now(UTC)}},
    )
    if result.matched_count == 0:
        raise PositionMissing(symbol)
