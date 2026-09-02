"""Stock AI Analytics Service.

Generates pre-market and mid-day technical analytics & actionable trade plans
for subscribed stockpicks (favorites) using backend indicators, volume analysis,
news sentiment, and LLMs.
"""

from __future__ import annotations

import json
import math
import re
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from motor.motor_asyncio import AsyncIOMotorDatabase

from app.core.logging import get_logger
from app.domain.calendar import is_trading_day, session_day
from app.domain.idx_ticks import round_to_tick, tick_size
from app.domain.indicators import (
    ai_signal,
    atr,
    compute_scorecard,
    correlation,
    daily_rvol,
    ichimoku,
    macd,
    returns,
    rsi,
    session_rvol,
    support_resistance,
    volume_spike,
)
from app.domain.timeframes import Timeframe
from app.services.candles import get_candles
from app.services.symbols import enabled_symbols
from app.sources import llm

log = get_logger(__name__)

IHSG_SYMBOL = "^JKSE"
MAX_STOCKPICKS = 10
DETAIL_LIMIT = 200
MAX_LEVEL_DRIFT = 0.4

SYSTEM_PROMPT = """You are an equity and technical analyst covering Indonesia Stock Exchange (IDX) equities. You are given computed indicator data and recent relevant news items (if any) for one stock on one timeframe; the price feed is delayed about 10 minutes. Analyse ONLY the data provided — do not invent news, fundamentals, or prices.

Respond with a single JSON object, no markdown fences, exactly this shape:
{"stance": "bullish"|"bearish"|"neutral", "summary": "<one sentence overall read>", "bullets": ["<3 to 5 short observations grounded in the data>"], "risks": ["<1 to 2 things that would invalidate this read>"], "trade_plan": {"entry": <number|null>, "stop": <number|null>, "target": <number|null>, "basis": "<one line naming the levels these are anchored to>"}}

Guidance:
- Synthesize technical indicators with recent news: when relevant news items are provided in recent_news, incorporate their sentiment and catalysts into the summary, bullet points (citing headlines where relevant), and risks. When recent_news is empty, rely purely on technical indicators.
- Rules for trade_plan — the user trades long only, so never propose a short:
  - entry: the price to buy at. Use null when nothing in the data supports a long right now (a bearish read, or price extended far above every support). Do not invent an entry just to fill the field.
  - stop: the price that invalidates the read. Give one whenever you give an entry, AND also when stance is bearish — a holder needs an exit level exactly then. It must sit below entry, below a structural level (support, kijun, cloud bottom, a swing low), and further than 1x atr14 from entry so ordinary volatility does not trigger it.
  - target: the first realistic objective above entry — usually resistance or the next structural level. Null if the data defines none. Aim for at least 1.5x the entry-to-stop distance; if no target that far is justified by the data, say so in basis rather than inventing one.
  - Every price must be a plain number in rupiah, already rounded to the stock's tick_size given in the payload. No strings, no ranges, no currency symbols.
  - basis: name the actual levels, e.g. "entry on pullback to kijun 745; stop below the 40-bar swing low 700; target at resistance 830".

Be specific and quantitative (cite the numbers and headlines you were given). This is informational analysis, not investment advice, and the app already displays a disclaimer — do not add one."""


async def get_recent_news_for_symbol(
    db: AsyncIOMotorDatabase,
    symbol: str,
    now: datetime,
    days: int = 7,
    limit: int = 5,
) -> list[dict[str, Any]]:
    """Fetch up to `limit` relevant news items published in the last `days` days."""
    cutoff = now - timedelta(days=days)
    news_items: list[dict[str, Any]] = []
    try:
        cursor = (
            db.news_items.find(
                {
                    "analysis.relevant": True,
                    "analysis.symbols.symbol": symbol,
                    "published_at": {"$gte": cutoff},
                },
                {"_id": 0, "title": 1, "summary": 1, "published_at": 1, "analysis": 1},
            )
            .sort("published_at", -1)
            .limit(limit)
        )
        async for doc in cursor:
            an = doc.get("analysis") or {}
            matching_sym = next(
                (s for s in an.get("symbols", []) if s.get("symbol") == symbol), None
            )
            pub = doc.get("published_at")
            news_items.append({
                "title": doc.get("title", ""),
                "summary": doc.get("summary", ""),
                "published_at": pub.isoformat() if isinstance(pub, datetime) else str(pub or ""),
                "market_sentiment": an.get("sentiment", "neutral"),
                "impact": an.get("impact", "low"),
                "direction": matching_sym.get("direction") if matching_sym else None,
                "reason": matching_sym.get("reason") if matching_sym else an.get("note"),
            })
    except Exception as exc:
        log.warning("analytics.news_fetch_failed", symbol=symbol, error=str(exc))

    return news_items


async def get_stockpicks(db: AsyncIOMotorDatabase) -> list[str]:
    """Get active favorites/stockpicks. Falls back to enabled symbols."""
    doc = await db.settings.find_one({"_id": "favorites"})
    if doc and isinstance(doc.get("symbols"), list) and doc["symbols"]:
        return [str(s).strip().upper() for s in doc["symbols"]][:MAX_STOCKPICKS]

    # Fallback to up to MAX_STOCKPICKS enabled symbols
    syms = await enabled_symbols(db)
    non_index = [s for s in syms if not s.startswith("^")]
    return non_index[:MAX_STOCKPICKS]


async def set_stockpicks(db: AsyncIOMotorDatabase, symbols: list[str]) -> list[str]:
    """Store favorites list in database."""
    cleaned = [s.strip().upper() for s in symbols if s.strip()][:MAX_STOCKPICKS]
    await db.settings.update_one(
        {"_id": "favorites"},
        {"$set": {"symbols": cleaned, "updated_at": datetime.now(UTC)}},
        upsert=True,
    )
    return cleaned


def normalize_plan(raw_plan: Any, last_price: float) -> dict[str, Any] | None:
    if not isinstance(raw_plan, dict):
        return None

    def snap(v: Any, mode: str) -> float | None:
        if v is None:
            return None
        try:
            val = float(v)
        except (ValueError, TypeError):
            return None
        if not math.isfinite(val) or val <= 0:
            return None
        if math.isfinite(last_price) and last_price > 0:
            if abs(val - last_price) / last_price > MAX_LEVEL_DRIFT:
                return None
        return round_to_tick(val, mode=mode)  # type: ignore[arg-type]

    entry = snap(raw_plan.get("entry"), "nearest")
    stop = snap(raw_plan.get("stop"), "down")
    target = snap(raw_plan.get("target"), "up")

    if entry is not None and stop is not None and stop >= entry:
        stop = None
    if entry is not None and target is not None and target <= entry:
        target = None
    if entry is None:
        target = None
    if entry is None and stop is None:
        return None

    risk = (entry - stop) if (entry is not None and stop is not None) else None
    reward = (target - entry) if (entry is not None and target is not None) else None
    risk_pct = (risk / entry * 100) if (risk is not None and entry) else None
    reward_pct = (reward / entry * 100) if (reward is not None and entry) else None
    rr = (reward / risk) if (risk and reward and risk > 0) else None

    return {
        "entry": entry,
        "stop": stop,
        "target": target,
        "basis": str(raw_plan.get("basis") or ""),
        "risk_pct": round(risk_pct, 2) if risk_pct is not None else None,
        "reward_pct": round(reward_pct, 2) if reward_pct is not None else None,
        "rr": round(rr, 1) if rr is not None else None,
    }


def parse_analysis_response(raw: str, last_price: float) -> dict[str, Any]:
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

    stance = parsed.get("stance")
    if stance not in ("bullish", "bearish", "neutral"):
        stance = "neutral"

    bullets = [str(b) for b in (parsed.get("bullets") or []) if isinstance(b, str)]
    risks = [str(r) for r in (parsed.get("risks") or []) if isinstance(r, str)]

    return {
        "stance": stance,
        "summary": str(parsed.get("summary") or ""),
        "bullets": bullets,
        "risks": risks,
        "plan": normalize_plan(parsed.get("trade_plan"), last_price),
    }


async def analyze_symbol(
    db: AsyncIOMotorDatabase,
    symbol: str,
    timeframe: Timeframe,
    slot: str = "ad_hoc",
    now: datetime | None = None,
) -> dict[str, Any]:
    """Run full technical analysis and LLM plan generation for one symbol."""
    sym = symbol.strip().upper()
    now_dt = now or datetime.now(UTC)

    # 1. Fetch candles for the target timeframe
    candle_res = await get_candles(db, sym, timeframe, limit=DETAIL_LIMIT, now=now_dt)
    bars = candle_res.get("bars", [])
    if len(bars) < 5:
        raise ValueError(f"insufficient candle history for {sym} on {timeframe.value}")

    # 2. Fetch daily bars for price context and day range
    daily_res = await get_candles(db, sym, Timeframe.D1, limit=40, now=now_dt)
    daily_bars = daily_res.get("bars", [])
    last_daily = daily_bars[-1] if daily_bars else bars[-1]
    prev_daily = daily_bars[-2] if len(daily_bars) >= 2 else None

    price = bars[-1]["c"]
    prev_close = prev_daily["c"] if prev_daily else last_daily["o"]
    change_pct = ((price - prev_close) / prev_close * 100) if prev_close else 0.0
    day_low = min(b["l"] for b in bars[-20:]) if len(bars) >= 20 else bars[-1]["l"]
    day_high = max(b["h"] for b in bars[-20:]) if len(bars) >= 20 else bars[-1]["h"]

    # 3. Compute indicators
    closes = [b["c"] for b in bars]
    ichi = ichimoku(bars)
    sr = support_resistance(bars)
    macd_res = macd(closes)
    rsi_arr = rsi(closes)
    atr_arr = atr(bars)
    latest_atr = atr_arr[-1] if atr_arr else None
    heuristic = ai_signal(bars, ichi, macd_res, rsi_arr, sr)
    scorecard = compute_scorecard(bars, ichi, macd_res, rsi_arr, sr)

    # 4. Volume metrics
    session_vol = None
    if timeframe is Timeframe.D1:
        if len(daily_bars) >= 21:
            session_vol = daily_rvol(daily_bars, 20)
    else:
        # Load 5m bars for intraday session RVOL
        m5_res = await get_candles(db, sym, Timeframe.M5, limit=1000, now=now_dt)
        if m5_res.get("bars"):
            session_vol = session_rvol(m5_res["bars"])

    spike = volume_spike(bars)

    # 5. IHSG correlation
    ihsg_corr = None
    if not sym.startswith("^"):
        ihsg_res = await get_candles(db, IHSG_SYMBOL, Timeframe.D1, limit=40, now=now_dt)
        ihsg_bars = ihsg_res.get("bars", [])
        if len(daily_bars) >= 10 and len(ihsg_bars) >= 10:
            ihsg_corr = correlation(
                returns([b["c"] for b in daily_bars]),
                returns([b["c"] for b in ihsg_bars]),
            )

    # 6. Meta name
    meta_doc = await db.symbols.find_one({"symbol": sym}, {"_id": 0, "name": 1})
    name = meta_doc.get("name") if meta_doc else None

    # 7. Fetch recent relevant news for symbol (7-day window, top 5)
    recent_news = await get_recent_news_for_symbol(db, sym, now_dt, days=7, limit=5)

    # 8. Build LLM payload
    i = len(bars) - 1
    cloud_top = max(ichi["senkouA"][i], ichi["senkouB"][i])
    cloud_bottom = min(ichi["senkouA"][i], ichi["senkouB"][i])

    recent_bars = [
        {"t": b["ts"].isoformat(), "o": b["o"], "h": b["h"], "l": b["l"], "c": b["c"], "v": b.get("v")}
        for b in bars[-20:]
    ]

    payload = {
        "symbol": sym,
        "name": name,
        "timeframe": timeframe.value,
        "last_price": price,
        "change_pct_vs_prev_close": round(change_pct, 2),
        "day_range": {"low": day_low, "high": day_high},
        "recent_bars": recent_bars,
        "indicators": {
            "rsi14": round(rsi_arr[i], 2) if rsi_arr[i] is not None else None,
            "macd": {
                "line": round(macd_res["line"][i], 4) if macd_res["line"][i] is not None else None,
                "signal": round(macd_res["signal"][i], 4) if macd_res["signal"][i] is not None else None,
                "histogram": round(macd_res["hist"][i], 4) if macd_res["hist"][i] is not None else None,
            },
            "ichimoku": {
                "tenkan": round(ichi["tenkan"][i], 2),
                "kijun": round(ichi["kijun"][i], 2),
                "cloud_top": round(cloud_top, 2),
                "cloud_bottom": round(cloud_bottom, 2),
                "price_vs_cloud": "above" if price > cloud_top else "below" if price < cloud_bottom else "inside",
            },
            "support": round(sr["support"], 2),
            "resistance": round(sr["resistance"], 2),
            "atr14": round(latest_atr, 2) if latest_atr is not None else None,
        },
        "tick_size": tick_size(price),
        "volume": {
            "session_rvol": (
                {
                    "ratio": round(session_vol["rvol"], 2),
                    "session_date": session_vol["session_date"],
                    "baseline_sessions": session_vol["baseline_sessions"],
                    "note": "cumulative session volume vs average at same time-of-day",
                }
                if session_vol
                else None
            ),
            "last_bar_zscore": round(spike["z_score"], 2) if spike else None,
        },
        "correlation_with_ihsg_daily": round(ihsg_corr, 2) if ihsg_corr is not None else None,
        "heuristic_read": {
            "stance": heuristic["stance"],
            "reasons": heuristic["reasons"],
            "note": "simple rule-based read; you may confirm or dispute it",
        },
        "technical_scorecard": {
            "overall": scorecard["overall"],
            "counts": {
                "bullish": scorecard["bullish"],
                "neutral": scorecard["neutral"],
                "bearish": scorecard["bearish"],
            },
            "signals": [
                {"name": s["name"], "value": s["value"], "verdict": s["verdict"]}
                for s in scorecard["signals"]
            ],
        },
        "recent_news": recent_news,
    }

    # 9. Call LLM
    cfg = await llm.get_effective_llm_config(db)
    raw_reply = await llm.chat(
        [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
        ],
        db=db,
    )

    parsed = parse_analysis_response(raw_reply, price)
    model_str = f"{cfg.get('provider', '')}/{cfg.get('model', '')}".strip("/")

    analysis_doc = {
        "symbol": sym,
        "timeframe": timeframe.value,
        "slot": slot,  # "pre_market" | "mid_day" | "post_market" | "ad_hoc"
        "price": price,
        "stance": parsed["stance"],
        "summary": parsed["summary"],
        "bullets": parsed["bullets"],
        "risks": parsed["risks"],
        "plan": parsed["plan"],
        "model": model_str,
        "generated_at": now_dt,
    }

    # Upsert latest analysis for this symbol + timeframe + slot
    await db.stock_analyses.update_one(
        {"symbol": sym, "timeframe": timeframe.value, "slot": slot},
        {"$set": analysis_doc},
        upsert=True,
    )

    return analysis_doc


async def run_stockpicks_analytics(
    db: AsyncIOMotorDatabase,
    slot: str,  # "pre_market" | "mid_day" | "post_market" | "ad_hoc"
    *,
    force: bool = False,
    now: datetime | None = None,
    timeframe_choice: str = "auto",  # "auto" | "both" | "1d" | "1h"
) -> dict[str, Any]:
    """Run scheduled or on-demand analytics batch for all stockpicks."""
    run_id = uuid.uuid4().hex
    started = datetime.now(UTC)
    now_dt = now or started

    if not force and not is_trading_day(session_day(now_dt)):
        log.info("analytics.skipped_holiday_or_weekend", slot=slot, now=now_dt.isoformat())
        return {"run_id": run_id, "status": "skipped", "reason": "not_trading_day"}

    cfg = await llm.get_effective_llm_config(db)
    if not llm.is_configured(cfg):
        log.warning("analytics.skipped_llm_not_configured", slot=slot)
        return {"run_id": run_id, "status": "skipped", "reason": "llm_not_configured"}

    if timeframe_choice == "both":
        timeframes = [Timeframe.D1, Timeframe.H1]
    elif timeframe_choice == "1d":
        timeframes = [Timeframe.D1]
    elif timeframe_choice == "1h":
        timeframes = [Timeframe.H1]
    else:
        timeframes = [Timeframe.H1] if slot == "mid_day" else [Timeframe.D1]

    stockpicks = await get_stockpicks(db)
    results: list[dict[str, Any]] = []
    errors: list[str] = []

    for tf in timeframes:
        for sym in stockpicks:
            try:
                res = await analyze_symbol(db, sym, tf, slot=slot, now=now_dt)
                results.append(res)
            except Exception as exc:  # noqa: BLE001
                err_msg = f"{sym} ({tf.value}): {type(exc).__name__}: {exc}"
                errors.append(err_msg)
                log.warning("analytics.symbol_failed", symbol=sym, timeframe=tf.value, slot=slot, error=str(exc))

    status = "ok" if not errors else "partial" if results else "failed"
    duration_ms = int((datetime.now(UTC) - started).total_seconds() * 1000)
    tf_str = ",".join(t.value for t in timeframes)

    # Audit log to ingest_runs
    await db.ingest_runs.insert_one(
        {
            "run_id": run_id,
            "kind": "analytics",
            "symbol": None,
            "timeframe": tf_str,
            "status": status,
            "bars_fetched": len(stockpicks) * len(timeframes),
            "bars_upserted": len(results),
            "bars_modified": len(errors),
            "error": "; ".join(errors) if errors else None,
            "duration_ms": duration_ms,
            "started_at": started,
            "finished_at": datetime.now(UTC),
            "slot": slot,
        }
    )

    log.info(
        "analytics.cycle_finished",
        slot=slot,
        timeframe=tf_str,
        success=len(results),
        failed=len(errors),
        duration_ms=duration_ms,
    )

    return {
        "run_id": run_id,
        "slot": slot,
        "timeframe": tf_str,
        "analyzed_count": len(results),
        "error_count": len(errors),
        "status": status,
        "duration_ms": duration_ms,
    }
