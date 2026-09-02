"""Price Alert & Notification Service.

Monitors watchlist stocks against AI and customized trade plan price levels (Entry, Stop Loss, Target).
Evaluates current market prices periodically during market hours and triggers in-app and Telegram alerts.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from motor.motor_asyncio import AsyncIOMotorDatabase

from app.core.logging import get_logger
from app.domain.calendar import is_trading_day, session_day
from app.services.analytics import get_stockpicks
from app.sources.telegram import format_alert_message, send_telegram_message

log = get_logger(__name__)

ALERT_TARGETS_ID = "alert_targets"


async def get_latest_symbol_price(db: AsyncIOMotorDatabase, symbol: str) -> float | None:
    """Get latest closing price for symbol from recent 5m bar, falling back to 1d bar."""
    doc = await db.candles.find_one(
        {"symbol": symbol, "timeframe": "5m"},
        {"_id": 0, "c": 1},
        sort=[("ts", -1)],
    )
    if doc and doc.get("c") is not None:
        return float(doc["c"])

    daily_doc = await db.candles.find_one(
        {"symbol": symbol, "timeframe": "1d"},
        {"_id": 0, "c": 1},
        sort=[("ts", -1)],
    )
    if daily_doc and daily_doc.get("c") is not None:
        return float(daily_doc["c"])

    return None


async def get_monitored_targets(
    db: AsyncIOMotorDatabase, now: datetime | None = None
) -> list[dict[str, Any]]:
    """Return active price alert monitors for all watchlist stocks."""
    now_dt = now or datetime.now(UTC)
    session_str = session_day(now_dt).isoformat()
    watchlist = await get_stockpicks(db)

    # Load manual overrides
    overrides_doc = await db.settings.find_one({"_id": ALERT_TARGETS_ID})
    overrides: dict[str, Any] = overrides_doc.get("targets", {}) if overrides_doc else {}

    # Load today's triggered notifications to mark alert statuses
    today_alerts = await db.notifications.find(
        {"session_date": session_str},
        {"_id": 0, "symbol": 1, "alert_type": 1},
    ).to_list(length=100)
    triggered_set = {(a["symbol"], a["alert_type"]) for a in today_alerts if "symbol" in a and "alert_type" in a}

    monitors: list[dict[str, Any]] = []

    for sym in watchlist:
        meta = await db.symbols.find_one({"symbol": sym}, {"_id": 0, "name": 1})
        name = meta.get("name") if meta else None
        current_price = await get_latest_symbol_price(db, sym)

        custom = overrides.get(sym)
        entry: float | None = None
        stop: float | None = None
        target: float | None = None
        basis: str = ""
        source: str = "ai"
        enabled: bool = True

        if custom and isinstance(custom, dict) and custom.get("enabled", True):
            entry = custom.get("entry")
            stop = custom.get("stop")
            target = custom.get("target")
            basis = custom.get("basis", "Manual custom level")
            source = "manual"
            enabled = bool(custom.get("enabled", True))
        else:
            # Fallback to latest AI trade plan
            analysis = await db.stock_analyses.find_one(
                {"symbol": sym, "plan": {"$ne": None}},
                {"_id": 0, "plan": 1},
                sort=[("generated_at", -1)],
            )
            if analysis and analysis.get("plan"):
                p = analysis["plan"]
                entry = p.get("entry")
                stop = p.get("stop")
                target = p.get("target")
                basis = p.get("basis", "AI Trade Plan")
                source = "ai"

        # Calculate distances from current price
        entry_dist_pct: float | None = None
        target_dist_pct: float | None = None
        stop_dist_pct: float | None = None

        if current_price and current_price > 0:
            if entry is not None:
                entry_dist_pct = round(((current_price - entry) / entry) * 100, 2)
            if target is not None:
                target_dist_pct = round(((target - current_price) / current_price) * 100, 2)
            if stop is not None:
                stop_dist_pct = round(((current_price - stop) / current_price) * 100, 2)

        monitors.append({
            "symbol": sym,
            "name": name,
            "current_price": current_price,
            "entry": entry,
            "stop": stop,
            "target": target,
            "basis": basis,
            "source": source,
            "enabled": enabled,
            "entry_dist_pct": entry_dist_pct,
            "target_dist_pct": target_dist_pct,
            "stop_dist_pct": stop_dist_pct,
            "entry_triggered_today": (sym, "entry_hit") in triggered_set,
            "target_triggered_today": (sym, "target_hit") in triggered_set,
            "stop_triggered_today": (sym, "stop_hit") in triggered_set,
        })

    return monitors


async def set_custom_target(
    db: AsyncIOMotorDatabase,
    symbol: str,
    entry: float | None,
    stop: float | None,
    target: float | None,
    basis: str | None = None,
    enabled: bool = True,
) -> dict[str, Any]:
    """Set custom alert target levels for a symbol."""
    sym = symbol.strip().upper()
    target_data = {
        "entry": entry,
        "stop": stop,
        "target": target,
        "basis": basis or "Manual custom levels",
        "enabled": enabled,
        "updated_at": datetime.now(UTC),
    }
    await db.settings.update_one(
        {"_id": ALERT_TARGETS_ID},
        {"$set": {f"targets.{sym}": target_data}},
        upsert=True,
    )
    return {"symbol": sym, **target_data}


async def remove_custom_target(db: AsyncIOMotorDatabase, symbol: str) -> dict[str, Any]:
    """Revert a symbol back to using the AI trade plan."""
    sym = symbol.strip().upper()
    await db.settings.update_one(
        {"_id": ALERT_TARGETS_ID},
        {"$unset": {f"targets.{sym}": ""}},
    )
    return {"symbol": sym, "reverted_to_ai": True}


async def evaluate_watchlist_price_alerts(
    db: AsyncIOMotorDatabase,
    *,
    now: datetime | None = None,
    force: bool = False,
) -> dict[str, Any]:
    """Check current market prices for watchlist against alert levels and trigger notifications."""
    now_dt = now or datetime.now(UTC)
    session = session_day(now_dt)
    session_str = session.isoformat()

    if not force and not is_trading_day(session):
        log.info("notifications.skipped_non_trading_day", now=now_dt.isoformat())
        return {"status": "skipped", "reason": "not_trading_day", "triggered": 0}

    monitors = await get_monitored_targets(db, now=now_dt)
    triggered_count = 0
    triggered_items: list[dict[str, Any]] = []

    for mon in monitors:
        if not mon.get("enabled"):
            continue

        sym = mon["symbol"]
        price = mon.get("current_price")
        if price is None or price <= 0:
            continue

        entry = mon.get("entry")
        target = mon.get("target")
        stop = mon.get("stop")
        name = mon.get("name")
        basis = mon.get("basis")
        source = mon.get("source", "ai")

        candidates: list[tuple[str, float]] = []

        # 1. Check Entry hit: price drops to or below entry
        if entry is not None and price <= entry and not mon.get("entry_triggered_today"):
            candidates.append(("entry_hit", entry))

        # 2. Check Target hit: price reaches or exceeds target
        if target is not None and price >= target and not mon.get("target_triggered_today"):
            candidates.append(("target_hit", target))

        # 3. Check Stop hit: price drops to or below stop loss
        if stop is not None and price <= stop and not mon.get("stop_triggered_today"):
            candidates.append(("stop_hit", stop))

        for alert_type, target_val in candidates:
            # Check duplicate in db for today
            existing = await db.notifications.find_one({
                "symbol": sym,
                "alert_type": alert_type,
                "session_date": session_str,
            })
            if existing:
                continue

            notif_id = uuid.uuid4().hex
            notif_doc = {
                "_id": notif_id,
                "symbol": sym,
                "name": name,
                "alert_type": alert_type,
                "current_price": price,
                "target_price": target_val,
                "basis": basis,
                "source": source,
                "session_date": session_str,
                "created_at": now_dt,
                "read": False,
                "simulated": False,
                "telegram_status": "pending",
            }

            # Send Telegram message
            msg_text = format_alert_message(
                symbol=sym,
                alert_type=alert_type,
                current_price=price,
                target_price=target_val,
                name=name,
                basis=basis,
            )
            tg_res = await send_telegram_message(db, msg_text)
            notif_doc["telegram_status"] = tg_res.get("status", "error")

            await db.notifications.insert_one(notif_doc)
            triggered_count += 1
            triggered_items.append({
                "id": notif_id,
                "symbol": sym,
                "alert_type": alert_type,
                "price": price,
                "target_price": target_val,
                "telegram_status": notif_doc["telegram_status"],
            })

            log.info(
                "notifications.alert_triggered",
                symbol=sym,
                alert_type=alert_type,
                price=price,
                target=target_val,
                telegram=notif_doc["telegram_status"],
            )

    return {
        "status": "ok",
        "evaluated_count": len(monitors),
        "triggered_count": triggered_count,
        "alerts": triggered_items,
        "session_date": session_str,
    }


async def simulate_alert(
    db: AsyncIOMotorDatabase,
    symbol: str,
    alert_type: str,
    current_price: float,
    target_price: float,
    basis: str = "Simulated alert test",
    send_telegram: bool = True,
) -> dict[str, Any]:
    """Simulate an alert event on-demand for previewing in-app notifications and Telegram delivery."""
    sym = symbol.strip().upper()
    now_dt = datetime.now(UTC)
    session_str = session_day(now_dt).isoformat()
    meta = await db.symbols.find_one({"symbol": sym}, {"_id": 0, "name": 1})
    name = meta.get("name") if meta else None

    notif_id = uuid.uuid4().hex
    notif_doc = {
        "_id": notif_id,
        "symbol": sym,
        "name": name,
        "alert_type": alert_type,
        "current_price": current_price,
        "target_price": target_price,
        "basis": basis,
        "source": "simulation",
        "session_date": session_str,
        "created_at": now_dt,
        "read": False,
        "simulated": True,
        "telegram_status": "skipped" if not send_telegram else "pending",
    }

    if send_telegram:
        msg_text = format_alert_message(
            symbol=sym,
            alert_type=alert_type,
            current_price=current_price,
            target_price=target_price,
            name=name,
            basis=f"[Simulation] {basis}",
        )
        tg_res = await send_telegram_message(db, msg_text)
        notif_doc["telegram_status"] = tg_res.get("status", "error")

    await db.notifications.insert_one(notif_doc)
    return notif_doc


async def list_notifications(
    db: AsyncIOMotorDatabase,
    limit: int = 50,
    unread_only: bool = False,
) -> dict[str, Any]:
    """List recent triggered notifications with unread badge count."""
    query: dict[str, Any] = {}
    if unread_only:
        query["read"] = False

    cursor = db.notifications.find(query).sort("created_at", -1).limit(limit)
    items: list[dict[str, Any]] = []
    async for doc in cursor:
        doc["id"] = str(doc.pop("_id"))
        if isinstance(doc.get("created_at"), datetime):
            doc["created_at"] = doc["created_at"].isoformat()
        items.append(doc)

    unread_count = await db.notifications.count_documents({"read": False})
    return {"items": items, "unread_count": unread_count}


async def mark_notifications_read(
    db: AsyncIOMotorDatabase, ids: list[str] | None = None
) -> dict[str, Any]:
    """Mark specific notifications or all notifications as read."""
    if ids:
        res = await db.notifications.update_many({"_id": {"$in": ids}}, {"$set": {"read": True}})
    else:
        res = await db.notifications.update_many({"read": False}, {"$set": {"read": True}})
    return {"modified_count": res.modified_count}


async def clear_notifications(db: AsyncIOMotorDatabase) -> dict[str, Any]:
    """Delete all notification records from database."""
    res = await db.notifications.delete_many({})
    return {"deleted_count": res.deleted_count}
