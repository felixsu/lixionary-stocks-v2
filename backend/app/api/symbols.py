from __future__ import annotations

import uuid

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, status

from app.core.logging import get_logger
from app.db.mongo import get_db
from app.models.schemas import RunAccepted, SymbolCreate, SymbolOut, SymbolUpdate
from app.services import symbols as svc
from app.services.backfill import backfill_symbol
from app.sources.yahoo import RateLimited, SymbolNotFound

log = get_logger(__name__)
router = APIRouter(prefix="/api/symbols", tags=["symbols"])


async def _run_backfill(symbol: str, run_id: str) -> None:
    try:
        await backfill_symbol(get_db(), symbol, run_id=run_id)
    except Exception as exc:  # noqa: BLE001 - background task must not crash the loop
        log.warning("backfill.failed", symbol=symbol, error=str(exc))


@router.get("", response_model=list[SymbolOut])
async def list_symbols(enabled: bool | None = Query(default=None)):
    return await svc.list_symbols(get_db(), enabled=enabled)


@router.post("", response_model=SymbolOut, status_code=status.HTTP_201_CREATED)
async def create_symbol(payload: SymbolCreate, background: BackgroundTasks):
    """Subscribe to a symbol and kick off its history backfill.

    Returns as soon as the symbol is registered; the backfill runs in the
    background and is observable via /api/system/runs.
    """
    try:
        doc = await svc.create_symbol(
            get_db(), payload.symbol, name=payload.name, notes=payload.notes
        )
    except svc.SymbolExists as exc:
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"{payload.symbol} is already subscribed"
        ) from exc
    except SymbolNotFound as exc:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, f"{payload.symbol} not found upstream: {exc}"
        ) from exc
    except RateLimited as exc:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, f"upstream rate limited: {exc}"
        ) from exc

    background.add_task(_run_backfill, doc["symbol"], uuid.uuid4().hex)
    return doc


@router.get("/{symbol}", response_model=SymbolOut)
async def get_symbol(symbol: str):
    try:
        return await svc.get_symbol(get_db(), symbol)
    except svc.SymbolMissing as exc:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, f"{symbol} is not subscribed"
        ) from exc


@router.patch("/{symbol}", response_model=SymbolOut)
async def update_symbol(symbol: str, payload: SymbolUpdate):
    try:
        return await svc.update_symbol(get_db(), symbol, payload.model_dump(exclude_unset=True))
    except svc.SymbolMissing as exc:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, f"{symbol} is not subscribed"
        ) from exc


@router.delete("/{symbol}")
async def delete_symbol(
    symbol: str,
    purge: bool = Query(
        default=False,
        description="Also delete stored candles. 5m history beyond Yahoo's 60-day "
        "window cannot be refetched, so this is irreversible.",
    ),
):
    try:
        return await svc.delete_symbol(get_db(), symbol, purge=purge)
    except svc.SymbolMissing as exc:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, f"{symbol} is not subscribed"
        ) from exc


@router.post("/{symbol}/backfill", response_model=RunAccepted, status_code=status.HTTP_202_ACCEPTED)
async def trigger_backfill(symbol: str, background: BackgroundTasks):
    try:
        doc = await svc.get_symbol(get_db(), symbol)
    except svc.SymbolMissing as exc:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, f"{symbol} is not subscribed"
        ) from exc

    run_id = uuid.uuid4().hex
    background.add_task(_run_backfill, doc["symbol"], run_id)
    return RunAccepted(run_id=run_id, detail=f"backfill started for {doc['symbol']}")
