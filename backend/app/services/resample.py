"""Session-aligned resampling of base bars into wider timeframes.

Every intraday bucket is anchored to 09:00 WIB and never spans a trading day.
This is the fix for v1, which resampled with pandas' default origin (midnight
UTC) and produced 4h candles that straddled both the lunch break and the
overnight gap.

Bucket layout that falls out of a 09:00 anchor:

    15m  09:00 09:15 09:30 ...
    30m  09:00 09:30 10:00 ...
    1h   09:00 10:00 11:00 ... 16:00
    2h   09:00 11:00 13:00 15:00
    4h   09:00 13:00

Yahoo omits the lunch break entirely rather than emitting empty bars, so buckets
that would fall inside it simply never materialise.

These functions are pure: no database, no clock beyond the ``now`` passed in.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import UTC, datetime, timedelta
from typing import Any

from app.domain.calendar import session_anchor, session_day
from app.domain.timeframes import DURATIONS, Timeframe

Candle = dict[str, Any]

#: A derived bucket is only final once its own close is this far behind wall
#: clock, even if every source bar inside it is already final -- otherwise a
#: half-filled bucket would be published as complete.
FINALITY_MARGIN = timedelta(minutes=15)


def bucket_start(ts: datetime, width: timedelta) -> datetime:
    """The 09:00-WIB-anchored bucket that ``ts`` belongs to, returned in UTC."""
    day = session_day(ts)
    anchor = session_anchor(day)
    offset = ts.astimezone(anchor.tzinfo) - anchor
    index = offset // width
    return (anchor + index * width).astimezone(UTC)


def resample(
    bars: Iterable[Candle],
    source: Timeframe,
    target: Timeframe,
    *,
    now: datetime | None = None,
) -> list[Candle]:
    """Aggregate ``bars`` from ``source`` width up to ``target`` width."""
    if source is target:
        return sorted(bars, key=lambda b: b["ts"])
    if target is Timeframe.D1 or source is Timeframe.D1:
        raise ValueError("daily bars are neither derived from nor a source for intraday")

    width = DURATIONS[target]
    if width <= DURATIONS[source]:
        raise ValueError(f"cannot resample {source} up to the narrower {target}")

    now = now or datetime.now(UTC)
    cutoff = now - FINALITY_MARGIN

    grouped: dict[datetime, list[Candle]] = {}
    for bar in sorted(bars, key=lambda b: b["ts"]):
        grouped.setdefault(bucket_start(bar["ts"], width), []).append(bar)

    out: list[Candle] = []
    for start, members in sorted(grouped.items()):
        volumes = [m["v"] for m in members if m.get("v") is not None]
        out.append(
            {
                "ts": start,
                "o": members[0]["o"],
                "h": max(m["h"] for m in members),
                "l": min(m["l"] for m in members),
                "c": members[-1]["c"],
                "v": sum(volumes) if volumes else None,
                "final": all(m.get("final", False) for m in members)
                and (start + width) <= cutoff,
            }
        )
    return out
