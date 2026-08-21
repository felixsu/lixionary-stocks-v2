"""Portfolio positions: current holdings, enriched with stored prices.

One document per symbol — current state only, no transaction ledger. The
weighted-average math on purchases happens at entry time (in the frontend,
deterministically); the backend stores and prices what it's given.

IDX convention: 1 lot = 100 shares.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, NamedTuple

from motor.motor_asyncio import AsyncIOMotorDatabase

from app.domain.calendar import session_day

SHARES_PER_LOT = 100

_PROJECTION = {"_id": 0}
_CASH_ID = "portfolio_cash"
_BAR_FIELDS = {"_id": 0, "c": 1, "ts": 1}


class PositionMissing(Exception):
    pass


class Quote(NamedTuple):
    """The price a position is marked at, and where it came from."""

    last: float | None = None
    prev: float | None = None
    as_of: datetime | None = None
    intraday: bool = False


NO_QUOTE = Quote()


def _pick_quote(daily: list[dict[str, Any]], intraday: dict[str, Any] | None) -> Quote:
    """Choose the mark price from the newest daily bars and the newest 5m bar.

    The 1d series is only written by ``close_of_day`` (16:30 WIB) and
    ``nightly_daily`` (02:00 WIB), so between the open and the close its newest
    bar is *yesterday's* -- pricing a portfolio off it during the session shows
    stale numbers all day. Whenever the 5m series has reached a session day the
    daily series has not, that intraday close is the current price and the last
    stored daily close becomes the day-change baseline.
    """
    d_last = daily[0] if daily else None
    d_prev = daily[1] if len(daily) > 1 else None

    if intraday is not None and (
        d_last is None or session_day(intraday["ts"]) > session_day(d_last["ts"])
    ):
        return Quote(
            last=intraday["c"],
            prev=d_last["c"] if d_last else None,
            as_of=intraday["ts"],
            intraday=True,
        )

    if d_last is None:
        return NO_QUOTE
    return Quote(
        last=d_last["c"],
        prev=d_prev["c"] if d_prev else None,
        as_of=d_last["ts"],
        intraday=False,
    )


async def _quotes(db: AsyncIOMotorDatabase, symbols: list[str]) -> dict[str, Quote]:
    """Current mark and day-change baseline per symbol, from the candle store."""
    out: dict[str, Quote] = {}
    for symbol in symbols:
        daily = [
            doc
            async for doc in db.candles.find({"symbol": symbol, "timeframe": "1d"}, _BAR_FIELDS)
            .sort("ts", -1)
            .limit(2)
        ]
        intraday = await db.candles.find_one(
            {"symbol": symbol, "timeframe": "5m"}, _BAR_FIELDS, sort=[("ts", -1)]
        )
        out[symbol] = _pick_quote(daily, intraday)
    return out


def _enrich(
    doc: dict[str, Any],
    last: float | None,
    prev: float | None,
    *,
    as_of: datetime | None = None,
    intraday: bool = False,
) -> dict[str, Any]:
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
        "price_as_of": as_of,
        "price_is_intraday": intraday,
        "market_value": value,
        "pnl": pnl,
        "pnl_pct": (pnl / cost * 100) if pnl is not None and cost else None,
        "day_change_pct": (((last - prev) / prev * 100) if last is not None and prev else None),
    }


async def list_positions(db: AsyncIOMotorDatabase) -> dict[str, Any]:
    docs = [d async for d in db.positions.find({}, _PROJECTION).sort("symbol", 1)]
    quotes = await _quotes(db, [d["symbol"] for d in docs])

    positions = [_enrich(d, **quotes.get(d["symbol"], NO_QUOTE)._asdict()) for d in docs]

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
    quotes = await _quotes(db, [sym])
    return _enrich(doc, **quotes[sym]._asdict())


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
