"""Portfolio AI Recommendations Service.

Generates pre-market and mid-day recommendations (add_more, hold, reduce, cut_loss, take_profit)
and overall portfolio risk notes for held positions.
"""

from __future__ import annotations

import json
import re
import uuid
from datetime import UTC, datetime
from typing import Any

from motor.motor_asyncio import AsyncIOMotorDatabase

from app.core.logging import get_logger
from app.domain.calendar import is_trading_day, session_day
from app.domain.indicators import (
    compute_scorecard,
    daily_rvol,
    ichimoku,
    macd,
    rsi,
    support_resistance,
)
from app.domain.timeframes import Timeframe
from app.services.candles import get_candles
from app.services.portfolio import get_cash, list_positions
from app.sources import llm

log = get_logger(__name__)

REC_ACTIONS = {"add_more", "hold", "reduce", "cut_loss", "take_profit"}

REC_SYSTEM_PROMPT = """You are a technical analyst reviewing a personal IDX stock portfolio. You receive: available cash (IDR), portfolio totals, and for each position its entry price, current price, lots (1 lot = 100 shares), market value, P&L, a 10-signal daily technical scorecard, daily relative volume (RVOL vs the 20-session average), and recent news sentiment tags. Recommend ONE action per position based ONLY on this data.

Respond with a single JSON object, no markdown fences:
{"positions": [{"symbol": "...", "action": "add_more"|"hold"|"reduce"|"cut_loss"|"take_profit", "summary": "<one sentence>", "reasons": ["<2-3 short bullets citing the data>"]}], "portfolio_note": "<one sentence on overall portfolio risk: concentration, cash allocation>"}

Guidance: "cut_loss" for deteriorating technicals with meaningful drawdown; "take_profit" for stretched gains with weakening signals; "add_more" (including averaging down) ONLY when technicals AND news support it AND available cash can plausibly fund a meaningful buy — one reason bullet must cite the cash constraint (approx cost = lots × 100 × price); never recommend add_more when cash is near zero. Be conservative — "hold" is the default when evidence is mixed. This is informational analysis, not advice; the app shows a disclaimer."""


def parse_recommendations_response(raw: str) -> dict[str, Any]:
    text = raw.strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if fence:
        text = fence.group(1).strip()
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end <= start:
        raise ValueError("response was not a JSON object")

    parsed = json.loads(text[start : end + 1])
    if not isinstance(parsed, dict):
        raise ValueError("response was not a JSON object")

    positions: list[dict[str, Any]] = []
    for p in parsed.get("positions") or []:
        if not isinstance(p, dict):
            continue
        sym = str(p.get("symbol") or "").strip().upper()
        act = str(p.get("action") or "").lower()
        if not sym or act not in REC_ACTIONS:
            continue
        summary = str(p.get("summary") or "")
        reasons = [str(r) for r in (p.get("reasons") or []) if isinstance(r, str)][:3]
        positions.append({
            "symbol": sym,
            "action": act,
            "summary": summary,
            "reasons": reasons,
        })

    portfolio_note = str(parsed.get("portfolio_note") or "")
    return {"positions": positions, "portfolio_note": portfolio_note}


async def _enrich_position_data(
    db: AsyncIOMotorDatabase, p: dict[str, Any], now: datetime
) -> dict[str, Any]:
    sym = p["symbol"]
    scorecard: dict[str, Any] | None = None
    volume_data: dict[str, Any] | None = None
    news_tags: list[dict[str, Any]] = []

    try:
        # Load daily candles
        daily_res = await get_candles(db, sym, Timeframe.D1, limit=200, now=now)
        bars = daily_res.get("bars", [])
        if len(bars) >= 20:
            closes = [b["c"] for b in bars]
            ichi = ichimoku(bars)
            macd_res = macd(closes)
            rsi_arr = rsi(closes)
            sr = support_resistance(bars)
            sc = compute_scorecard(bars, ichi, macd_res, rsi_arr, sr)
            scorecard = {
                "overall": sc["overall"],
                "bullish": sc["bullish"],
                "neutral": sc["neutral"],
                "bearish": sc["bearish"],
                "signals": [
                    {"name": s["name"], "verdict": s["verdict"], "value": s["value"]}
                    for s in sc["signals"]
                ],
            }
            rv = daily_rvol(bars, 20)
            if rv:
                volume_data = {
                    "rvol": round(rv["rvol"], 2),
                    "baseline_sessions": rv["baseline_sessions"],
                }
    except Exception as exc:
        log.warning("recommendations.position_candles_failed", symbol=sym, error=str(exc))

    try:
        # Load recent news tags
        cursor = (
            db.news_items.find(
                {"analysis.relevant": True, "analysis.symbols.symbol": sym},
                {"_id": 0, "title": 1, "analysis": 1},
            )
            .sort("published_at", -1)
            .limit(5)
        )
        async for doc in cursor:
            an = doc.get("analysis") or {}
            matching_sym = next(
                (s for s in an.get("symbols", []) if s.get("symbol") == sym), None
            )
            news_tags.append({
                "title": doc.get("title", ""),
                "sentiment": an.get("sentiment", "neutral"),
                "direction": matching_sym.get("direction") if matching_sym else None,
            })
    except Exception as exc:
        log.warning("recommendations.position_news_failed", symbol=sym, error=str(exc))

    return {
        "symbol": sym,
        "lots": p["lots"],
        "avg_price": p["avg_price"],
        "last_close": p.get("last_close"),
        "market_value": p.get("market_value"),
        "pnl": p.get("pnl"),
        "pnl_pct": p.get("pnl_pct"),
        "day_change_pct": p.get("day_change_pct"),
        "technical_scorecard_daily": scorecard,
        "volume_daily": volume_data,
        "recent_news": news_tags,
    }


async def run_portfolio_recommendations(
    db: AsyncIOMotorDatabase,
    slot: str = "ad_hoc",  # "pre_market" | "mid_day" | "ad_hoc"
    *,
    force: bool = False,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Evaluate all portfolio positions and refresh recommendations."""
    run_id = uuid.uuid4().hex
    started = datetime.now(UTC)
    now_dt = now or started

    if not force and not is_trading_day(session_day(now_dt)):
        log.info("recommendations.skipped_holiday_or_weekend", slot=slot, now=now_dt.isoformat())
        return {"run_id": run_id, "status": "skipped", "reason": "not_trading_day"}

    cfg = await llm.get_effective_llm_config(db)
    if not llm.is_configured(cfg):
        log.warning("recommendations.skipped_llm_not_configured", slot=slot)
        return {"run_id": run_id, "status": "skipped", "reason": "llm_not_configured"}

    port = await list_positions(db)
    positions = port.get("positions", [])
    if not positions:
        log.info("recommendations.no_positions", slot=slot)
        return {"run_id": run_id, "status": "ok", "positions_count": 0}

    cash = await get_cash(db)
    enriched = [await _enrich_position_data(db, p, now_dt) for p in positions]

    payload = {
        "cash": cash,
        "totals": port.get("totals", {}),
        "positions": enriched,
        "note": f"IDX portfolio; {slot} evaluation; prices IDR; 1 lot = 100 shares; cash is uninvested IDR",
    }

    raw_reply = await llm.chat(
        [
            {"role": "system", "content": REC_SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
        ],
        db=db,
    )

    parsed = parse_recommendations_response(raw_reply)
    model_str = f"{cfg.get('provider', '')}/{cfg.get('model', '')}".strip("/")

    # Update recommendations on db.positions
    updated_count = 0
    for rec in parsed["positions"]:
        sym = rec["symbol"]
        rec_doc = {
            "action": rec["action"],
            "summary": rec["summary"],
            "reasons": rec["reasons"],
            "model": model_str,
            "slot": slot,
            "generated_at": now_dt.isoformat(),
        }
        res = await db.positions.update_one(
            {"symbol": sym},
            {"$set": {"recommendation": rec_doc, "updated_at": now_dt}},
        )
        if res.matched_count > 0:
            updated_count += 1

    # Update portfolio_note in settings
    if parsed["portfolio_note"]:
        await db.settings.update_one(
            {"_id": "portfolio_note"},
            {
                "$set": {
                    "note": parsed["portfolio_note"],
                    "model": model_str,
                    "slot": slot,
                    "generated_at": now_dt,
                }
            },
            upsert=True,
        )

    duration_ms = int((datetime.now(UTC) - started).total_seconds() * 1000)

    # Audit log
    await db.ingest_runs.insert_one(
        {
            "run_id": run_id,
            "kind": "recommendations",
            "symbol": None,
            "timeframe": None,
            "status": "ok",
            "bars_fetched": len(positions),
            "bars_upserted": updated_count,
            "bars_modified": 1 if parsed["portfolio_note"] else 0,
            "error": None,
            "duration_ms": duration_ms,
            "started_at": started,
            "finished_at": datetime.now(UTC),
            "slot": slot,
        }
    )

    log.info(
        "recommendations.cycle_finished",
        slot=slot,
        positions_updated=updated_count,
        duration_ms=duration_ms,
    )

    return {
        "run_id": run_id,
        "slot": slot,
        "positions_updated": updated_count,
        "portfolio_note": parsed["portfolio_note"],
        "status": "ok",
        "duration_ms": duration_ms,
    }
