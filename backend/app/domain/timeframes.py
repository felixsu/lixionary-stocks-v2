"""Timeframe vocabulary and the base -> derived relationships between them.

Only three timeframes are ever fetched from Yahoo and stored (see BASE_TIMEFRAMES).
Everything else is resampled on read, so derived data can never drift from its
source and changing the bucketing rules needs no backfill.
"""

from __future__ import annotations

from datetime import timedelta
from enum import StrEnum


class Timeframe(StrEnum):
    M5 = "5m"
    M15 = "15m"
    M30 = "30m"
    H1 = "1h"
    H2 = "2h"
    H4 = "4h"
    D1 = "1d"


#: The only timeframes fetched from Yahoo and written to the ``candles`` collection.
BASE_TIMEFRAMES: tuple[Timeframe, ...] = (Timeframe.M5, Timeframe.H1, Timeframe.D1)

#: Bar width. 1d is a marker value; daily bars are bounded by the session, not a
#: fixed duration, so it is never used for arithmetic bucketing.
DURATIONS: dict[Timeframe, timedelta] = {
    Timeframe.M5: timedelta(minutes=5),
    Timeframe.M15: timedelta(minutes=15),
    Timeframe.M30: timedelta(minutes=30),
    Timeframe.H1: timedelta(hours=1),
    Timeframe.H2: timedelta(hours=2),
    Timeframe.H4: timedelta(hours=4),
    Timeframe.D1: timedelta(days=1),
}

INTRADAY: frozenset[Timeframe] = frozenset(
    {Timeframe.M5, Timeframe.M15, Timeframe.M30, Timeframe.H1, Timeframe.H2, Timeframe.H4}
)

#: How far back Yahoo will serve each base timeframe. Verified against the live
#: API: 5m rejects range=3mo with HTTP 422; 1h serves 2y (2880 bars); 1d is
#: unbounded. Anything older than the 5m window is unrecoverable, which is why
#: the store accumulates its own history rather than refetching.
YAHOO_MAX_LOOKBACK_DAYS: dict[Timeframe, int | None] = {
    Timeframe.M5: 60,
    Timeframe.H1: 730,
    Timeframe.D1: None,
}


def is_base(tf: Timeframe) -> bool:
    return tf in BASE_TIMEFRAMES


def allowed_sources(target: Timeframe) -> tuple[Timeframe, ...]:
    """Base timeframes that can produce ``target``, finest first.

    A base qualifies when its width divides the target's evenly, so every derived
    bar is built from a whole number of source bars.

    Daily is deliberately *not* derivable from intraday bars: Yahoo's 1d bar
    reflects the closing auction and carries split/dividend adjustment, neither of
    which can be reconstructed by summing 5m bars.
    """
    if target is Timeframe.D1:
        return (Timeframe.D1,)

    out: list[Timeframe] = []
    target_width = DURATIONS[target]
    for base in BASE_TIMEFRAMES:
        if base is Timeframe.D1:
            continue
        base_width = DURATIONS[base]
        if base_width <= target_width and target_width % base_width == timedelta(0):
            out.append(base)
    return tuple(out)


def parse(value: str) -> Timeframe:
    try:
        return Timeframe(value)
    except ValueError as exc:
        raise ValueError(
            f"unknown timeframe {value!r}; expected one of {[t.value for t in Timeframe]}"
        ) from exc
