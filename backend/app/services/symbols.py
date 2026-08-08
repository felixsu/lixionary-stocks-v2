"""Subscribed-stock registry.

One flat collection, unlike v1's split between a global registry and per-user
lists. There is no auth in this phase and one operator, so a symbol is either
subscribed or it is not.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo.errors import DuplicateKeyError

from app.core.logging import get_logger
from app.sources.yahoo import SymbolNotFound, YahooSource, is_index, to_yahoo_symbol, yahoo

log = get_logger(__name__)

PROJECTION = {"_id": 0}


class SymbolExists(Exception):
    pass


class SymbolMissing(Exception):
    pass


async def list_symbols(
    db: AsyncIOMotorDatabase, enabled: bool | None = None
) -> list[dict[str, Any]]:
    query: dict[str, Any] = {}
    if enabled is not None:
        query["enabled"] = enabled
    cursor = db.symbols.find(query, PROJECTION).sort("symbol", 1)
    return [doc async for doc in cursor]


async def get_symbol(db: AsyncIOMotorDatabase, symbol: str) -> dict[str, Any]:
    doc = await db.symbols.find_one({"symbol": symbol.strip().upper()}, PROJECTION)
    if doc is None:
        raise SymbolMissing(symbol)
    return doc


async def create_symbol(
    db: AsyncIOMotorDatabase,
    symbol: str,
    *,
    name: str | None = None,
    notes: str | None = None,
    source: YahooSource | None = None,
    validate: bool = True,
) -> dict[str, Any]:
    """Register a symbol, verifying with the source that it actually exists.

    Validating up front stops a typo from becoming a subscription that silently
    fails on every poll forever.
    """
    src = source or yahoo
    sym = symbol.strip().upper()

    if await db.symbols.find_one({"symbol": sym}, {"_id": 1}):
        raise SymbolExists(sym)

    kind = "index" if is_index(sym) else "stock"
    resolved_name = name

    if validate:
        probe = await src.probe(sym)  # raises SymbolNotFound
        resolved_name = name or probe.get("name")
        kind = probe.get("kind", kind)

    now = datetime.now(UTC)
    doc = {
        "symbol": sym,
        "yahoo_symbol": to_yahoo_symbol(sym),
        "name": resolved_name,
        "kind": kind,
        "enabled": True,
        "notes": notes,
        "coverage": {},
        "last_poll_at": None,
        "last_error": None,
        "created_at": now,
        "updated_at": now,
    }
    try:
        await db.symbols.insert_one(dict(doc))
    except DuplicateKeyError as exc:
        raise SymbolExists(sym) from exc
    return doc


async def update_symbol(
    db: AsyncIOMotorDatabase, symbol: str, changes: dict[str, Any]
) -> dict[str, Any]:
    sym = symbol.strip().upper()
    fields = {k: v for k, v in changes.items() if v is not None}
    if not fields:
        return await get_symbol(db, sym)
    fields["updated_at"] = datetime.now(UTC)
    result = await db.symbols.update_one({"symbol": sym}, {"$set": fields})
    if result.matched_count == 0:
        raise SymbolMissing(sym)
    return await get_symbol(db, sym)


async def delete_symbol(
    db: AsyncIOMotorDatabase, symbol: str, *, purge: bool = False
) -> dict[str, int]:
    """Unsubscribe. Candles are kept unless ``purge`` is set.

    Keeping them by default matters because 5m history older than Yahoo's
    60-day window cannot be refetched -- an accidental delete would be permanent.
    """
    sym = symbol.strip().upper()
    result = await db.symbols.delete_one({"symbol": sym})
    if result.deleted_count == 0:
        raise SymbolMissing(sym)

    candles_deleted = 0
    if purge:
        deleted = await db.candles.delete_many({"symbol": sym})
        candles_deleted = deleted.deleted_count

    log.info("symbols.deleted", symbol=sym, purged=purge, candles=candles_deleted)
    return {"symbols_deleted": 1, "candles_deleted": candles_deleted}


async def enabled_symbols(db: AsyncIOMotorDatabase) -> list[str]:
    cursor = db.symbols.find({"enabled": True}, {"_id": 0, "symbol": 1}).sort("symbol", 1)
    return [doc["symbol"] async for doc in cursor]


__all__ = [
    "SymbolExists",
    "SymbolMissing",
    "SymbolNotFound",
    "create_symbol",
    "delete_symbol",
    "enabled_symbols",
    "get_symbol",
    "list_symbols",
    "update_symbol",
]
