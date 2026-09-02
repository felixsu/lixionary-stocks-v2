"""Telegram notification source & client for price alert notifications."""

from __future__ import annotations

from typing import Any

import httpx
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.core.config import settings
from app.core.logging import get_logger

log = get_logger(__name__)

TELEGRAM_SETTINGS_ID = "telegram_config"


async def get_telegram_config(db: AsyncIOMotorDatabase) -> dict[str, str]:
    """Retrieve effective Telegram configuration (database settings or environment fallback)."""
    bot_token = settings.telegram_bot_token.strip()
    chat_id = settings.telegram_chat_id.strip()

    try:
        doc = await db.settings.find_one({"_id": TELEGRAM_SETTINGS_ID})
        if doc and isinstance(doc, dict):
            if doc.get("bot_token"):
                bot_token = str(doc["bot_token"]).strip()
            if doc.get("chat_id"):
                chat_id = str(doc["chat_id"]).strip()
    except Exception as exc:
        log.warning("telegram.get_config_failed", error=str(exc))

    return {"bot_token": bot_token, "chat_id": chat_id}


async def set_telegram_config(
    db: AsyncIOMotorDatabase, bot_token: str | None = None, chat_id: str | None = None
) -> dict[str, str]:
    """Update Telegram configuration in database."""
    update: dict[str, Any] = {}
    if bot_token is not None:
        update["bot_token"] = bot_token.strip()
    if chat_id is not None:
        update["chat_id"] = chat_id.strip()

    if update:
        await db.settings.update_one(
            {"_id": TELEGRAM_SETTINGS_ID},
            {"$set": update},
            upsert=True,
        )

    return await get_telegram_config(db)


def format_alert_message(
    symbol: str,
    alert_type: str,
    current_price: float,
    target_price: float,
    name: str | None = None,
    basis: str | None = None,
) -> str:
    """Format alert message with clean HTML formatting and clear signals."""
    sym_name = f" ({name})" if name else ""
    cur_str = f"Rp {int(current_price):,}".replace(",", ".")
    tgt_str = f"Rp {int(target_price):,}".replace(",", ".")

    if alert_type == "target_hit":
        header = f"🎯 <b>TARGET REACHED: {symbol}</b>{sym_name}"
        detail = f"Price reached or surpassed target level.\n• <b>Current:</b> {cur_str}\n• <b>Target:</b> {tgt_str}"
    elif alert_type == "entry_hit":
        header = f"🛒 <b>ENTRY SETUP HIT: {symbol}</b>{sym_name}"
        detail = f"Price reached attractive entry zone.\n• <b>Current:</b> {cur_str}\n• <b>Entry:</b> {tgt_str}"
    elif alert_type == "stop_hit":
        header = f"🛑 <b>STOP LOSS TRIGGERED: {symbol}</b>{sym_name}"
        detail = f"Price breached structural stop level.\n• <b>Current:</b> {cur_str}\n• <b>Stop:</b> {tgt_str}"
    else:
        header = f"🔔 <b>PRICE ALERT: {symbol}</b>{sym_name}"
        detail = f"• <b>Current:</b> {cur_str}\n• <b>Target:</b> {tgt_str}"

    basis_line = f"\n• <i>Basis: {basis}</i>" if basis else ""
    footer = "\n\n<i>Lixionary Stock Alert • Automated Signal</i>"

    return f"{header}\n\n{detail}{basis_line}{footer}"


async def send_telegram_message(
    db: AsyncIOMotorDatabase,
    text: str,
    *,
    bot_token_override: str | None = None,
    chat_id_override: str | None = None,
) -> dict[str, Any]:
    """Send a message via Telegram Bot API."""
    cfg = await get_telegram_config(db)
    bot_token = bot_token_override or cfg.get("bot_token")
    chat_id = chat_id_override or cfg.get("chat_id")

    if not bot_token or not chat_id:
        log.info("telegram.skipped_not_configured")
        return {"status": "skipped", "reason": "not_configured"}

    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(url, json=payload)
            data = resp.json()
            if resp.status_code == 200 and data.get("ok"):
                log.info("telegram.message_sent", chat_id=chat_id)
                return {"status": "sent", "message_id": data.get("result", {}).get("message_id")}
            err_desc = data.get("description", f"HTTP {resp.status_code}")
            log.warning("telegram.send_failed", error=err_desc, status_code=resp.status_code)
            return {"status": "error", "error": err_desc}
    except Exception as exc:
        log.warning("telegram.send_exception", error=str(exc))
        return {"status": "error", "error": str(exc)}
