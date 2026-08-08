import asyncio

import pymongo
from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase
from pymongo.errors import CollectionInvalid, OperationFailure

from app.core.config import settings
from app.core.logging import get_logger

log = get_logger(__name__)


class Mongo:
    client: AsyncIOMotorClient | None = None
    db: AsyncIOMotorDatabase | None = None


mongo = Mongo()


def get_db() -> AsyncIOMotorDatabase:
    if mongo.db is None:
        raise RuntimeError("MongoDB is not connected")
    return mongo.db


async def connect_to_mongo(*, ensure_indexes: bool = True) -> None:
    mongo.client = AsyncIOMotorClient(
        settings.mongo_uri,
        serverSelectionTimeoutMS=5000,
        connectTimeoutMS=5000,
        tz_aware=True,
    )
    mongo.db = mongo.client[settings.mongo_db]
    await mongo.client.admin.command("ping")
    log.info("mongo.connected", db=settings.mongo_db)

    if ensure_indexes:
        # v1 created indexes once at startup and silently skipped them if Mongo
        # was slow to come up, so production could run without them. Retry until
        # it actually succeeds.
        await _ensure_indexes_with_retry()


async def close_mongo() -> None:
    if mongo.client is not None:
        mongo.client.close()
        mongo.client = None
        mongo.db = None


async def _ensure_indexes_with_retry(attempts: int = 10, delay: float = 3.0) -> None:
    for attempt in range(1, attempts + 1):
        try:
            await ensure_indexes(get_db())
            log.info("mongo.indexes_ready")
            return
        except Exception as exc:
            if attempt == attempts:
                raise
            log.warning("mongo.index_retry", attempt=attempt, error=str(exc))
            await asyncio.sleep(delay)


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db.symbols.create_index("symbol", unique=True)
    await db.symbols.create_index("enabled")

    # The unique key is what makes re-polling idempotent: the most recent bar is
    # still forming and gets rewritten on every poll. It doubles as the range-scan
    # index for candle reads.
    await db.candles.create_index(
        [("symbol", 1), ("timeframe", 1), ("ts", 1)],
        unique=True,
        name="uniq_symbol_tf_ts",
    )

    await db.ingest_runs.create_index([("started_at", -1)])
    await db.ingest_runs.create_index("run_id")
    await _ensure_ttl_index(
        db,
        "ingest_runs",
        "started_at",
        settings.ingest_runs_ttl_days * 86400,
        "ttl_started_at",
    )

    await db.holidays.create_index("date", unique=True)

    await db.positions.create_index("symbol", unique=True)

    await db.news_items.create_index("url", unique=True)
    await db.news_items.create_index([("published_at", -1)])
    await db.news_items.create_index("analysis.symbols.symbol")
    await _ensure_ttl_index(
        db,
        "news_items",
        "fetched_at",
        settings.news_retention_days * 86400,
        "ttl_fetched_at",
    )


async def _ensure_ttl_index(
    db: AsyncIOMotorDatabase,
    collection: str,
    field: str,
    expire_after_seconds: int,
    name: str,
) -> None:
    """Create a TTL index, recreating it if the retention window changed.

    Mongo rejects create_index on an existing index whose options differ, so a
    changed `ingest_runs_ttl_days` would otherwise fail forever at startup.
    """
    try:
        await db[collection].create_index(
            [(field, pymongo.ASCENDING)],
            expireAfterSeconds=expire_after_seconds,
            name=name,
        )
    except OperationFailure as exc:
        if exc.code not in (85, 86):  # IndexOptionsConflict, IndexKeySpecsConflict
            raise
        log.info("mongo.ttl_index_recreate", collection=collection, name=name)
        await db[collection].drop_index(name)
        await db[collection].create_index(
            [(field, pymongo.ASCENDING)],
            expireAfterSeconds=expire_after_seconds,
            name=name,
        )


async def ensure_collections(db: AsyncIOMotorDatabase) -> None:
    for name in ("symbols", "candles", "ingest_runs", "holidays", "news_items", "positions"):
        try:
            await db.create_collection(name)
        except CollectionInvalid:
            pass
