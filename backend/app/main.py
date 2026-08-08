from __future__ import annotations

import contextlib
from collections.abc import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import candles, symbols, system
from app.core.config import settings
from app.core.logging import configure_logging, get_logger
from app.db.mongo import close_mongo, connect_to_mongo

log = get_logger(__name__)


@contextlib.asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    configure_logging()
    await connect_to_mongo()
    # No scheduler here on purpose: ingestion runs in the worker process so the
    # API can restart freely without interrupting it.
    log.info("api.started", port=settings.api_port)
    try:
        yield
    finally:
        await close_mongo()


app = FastAPI(
    title="Lixionary Stock v2",
    version="0.2.0",
    description="IDX OHLCV ingestion and analytics backend",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(symbols.router)
app.include_router(candles.router)
app.include_router(system.router)


@app.get("/", tags=["meta"])
async def root():
    return {
        "service": "lixionary-stock-v2",
        "version": "0.2.0",
        "docs": "/docs",
        "timeframes": ["5m", "15m", "30m", "1h", "2h", "4h", "1d"],
        "stored_timeframes": ["5m", "1h", "1d"],
        "upstream_delay_minutes": 10,
    }
