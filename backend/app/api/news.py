from __future__ import annotations

from typing import Any

from fastapi import APIRouter, BackgroundTasks, Query

from app.core.logging import get_logger
from app.db.mongo import get_db
from app.services.news import news_cycle, news_summary
from app.sources import llm

log = get_logger(__name__)
router = APIRouter(prefix="/api/news", tags=["news"])

_PROJECTION = {"_id": 0}


@router.get("")
async def list_news(
    symbol: str | None = Query(default=None),
    sentiment: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    include_irrelevant: bool = Query(default=False),
) -> dict[str, Any]:
    db = get_db()
    query: dict[str, Any] = {}
    if symbol:
        query["analysis.symbols.symbol"] = symbol.strip().upper()
    if sentiment:
        query["analysis.sentiment"] = sentiment
    if not include_irrelevant:
        # Unanalyzed items still show (analysis null) so fetch-only mode has
        # content; analyzed-but-irrelevant noise is hidden.
        query["$or"] = [{"analysis": None}, {"analysis.relevant": True}]

    cursor = db.news_items.find(query, _PROJECTION).sort("published_at", -1).limit(limit)
    items = [doc async for doc in cursor]
    return {
        "analysis_enabled": llm.is_configured(),
        "count": len(items),
        "items": items,
    }


@router.get("/summary")
async def get_summary() -> dict[str, Any]:
    return await news_summary(get_db())


async def _run_cycle() -> None:
    try:
        await news_cycle(get_db())
    except Exception as exc:  # noqa: BLE001
        log.warning("news.manual_cycle_failed", error=str(exc))


@router.post("/refresh", status_code=202)
async def refresh(background: BackgroundTasks) -> dict[str, str]:
    """Fetch + analyze now, in the background. Watch /api/system/runs (kind=news)."""
    background.add_task(_run_cycle)
    return {"status": "accepted", "detail": "news cycle started"}
