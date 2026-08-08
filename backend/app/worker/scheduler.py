from __future__ import annotations

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from app.core.config import settings
from app.core.logging import get_logger
from app.worker.jobs import (
    close_of_day,
    nightly_daily,
    poll_all,
    recalc_coverage,
    refresh_hourly,
)

log = get_logger(__name__)

_scheduler: AsyncIOScheduler | None = None


def build_scheduler() -> AsyncIOScheduler:
    scheduler = AsyncIOScheduler(timezone=settings.app_timezone)

    # All jobs use coalesce + max_instances=1: if the process was busy or asleep,
    # run once on catch-up rather than stacking a backlog of identical fetches.
    common = {"max_instances": 1, "coalesce": True, "misfire_grace_time": 300}

    # Every 5 minutes; the job itself no-ops outside 09:00-16:30 WIB. Gating in
    # the job rather than the trigger keeps the window logic in one place.
    scheduler.add_job(
        poll_all,
        CronTrigger(minute="*/5", timezone=settings.app_timezone),
        id="poll_5m",
        name="5m poll (session-gated)",
        replace_existing=True,
        **common,
    )

    scheduler.add_job(
        refresh_hourly,
        CronTrigger(minute="2,32", timezone=settings.app_timezone),
        id="refresh_1h",
        name="1h refresh (session-gated)",
        replace_existing=True,
        **common,
    )

    # 16:30 WIB: past post-trading close plus the 10 minute feed delay.
    scheduler.add_job(
        close_of_day,
        CronTrigger(day_of_week="mon-fri", hour=16, minute=30, timezone=settings.app_timezone),
        id="close_of_day",
        name="Close of day settle",
        replace_existing=True,
        **common,
    )

    scheduler.add_job(
        nightly_daily,
        CronTrigger(hour=2, minute=0, timezone=settings.app_timezone),
        id="nightly_daily",
        name="Nightly daily refresh",
        replace_existing=True,
        **common,
    )

    scheduler.add_job(
        recalc_coverage,
        CronTrigger(hour=3, minute=0, timezone=settings.app_timezone),
        id="coverage_recalc",
        name="Coverage recalculation",
        replace_existing=True,
        **common,
    )

    return scheduler


def start_scheduler() -> AsyncIOScheduler:
    global _scheduler
    if _scheduler is not None and _scheduler.running:
        return _scheduler
    _scheduler = build_scheduler()
    _scheduler.start()
    for job in _scheduler.get_jobs():
        log.info("scheduler.job", id=job.id, next_run=str(job.next_run_time))
    return _scheduler


def shutdown_scheduler() -> None:
    global _scheduler
    if _scheduler is not None and _scheduler.running:
        _scheduler.shutdown(wait=False)
    _scheduler = None


def get_scheduler() -> AsyncIOScheduler | None:
    return _scheduler
