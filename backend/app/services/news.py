"""News pipeline: ingest RSS items, analyze them with the worker LLM, and
associate them with subscribed stocks.

Analysis batches every pending item into ONE chat call per cycle, which caps
LLM spend at ~48 calls/day regardless of news volume. Items the model marks
irrelevant are stored that way so they never re-analyze.
"""

from __future__ import annotations

import json
import re
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo import UpdateOne

from app.core.config import settings
from app.core.logging import get_logger
from app.services.symbols import enabled_symbols
from app.sources import llm
from app.sources.rss import fetch_all_feeds

log = get_logger(__name__)

SENTIMENTS = ("bullish", "bearish", "neutral")
IMPACTS = ("high", "medium", "low")
DIRECTIONS = ("positive", "negative")


async def ingest_feeds(db: AsyncIOMotorDatabase) -> dict[str, Any]:
    """Fetch all feeds and upsert on url — idempotent like candle ingestion."""
    items = await fetch_all_feeds()
    if not items:
        return {"fetched": 0, "new": 0}

    now = datetime.now(UTC)
    ops = [
        UpdateOne(
            {"url": item["url"]},
            {
                "$setOnInsert": {**item, "fetched_at": now, "analysis": None},
            },
            upsert=True,
        )
        for item in items
    ]
    result = await db.news_items.bulk_write(ops, ordered=False)
    summary = {"fetched": len(items), "new": result.upserted_count}
    log.info("news.ingested", **summary)
    return summary


_SYSTEM_PROMPT = """You are an equity market analyst covering the Indonesia Stock Exchange (IDX). You receive recent Indonesian news items (title + summary, in Indonesian) and a list of the stocks the user tracks. Judge each item's likely effect on Indonesian market sentiment using ONLY the given text — no outside knowledge of events, no invented facts.

Respond with a single JSON array, no markdown fences, one object per input item:
{"id": <item id>, "relevant": true|false, "sentiment": "bullish"|"bearish"|"neutral", "impact": "high"|"medium"|"low", "note": "<one short English sentence on the market implication>", "symbols": [{"symbol": "<from the tracked list only>", "direction": "positive"|"negative", "reason": "<short English phrase>"}]}

Rules:
- "relevant" is false for items with no plausible bearing on Indonesian markets, macro policy, energy, or the tracked stocks; give them sentiment "neutral", impact "low", empty symbols, empty note.
- Tag a symbol ONLY when the item has a concrete causal link to that company or its sector (e.g. fuel-price policy -> energy names; rate decision -> banks). Never tag all stocks by default.
- "sentiment" is the read for the broad Indonesian market, independent of per-symbol directions.
- No investment-advice language; describe the mechanism, not a recommendation."""


def parse_analysis_response(
    raw: str, valid_ids: set[int], valid_symbols: set[str]
) -> dict[int, dict[str, Any]]:
    """Parse the model's array, tolerating fences/prose; drop anything invalid."""
    text = raw.strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if fence:
        text = fence.group(1).strip()
    start = text.find("[")
    end = text.rfind("]")
    if start == -1 or end <= start:
        raise ValueError("response was not a JSON array")
    parsed = json.loads(text[start : end + 1])
    if not isinstance(parsed, list):
        raise ValueError("response was not a JSON array")

    out: dict[int, dict[str, Any]] = {}
    for entry in parsed:
        if not isinstance(entry, dict):
            continue
        item_id = entry.get("id")
        if not isinstance(item_id, int) or item_id not in valid_ids:
            continue
        sentiment = entry.get("sentiment")
        impact = entry.get("impact")
        symbols = []
        for s in entry.get("symbols") or []:
            if (
                isinstance(s, dict)
                and s.get("symbol") in valid_symbols
                and s.get("direction") in DIRECTIONS
            ):
                symbols.append(
                    {
                        "symbol": s["symbol"],
                        "direction": s["direction"],
                        "reason": str(s.get("reason") or "")[:200],
                    }
                )
        out[item_id] = {
            "relevant": bool(entry.get("relevant")),
            "sentiment": sentiment if sentiment in SENTIMENTS else "neutral",
            "impact": impact if impact in IMPACTS else "low",
            "note": str(entry.get("note") or "")[:300],
            "symbols": symbols,
        }
    return out


async def analyze_pending(db: AsyncIOMotorDatabase) -> dict[str, Any]:
    """Analyze up to news_analysis_batch unanalyzed items in one LLM call."""
    if not llm.is_configured():
        return {"skipped": "llm not configured"}

    cursor = (
        db.news_items.find({"analysis": None})
        .sort("published_at", -1)
        .limit(settings.news_analysis_batch)
    )
    items = [doc async for doc in cursor]
    if not items:
        return {"analyzed": 0}

    symbols = await enabled_symbols(db)
    sym_docs = db.symbols.find({"enabled": True}, {"_id": 0, "symbol": 1, "name": 1})
    tracked = [f"{d['symbol']} ({d.get('name') or d['symbol']})" async for d in sym_docs]

    payload = {
        "tracked_stocks": tracked,
        "items": [
            {
                "id": idx,
                "title": doc["title"],
                "summary": doc.get("summary") or "",
                "source": doc.get("source") or "",
                "category": doc.get("feed_category") or "",
            }
            for idx, doc in enumerate(items)
        ],
    }

    raw = await llm.chat(
        [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
        ]
    )
    verdicts = parse_analysis_response(raw, set(range(len(items))), set(symbols))

    now = datetime.now(UTC)
    ops = []
    for idx, doc in enumerate(items):
        verdict = verdicts.get(idx)
        if verdict is None:
            # Model skipped it — mark analyzed-irrelevant so it doesn't loop forever.
            verdict = {
                "relevant": False,
                "sentiment": "neutral",
                "impact": "low",
                "note": "",
                "symbols": [],
            }
        ops.append(
            UpdateOne(
                {"_id": doc["_id"]},
                {
                    "$set": {
                        "analysis": {
                            **verdict,
                            "model": f"{settings.llm_provider}/{settings.llm_model}",
                            "analyzed_at": now,
                        }
                    }
                },
            )
        )
    if ops:
        await db.news_items.bulk_write(ops, ordered=False)

    summary = {
        "analyzed": len(items),
        "relevant": sum(1 for v in verdicts.values() if v["relevant"]),
        "tagged": sum(len(v["symbols"]) for v in verdicts.values()),
    }
    log.info("news.analyzed", **summary)
    return summary


async def news_cycle(db: AsyncIOMotorDatabase) -> dict[str, Any]:
    """One cron cycle: ingest, then analyze whatever is pending."""
    run_id = uuid.uuid4().hex
    started = datetime.now(UTC)
    status = "ok"
    error: str | None = None
    ingested: dict[str, Any] = {}
    analyzed: dict[str, Any] = {}
    try:
        ingested = await ingest_feeds(db)
        try:
            analyzed = await analyze_pending(db)
        except llm.LlmNotConfigured:
            analyzed = {"skipped": "llm not configured"}
    except Exception as exc:  # noqa: BLE001 - the audit record carries the failure
        status = "failed"
        error = f"{type(exc).__name__}: {exc}"
        log.warning("news.cycle_failed", error=error)

    await db.ingest_runs.insert_one(
        {
            "run_id": run_id,
            "kind": "news",
            "symbol": None,
            "timeframe": None,
            "status": status,
            "bars_fetched": ingested.get("fetched", 0),
            "bars_upserted": ingested.get("new", 0),
            "bars_modified": analyzed.get("analyzed", 0),
            "error": error,
            "duration_ms": int((datetime.now(UTC) - started).total_seconds() * 1000),
            "started_at": started,
            "finished_at": datetime.now(UTC),
        }
    )
    return {"run_id": run_id, "ingested": ingested, "analyzed": analyzed, "status": status}


async def news_summary(db: AsyncIOMotorDatabase) -> dict[str, Any]:
    """Aggregate sentiment over the last 24h of analyzed, relevant items."""
    since = datetime.now(UTC) - timedelta(hours=24)
    match = {"analysis.relevant": True, "published_at": {"$gte": since}}

    counts = {s: 0 for s in SENTIMENTS}
    async for row in db.news_items.aggregate(
        [{"$match": match}, {"$group": {"_id": "$analysis.sentiment", "n": {"$sum": 1}}}]
    ):
        if row["_id"] in counts:
            counts[row["_id"]] = row["n"]

    top_symbols: list[dict[str, Any]] = []
    async for row in db.news_items.aggregate(
        [
            {"$match": match},
            {"$unwind": "$analysis.symbols"},
            {
                "$group": {
                    "_id": "$analysis.symbols.symbol",
                    "n": {"$sum": 1},
                    "positive": {
                        "$sum": {
                            "$cond": [
                                {"$eq": ["$analysis.symbols.direction", "positive"]},
                                1,
                                0,
                            ]
                        }
                    },
                }
            },
            {"$sort": {"n": -1}},
            {"$limit": 8},
        ]
    ):
        top_symbols.append(
            {"symbol": row["_id"], "mentions": row["n"], "positive": row["positive"]}
        )

    net = counts["bullish"] - counts["bearish"]
    lean = "bullish" if net > 0 else "bearish" if net < 0 else "neutral"
    total = await db.news_items.estimated_document_count()
    pending = await db.news_items.count_documents({"analysis": None})

    return {
        "analysis_enabled": llm.is_configured(),
        "window_hours": 24,
        "bullish": counts["bullish"],
        "bearish": counts["bearish"],
        "neutral": counts["neutral"],
        "lean": lean,
        "top_symbols": top_symbols,
        "total_items": total,
        "pending_analysis": pending,
    }
