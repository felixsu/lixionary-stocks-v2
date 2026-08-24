from __future__ import annotations

import uuid
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, HTTPException, status
from pydantic import BaseModel, Field, field_validator

from app.core.logging import get_logger
from app.db.mongo import get_db
from app.models.schemas import RunAccepted
from app.services import portfolio as svc
from app.services.recommendations import run_portfolio_recommendations

log = get_logger(__name__)
router = APIRouter(prefix="/api/portfolio", tags=["portfolio"])


class PositionIn(BaseModel):
    lots: int = Field(gt=0, le=1_000_000)
    # Per-SHARE price in IDR. The ceiling catches thousands-separator parsing
    # accidents ("710.00" read as 71000 is bad enough; 71 million is absurd).
    avg_price: float = Field(gt=0, le=1_000_000)
    notes: str | None = Field(default=None, max_length=500)


class CashIn(BaseModel):
    amount: float = Field(ge=0, le=1_000_000_000_000)  # 0 clears it; 1T IDR ceiling


class RecommendationIn(BaseModel):
    action: Literal["add_more", "hold", "reduce", "cut_loss", "take_profit"]
    summary: str = Field(max_length=500)
    reasons: list[str] = Field(default_factory=list, max_length=5)
    model: str = Field(max_length=100)
    generated_at: str

    @field_validator("reasons")
    @classmethod
    def cap_reason_length(cls, v: list[str]) -> list[str]:
        return [r[:300] for r in v]


class RecRunRequest(BaseModel):
    slot: str = Field(default="ad_hoc", pattern="^(pre_market|mid_day|ad_hoc)$")


@router.get("")
async def get_portfolio():
    return await svc.list_positions(get_db())


@router.get("/note")
async def get_portfolio_note():
    doc = await get_db().settings.find_one({"_id": "portfolio_note"}, {"_id": 0})
    return doc or {"note": None}


async def _run_recommendations_task(run_id: str, slot: str) -> None:
    try:
        await run_portfolio_recommendations(get_db(), slot=slot, force=True)
    except Exception as exc:  # noqa: BLE001
        log.warning("recommendations.manual_run_failed", run_id=run_id, slot=slot, error=str(exc))


@router.post("/recommendations/run", response_model=RunAccepted, status_code=202)
async def trigger_recommendations_run(
    background: BackgroundTasks, payload: RecRunRequest | None = None
):
    """Trigger an on-demand portfolio recommendations refresh."""
    run_id = uuid.uuid4().hex
    slot = payload.slot if payload else "ad_hoc"
    background.add_task(_run_recommendations_task, run_id, slot)
    return RunAccepted(run_id=run_id, detail=f"recommendations run started for slot {slot}")


# Must be declared BEFORE the /{symbol} routes, or "cash" is captured as a
# symbol. Reads come embedded in GET /api/portfolio ("cash" key).
@router.put("/cash")
async def put_cash(payload: CashIn):
    return await svc.set_cash(get_db(), payload.amount)


@router.put("/{symbol}")
async def put_position(symbol: str, payload: PositionIn):
    return await svc.upsert_position(
        get_db(), symbol, payload.lots, payload.avg_price, payload.notes
    )


@router.delete("/{symbol}")
async def delete_position(symbol: str):
    try:
        await svc.delete_position(get_db(), symbol)
    except svc.PositionMissing as exc:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, f"no position for {symbol}"
        ) from exc
    return {"deleted": symbol.strip().upper()}


@router.patch("/{symbol}/recommendation")
async def patch_recommendation(symbol: str, payload: RecommendationIn):
    try:
        await svc.store_recommendation(get_db(), symbol, payload.model_dump())
    except svc.PositionMissing as exc:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, f"no position for {symbol}"
        ) from exc
    return {"stored": symbol.strip().upper()}
