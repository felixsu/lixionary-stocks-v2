"""API routes for Notifications, Price Alerts, Watchlist Monitoring, and Telegram Integration."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.db.mongo import get_db
from app.services import notifications as svc
from app.sources import telegram as tg

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


class TargetUpdateIn(BaseModel):
    entry: float | None = Field(default=None, description="Entry alert level")
    stop: float | None = Field(default=None, description="Stop loss alert level")
    target: float | None = Field(default=None, description="Target price alert level")
    basis: str | None = Field(default=None, description="Rationale / notes for this level")
    enabled: bool = Field(default=True)


class SimulateAlertIn(BaseModel):
    symbol: str
    alert_type: str = Field(pattern="^(entry_hit|target_hit|stop_hit)$")
    current_price: float
    target_price: float
    basis: str = Field(default="Simulated test alert")
    send_telegram: bool = Field(default=True)


class MarkReadIn(BaseModel):
    ids: list[str] | None = Field(default=None)


class TelegramConfigIn(BaseModel):
    bot_token: str | None = None
    chat_id: str | None = None


class TelegramTestIn(BaseModel):
    bot_token: str | None = None
    chat_id: str | None = None
    message: str | None = None


@router.get("")
async def get_notifications(
    limit: int = Query(default=50, ge=1, le=200),
    unread_only: bool = Query(default=False),
):
    """Retrieve recent triggered notification history."""
    return await svc.list_notifications(get_db(), limit=limit, unread_only=unread_only)


@router.post("/read")
async def mark_read(payload: MarkReadIn | None = None):
    """Mark notifications as read (either a specific list of IDs or all)."""
    ids = payload.ids if payload else None
    return await svc.mark_notifications_read(get_db(), ids=ids)


@router.delete("")
async def clear_all_notifications():
    """Clear all notification history."""
    return await svc.clear_notifications(get_db())


@router.get("/targets")
async def get_monitored_targets():
    """Get active price alert targets (AI trade plans + custom overrides) for all watchlist stocks."""
    monitors = await svc.get_monitored_targets(get_db())
    return {"targets": monitors}


@router.put("/targets/{symbol}")
async def update_target(symbol: str, payload: TargetUpdateIn):
    """Set custom price alert levels for a specific stock."""
    return await svc.set_custom_target(
        get_db(),
        symbol=symbol,
        entry=payload.entry,
        stop=payload.stop,
        target=payload.target,
        basis=payload.basis,
        enabled=payload.enabled,
    )


@router.delete("/targets/{symbol}")
async def reset_target(symbol: str):
    """Reset a symbol's alert levels back to the AI-generated trade plan."""
    return await svc.remove_custom_target(get_db(), symbol)


@router.post("/check")
async def check_alerts_now():
    """Trigger an on-demand market price check against alert targets for all watchlist stocks."""
    return await svc.evaluate_watchlist_price_alerts(get_db(), force=True)


@router.post("/simulate")
async def trigger_simulation(payload: SimulateAlertIn):
    """Simulate a price alert event to preview in-app and Telegram notification delivery."""
    return await svc.simulate_alert(
        get_db(),
        symbol=payload.symbol,
        alert_type=payload.alert_type,
        current_price=payload.current_price,
        target_price=payload.target_price,
        basis=payload.basis,
        send_telegram=payload.send_telegram,
    )


@router.get("/telegram")
async def get_telegram_settings():
    """Get Telegram integration configuration with bot token masked."""
    cfg = await tg.get_telegram_config(get_db())
    token = cfg.get("bot_token", "")
    masked_token = (token[:6] + "..." + token[-4:]) if len(token) > 10 else ("configured" if token else "")
    return {
        "configured": bool(token and cfg.get("chat_id")),
        "has_token": bool(token),
        "has_chat_id": bool(cfg.get("chat_id")),
        "chat_id": cfg.get("chat_id", ""),
        "masked_token": masked_token,
    }


@router.put("/telegram")
async def update_telegram_settings(payload: TelegramConfigIn):
    """Save Telegram bot token and chat ID."""
    updated = await tg.set_telegram_config(
        get_db(),
        bot_token=payload.bot_token,
        chat_id=payload.chat_id,
    )
    token = updated.get("bot_token", "")
    masked_token = (token[:6] + "..." + token[-4:]) if len(token) > 10 else ("configured" if token else "")
    return {
        "configured": bool(token and updated.get("chat_id")),
        "chat_id": updated.get("chat_id", ""),
        "masked_token": masked_token,
    }


@router.post("/telegram/test")
async def test_telegram_message(payload: TelegramTestIn | None = None):
    """Send a test message to verify Telegram bot connection."""
    test_text = (
        payload.message
        if payload and payload.message
        else "🔔 <b>Lixionary Stock Notification Test</b>\n\nTelegram Bot connected successfully! You will receive price alerts here."
    )
    res = await tg.send_telegram_message(
        get_db(),
        test_text,
        bot_token_override=payload.bot_token if payload else None,
        chat_id_override=payload.chat_id if payload else None,
    )
    if res.get("status") == "error":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Telegram test failed: {res.get('error')}",
        )
    return res
