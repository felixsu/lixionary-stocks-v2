from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.core.logging import get_logger
from app.db.mongo import get_db
from app.domain.timeframes import Timeframe, parse
from app.models.schemas import RunAccepted
from app.services import analytics as svc

log = get_logger(__name__)
router = APIRouter(prefix="/api/analytics", tags=["analytics"])


class FavoritesIn(BaseModel):
    symbols: list[str] = Field(default_factory=list, max_length=10)


class RunRequest(BaseModel):
    slot: str = Field(default="ad_hoc", pattern="^(pre_market|mid_day|post_market|ad_hoc)$")


@router.get("/favorites")
async def get_favorites():
    symbols = await svc.get_stockpicks(get_db())
    return {"symbols": symbols}


@router.put("/favorites")
async def put_favorites(payload: FavoritesIn):
    saved = await svc.set_stockpicks(get_db(), payload.symbols)
    return {"symbols": saved}


@router.get("/{symbol}")
async def get_latest_analysis(
    symbol: str,
    timeframe: str | None = Query(default=None),
    slot: str | None = Query(default=None),
):
    query: dict[str, Any] = {"symbol": symbol.strip().upper()}
    if timeframe:
        try:
            tf = parse(timeframe)
            query["timeframe"] = tf.value
        except ValueError:
            pass
    if slot:
        query["slot"] = slot

    doc = await get_db().stock_analyses.find_one(
        query, {"_id": 0}, sort=[("generated_at", -1)]
    )
    if not doc:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, f"no analysis found for {symbol}"
        )
    return doc


async def _run_analytics_task(run_id: str, slot: str) -> None:
    try:
        await svc.run_stockpicks_analytics(get_db(), slot=slot, force=True)
    except Exception as exc:  # noqa: BLE001
        log.warning("analytics.manual_run_failed", run_id=run_id, slot=slot, error=str(exc))


@router.post("/run", response_model=RunAccepted, status_code=202)
async def trigger_analytics_run(
    background: BackgroundTasks, payload: RunRequest | None = None
):
    """Trigger an on-demand analytics batch run for all stockpicks."""
    run_id = uuid.uuid4().hex
    slot = payload.slot if payload else "ad_hoc"
    background.add_task(_run_analytics_task, run_id, slot)
    return RunAccepted(run_id=run_id, detail=f"analytics run started for slot {slot}")


async def _run_symbol_analysis_task(run_id: str, symbol: str, timeframe: Timeframe, slot: str) -> None:
    try:
        await svc.analyze_symbol(get_db(), symbol, timeframe, slot=slot)
    except Exception as exc:  # noqa: BLE001
        log.warning("analytics.symbol_run_failed", run_id=run_id, symbol=symbol, error=str(exc))


@router.post("/{symbol}/run", response_model=RunAccepted, status_code=202)
async def trigger_symbol_analysis(
    symbol: str,
    background: BackgroundTasks,
    timeframe: str = Query(default="1d"),
    slot: str = Query(default="ad_hoc"),
):
    """Trigger single-symbol on-demand analysis."""
    run_id = uuid.uuid4().hex
    try:
        tf = parse(timeframe)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    background.add_task(_run_symbol_analysis_task, run_id, symbol.strip().upper(), tf, slot)
    return RunAccepted(run_id=run_id, detail=f"analysis started for {symbol}")
