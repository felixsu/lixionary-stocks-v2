"""Worker entrypoint: owns the scheduler, separate from the API process.

In v1 the scheduler ran inside the API's lifespan, so restarting the API dropped
in-flight ingestion and the API could never be scaled beyond one replica.
"""

from __future__ import annotations

import asyncio
import contextlib
import signal

from app.core.logging import configure_logging, get_logger
from app.db.mongo import close_mongo, connect_to_mongo
from app.worker.scheduler import shutdown_scheduler, start_scheduler

log = get_logger(__name__)


async def main() -> None:
    configure_logging()
    await connect_to_mongo()
    start_scheduler()
    log.info("worker.started")

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError):
            loop.add_signal_handler(sig, stop.set)

    try:
        await stop.wait()
    finally:
        log.info("worker.stopping")
        shutdown_scheduler()
        await close_mongo()


if __name__ == "__main__":
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(main())
