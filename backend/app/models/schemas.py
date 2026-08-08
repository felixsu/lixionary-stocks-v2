from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

SymbolKind = Literal["stock", "index"]


class SymbolCreate(BaseModel):
    symbol: str = Field(min_length=1, max_length=20)
    name: str | None = None
    notes: str | None = None

    @field_validator("symbol")
    @classmethod
    def normalise(cls, v: str) -> str:
        return v.strip().upper()


class SymbolUpdate(BaseModel):
    enabled: bool | None = None
    name: str | None = None
    notes: str | None = None


class CoverageEntry(BaseModel):
    first: datetime | None = None
    last: datetime | None = None
    count: int = 0


class SymbolOut(BaseModel):
    symbol: str
    yahoo_symbol: str
    name: str | None = None
    kind: SymbolKind = "stock"
    enabled: bool = True
    notes: str | None = None
    coverage: dict[str, CoverageEntry] = Field(default_factory=dict)
    last_poll_at: datetime | None = None
    last_error: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class BarOut(BaseModel):
    ts: datetime
    o: float
    h: float
    l: float
    c: float
    v: int | None = None
    final: bool = True


class CandlesOut(BaseModel):
    symbol: str
    timeframe: str
    source_timeframe: str | None = None
    derived: bool = False
    has_volume: bool = False
    count: int = 0
    bars: list[BarOut] = Field(default_factory=list)


class RunOut(BaseModel):
    run_id: str
    kind: str | None = None
    symbol: str | None = None
    timeframe: str | None = None
    status: str
    bars_fetched: int = 0
    bars_upserted: int = 0
    bars_modified: int = 0
    error: str | None = None
    duration_ms: int = 0
    started_at: datetime | None = None
    finished_at: datetime | None = None


class RunAccepted(BaseModel):
    run_id: str
    status: str = "accepted"
    detail: str | None = None


class SessionOut(BaseModel):
    now: datetime
    now_wib: str
    is_trading_day: bool
    session_open: bool
    poll_window_open: bool
    next_open: datetime
    next_close: datetime


class HealthOut(BaseModel):
    status: str
    mongo: bool
    symbols_enabled: int = 0
    candles: int = 0
    last_successful_poll: datetime | None = None
    breaker: dict[str, Any] = Field(default_factory=dict)
    session: SessionOut | None = None
