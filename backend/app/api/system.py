from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Query
from pydantic import BaseModel, Field

from app.core.logging import get_logger
from app.db.mongo import get_db, mongo
from app.domain.calendar import (
    WIB,
    is_poll_window_open,
    is_session_open,
    is_trading_day,
    next_close,
    next_open,
)
from app.models.schemas import HealthOut, RunAccepted, RunOut, SessionOut
from app.services.coverage import refresh_all_coverage
from app.sources.llm import get_effective_llm_config, is_configured
from app.sources.yahoo import yahoo

log = get_logger(__name__)
router = APIRouter(prefix="/api/system", tags=["system"])


class LlmConfigIn(BaseModel):
    provider: str = Field(default="", pattern="^(|gemini|minimax|openai)$")
    model: str = Field(default="", max_length=100)
    api_key: str = Field(default="", max_length=200)


def _session_snapshot(now: datetime | None = None) -> SessionOut:
    now = now or datetime.now(UTC)
    local = now.astimezone(WIB)
    return SessionOut(
        now=now,
        now_wib=local.strftime("%Y-%m-%d %H:%M:%S %Z"),
        is_trading_day=is_trading_day(local.date()),
        session_open=is_session_open(now),
        poll_window_open=is_poll_window_open(now),
        next_open=next_open(now),
        next_close=next_close(now),
    )


@router.get("/session", response_model=SessionOut)
async def read_session():
    return _session_snapshot()


@router.get("/health", response_model=HealthOut)
async def health():
    mongo_ok = False
    symbols_enabled = 0
    candles = 0
    last_poll = None

    try:
        if mongo.client is not None:
            await mongo.client.admin.command("ping")
            mongo_ok = True
            db = get_db()
            symbols_enabled = await db.symbols.count_documents({"enabled": True})
            candles = await db.candles.estimated_document_count()
            doc = await db.ingest_runs.find_one(
                {"status": "ok"}, {"_id": 0, "finished_at": 1}, sort=[("started_at", -1)]
            )
            last_poll = doc.get("finished_at") if doc else None
    except Exception as exc:  # noqa: BLE001 - health must report, not raise
        log.warning("health.mongo_check_failed", error=str(exc))

    return HealthOut(
        status="ok" if mongo_ok else "degraded",
        mongo=mongo_ok,
        symbols_enabled=symbols_enabled,
        candles=candles,
        last_successful_poll=last_poll,
        breaker=yahoo.breaker.state,
        session=_session_snapshot(),
    )


@router.get("/runs", response_model=list[RunOut])
async def list_runs(
    limit: int = Query(default=50, ge=1, le=500),
    symbol: str | None = Query(default=None),
    status_filter: str | None = Query(default=None, alias="status"),
    run_id: str | None = Query(default=None),
):
    query: dict = {}
    if symbol:
        query["symbol"] = symbol.strip().upper()
    if status_filter:
        query["status"] = status_filter
    if run_id:
        query["run_id"] = run_id
    cursor = (
        get_db().ingest_runs.find(query, {"_id": 0}).sort("started_at", -1).limit(limit)
    )
    return [doc async for doc in cursor]


async def _run_poll(run_id: str) -> None:
    # Imported here to keep the worker's scheduler out of the API import graph.
    from app.worker.jobs import poll_all

    try:
        await poll_all(get_db(), run_id=run_id, force=True)
    except Exception as exc:  # noqa: BLE001
        log.warning("system.manual_poll_failed", run_id=run_id, error=str(exc))


@router.post("/poll", response_model=RunAccepted, status_code=202)
async def trigger_poll(background: BackgroundTasks):
    """Force a 5m poll now, ignoring the session gate.

    Returns immediately with a run id. v1's equivalent blocked the request for
    10-30 seconds with no way to observe or cancel it.
    """
    run_id = uuid.uuid4().hex
    background.add_task(_run_poll, run_id)
    return RunAccepted(run_id=run_id, detail="poll started")


@router.post("/coverage/refresh")
async def refresh_coverage_endpoint():
    count = await refresh_all_coverage(get_db())
    return {"symbols_refreshed": count}


@router.get("/llm")
async def get_llm_config():
    cfg = await get_effective_llm_config(get_db())
    has_key = bool(cfg.get("api_key"))
    key_masked = f"{cfg['api_key'][:4]}...{cfg['api_key'][-4:]}" if len(cfg.get("api_key", "")) > 8 else ("***" if has_key else "")
    return {
        "provider": cfg.get("provider", ""),
        "model": cfg.get("model", ""),
        "has_api_key": has_key,
        "api_key_masked": key_masked,
        "is_configured": is_configured(cfg),
    }


@router.put("/llm")
async def put_llm_config(payload: LlmConfigIn):
    db = get_db()
    update_data: dict[str, Any] = {
        "provider": payload.provider.strip(),
        "model": payload.model.strip(),
        "updated_at": datetime.now(UTC),
    }
    if payload.api_key.strip():
        update_data["api_key"] = payload.api_key.strip()

    await db.settings.update_one(
        {"_id": "llm_config"},
        {"$set": update_data},
        upsert=True,
    )
    return await get_llm_config()
