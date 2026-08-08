"""IDX trading calendar: sessions, holidays, and the polling window.

Session layout below was verified against live 5m data from Yahoo (BBCA.JK,
2026-08-05..07):

    Mon-Thu   bars 09:00-11:55, gap, 13:30-15:45, then 16:00-16:10
    Fri       bars 09:00-11:25, gap, 14:00-15:45, then 16:00-16:10

So Session I closes at 12:00 Mon-Thu and 11:30 on Friday, Session II opens at
13:30 and 14:00 respectively, and the 16:00-16:15 bars are the pre-closing and
post-trading auctions. Yahoo omits the lunch break entirely rather than emitting
empty bars, which is why the resampler never has to filter nulls.
"""

from __future__ import annotations

import json
from datetime import date, datetime, time, timedelta
from functools import lru_cache
from pathlib import Path
from zoneinfo import ZoneInfo

WIB = ZoneInfo("Asia/Jakarta")
UTC = ZoneInfo("UTC")

#: All intraday buckets are anchored here rather than to the UTC epoch. This is
#: the fix for v1's 4h candles, which straddled the lunch break and the
#: overnight gap because pandas resampled from midnight UTC.
SESSION_ANCHOR = time(9, 0)

#: Yahoo reports the regular trading period as a continuous 09:00-16:15 block.
SESSION_CLOSE = time(16, 15)

#: A 15 minute tail past the close, so the last bars still land while the free
#: feed is running 10 minutes behind.
POLL_WINDOW_END = time(16, 30)

_SEGMENTS_MON_THU = ((time(9, 0), time(12, 0)), (time(13, 30), time(15, 50)))
_SEGMENTS_FRI = ((time(9, 0), time(11, 30)), (time(14, 0), time(15, 50)))
_AUCTION = (time(15, 50), time(16, 15))

_HOLIDAY_FILE = Path(__file__).resolve().parent.parent / "data" / "idx_holidays.json"


@lru_cache(maxsize=1)
def _static_holidays() -> frozenset[date]:
    if not _HOLIDAY_FILE.exists():
        return frozenset()
    raw = json.loads(_HOLIDAY_FILE.read_text())
    return frozenset(date.fromisoformat(d) for d in raw.get("dates", []))


def reload_static_holidays() -> None:
    _static_holidays.cache_clear()


def is_weekend(d: date) -> bool:
    return d.weekday() >= 5


def is_trading_day(d: date, extra_holidays: frozenset[date] | set[date] | None = None) -> bool:
    """Whether IDX trades on ``d``.

    A holiday missing from the calendar only costs a few wasted no-op polls, not
    correctness -- the ingest path is idempotent and a closed market simply
    returns no new bars.
    """
    if is_weekend(d):
        return False
    if d in _static_holidays():
        return False
    if extra_holidays and d in extra_holidays:
        return False
    return True


def session_segments(d: date) -> tuple[tuple[time, time], ...]:
    """Trading segments for ``d``, excluding the lunch break. Empty if closed."""
    if not is_trading_day(d):
        return ()
    base = _SEGMENTS_FRI if d.weekday() == 4 else _SEGMENTS_MON_THU
    return (*base, _AUCTION)


def to_wib(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        raise ValueError("naive datetime; all timestamps must be tz-aware")
    return dt.astimezone(WIB)


def to_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        raise ValueError("naive datetime; all timestamps must be tz-aware")
    return dt.astimezone(UTC)


def session_day(dt: datetime) -> date:
    """The WIB calendar date a timestamp belongs to."""
    return to_wib(dt).date()


def session_anchor(d: date) -> datetime:
    """09:00 WIB on ``d`` -- the origin every intraday bucket counts from."""
    return datetime.combine(d, SESSION_ANCHOR, tzinfo=WIB)


def is_poll_window_open(
    dt: datetime, extra_holidays: frozenset[date] | set[date] | None = None
) -> bool:
    local = to_wib(dt)
    if not is_trading_day(local.date(), extra_holidays):
        return False
    return SESSION_ANCHOR <= local.time() < POLL_WINDOW_END


def is_session_open(
    dt: datetime, extra_holidays: frozenset[date] | set[date] | None = None
) -> bool:
    """Whether the market itself is currently trading (lunch break excluded)."""
    local = to_wib(dt)
    if not is_trading_day(local.date(), extra_holidays):
        return False
    t = local.time()
    return any(start <= t < end for start, end in session_segments(local.date()))


def next_trading_day(d: date, extra_holidays: frozenset[date] | set[date] | None = None) -> date:
    nxt = d + timedelta(days=1)
    for _ in range(30):
        if is_trading_day(nxt, extra_holidays):
            return nxt
        nxt += timedelta(days=1)
    raise RuntimeError(f"no trading day found within 30 days of {d}")


def next_open(dt: datetime, extra_holidays: frozenset[date] | set[date] | None = None) -> datetime:
    local = to_wib(dt)
    if is_trading_day(local.date(), extra_holidays) and local.time() < SESSION_ANCHOR:
        return session_anchor(local.date())
    return session_anchor(next_trading_day(local.date(), extra_holidays))


def next_close(dt: datetime, extra_holidays: frozenset[date] | set[date] | None = None) -> datetime:
    local = to_wib(dt)
    if is_trading_day(local.date(), extra_holidays) and local.time() < SESSION_CLOSE:
        return datetime.combine(local.date(), SESSION_CLOSE, tzinfo=WIB)
    d = next_trading_day(local.date(), extra_holidays)
    return datetime.combine(d, SESSION_CLOSE, tzinfo=WIB)


def trading_days_between(start: date, end: date) -> list[date]:
    out: list[date] = []
    cur = start
    while cur <= end:
        if is_trading_day(cur):
            out.append(cur)
        cur += timedelta(days=1)
    return out
