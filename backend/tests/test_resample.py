"""Resampling tests built on the real IDX bar layout observed from Yahoo.

Mon-Thu: 5m bars run 09:00-11:55, then 13:30-15:45, then 16:00-16:10.
Fri:     5m bars run 09:00-11:25, then 14:00-15:45, then 16:00-16:10.
"""

from datetime import UTC, datetime, timedelta

import pytest

from app.domain.calendar import WIB
from app.domain.timeframes import Timeframe
from app.services.resample import bucket_start, resample

FAR_FUTURE = datetime(2027, 1, 1, tzinfo=UTC)


def wib(y, m, d, hh, mm=0):
    return datetime(y, m, d, hh, mm, tzinfo=WIB)


def bar(ts, o=100.0, h=110.0, low=90.0, c=105.0, v=1000, final=True):
    return {"ts": ts.astimezone(UTC), "o": o, "h": h, "l": low, "c": c, "v": v, "final": final}


def wednesday_5m_bars():
    """One full Mon-Thu session, matching Yahoo's actual output."""
    day = (2026, 8, 5)
    times = []
    t = wib(*day, 9, 0)
    while t <= wib(*day, 11, 55):
        times.append(t)
        t += timedelta(minutes=5)
    t = wib(*day, 13, 30)
    while t <= wib(*day, 15, 45):
        times.append(t)
        t += timedelta(minutes=5)
    times += [wib(*day, 16, 0), wib(*day, 16, 5), wib(*day, 16, 10)]
    return [bar(ts) for ts in times]


def local_times(bars):
    return [b["ts"].astimezone(WIB).strftime("%H:%M") for b in bars]


class TestBucketStart:
    def test_anchored_to_nine_am_not_utc_midnight(self):
        # 09:20 WIB in a 1h bucket must land on 09:00, not 09:00 UTC-aligned.
        got = bucket_start(wib(2026, 8, 5, 9, 20), timedelta(hours=1))
        assert got.astimezone(WIB) == wib(2026, 8, 5, 9, 0)

    def test_four_hour_buckets_split_at_session_open_and_one_pm(self):
        w = timedelta(hours=4)
        assert bucket_start(wib(2026, 8, 5, 9, 0), w).astimezone(WIB) == wib(2026, 8, 5, 9, 0)
        assert bucket_start(wib(2026, 8, 5, 12, 55), w).astimezone(WIB) == wib(2026, 8, 5, 9, 0)
        assert bucket_start(wib(2026, 8, 5, 13, 30), w).astimezone(WIB) == wib(2026, 8, 5, 13, 0)
        assert bucket_start(wib(2026, 8, 5, 16, 10), w).astimezone(WIB) == wib(2026, 8, 5, 13, 0)

    def test_two_hour_buckets(self):
        w = timedelta(hours=2)
        for t, expected in [
            ((9, 0), (9, 0)),
            ((10, 59), (9, 0)),
            ((11, 0), (11, 0)),
            ((13, 30), (13, 0)),
            ((15, 45), (15, 0)),
            ((16, 10), (15, 0)),
        ]:
            got = bucket_start(wib(2026, 8, 5, *t), w).astimezone(WIB)
            assert got == wib(2026, 8, 5, *expected), f"{t} -> {got}"


class TestNoCrossDayBuckets:
    def test_four_hour_never_merges_two_trading_days(self):
        bars = wednesday_5m_bars() + [bar(wib(2026, 8, 6, 9, 0)), bar(wib(2026, 8, 6, 9, 5))]
        out = resample(bars, Timeframe.M5, Timeframe.H4, now=FAR_FUTURE)
        days = {b["ts"].astimezone(WIB).date() for b in out}
        assert len(days) == 2
        # Wednesday contributes exactly two buckets; Thursday's early bars a third.
        assert len(out) == 3

    def test_overnight_gap_does_not_produce_a_bucket(self):
        bars = [bar(wib(2026, 8, 5, 16, 10)), bar(wib(2026, 8, 6, 9, 0))]
        out = resample(bars, Timeframe.M5, Timeframe.H4, now=FAR_FUTURE)
        assert len(out) == 2
        assert local_times(out) == ["13:00", "09:00"]


class TestLunchBreak:
    def test_no_bucket_lands_inside_the_lunch_gap(self):
        out = resample(wednesday_5m_bars(), Timeframe.M5, Timeframe.H1, now=FAR_FUTURE)
        # Session I ends 12:00 and Session II opens 13:30, so no 12:00 bucket exists.
        assert "12:00" not in local_times(out)

    def test_hourly_buckets_for_a_full_session(self):
        out = resample(wednesday_5m_bars(), Timeframe.M5, Timeframe.H1, now=FAR_FUTURE)
        assert local_times(out) == [
            "09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00",
        ]

    def test_friday_shorter_session_one(self):
        day = (2026, 8, 7)
        times = []
        t = wib(*day, 9, 0)
        while t <= wib(*day, 11, 25):
            times.append(t)
            t += timedelta(minutes=5)
        t = wib(*day, 14, 0)
        while t <= wib(*day, 15, 45):
            times.append(t)
            t += timedelta(minutes=5)
        out = resample([bar(ts) for ts in times], Timeframe.M5, Timeframe.H1, now=FAR_FUTURE)
        # Friday trades 09:00-11:30 then 14:00, so 12:00 and 13:00 are both absent.
        assert local_times(out) == ["09:00", "10:00", "11:00", "14:00", "15:00"]


class TestAggregation:
    def test_ohlcv_is_exact(self):
        bars = [
            bar(wib(2026, 8, 5, 9, 0), o=100, h=105, low=99, c=104, v=10),
            bar(wib(2026, 8, 5, 9, 5), o=104, h=112, low=103, c=108, v=20),
            bar(wib(2026, 8, 5, 9, 10), o=108, h=109, low=95, c=97, v=30),
        ]
        out = resample(bars, Timeframe.M5, Timeframe.M15, now=FAR_FUTURE)
        assert len(out) == 1
        b = out[0]
        assert b["o"] == 100  # first
        assert b["h"] == 112  # max
        assert b["l"] == 95   # min
        assert b["c"] == 97   # last
        assert b["v"] == 60   # sum

    def test_fifteen_minute_buckets_group_in_threes(self):
        out = resample(wednesday_5m_bars(), Timeframe.M5, Timeframe.M15, now=FAR_FUTURE)
        assert local_times(out)[:4] == ["09:00", "09:15", "09:30", "09:45"]

    def test_null_volume_stays_null(self):
        # Index intraday bars carry no volume; summing must not invent a zero.
        bars = [
            bar(wib(2026, 8, 5, 9, 0), v=None),
            bar(wib(2026, 8, 5, 9, 5), v=None),
        ]
        out = resample(bars, Timeframe.M5, Timeframe.M15, now=FAR_FUTURE)
        assert out[0]["v"] is None

    def test_bars_are_returned_in_ascending_order(self):
        bars = list(reversed(wednesday_5m_bars()))
        out = resample(bars, Timeframe.M5, Timeframe.H1, now=FAR_FUTURE)
        assert out == sorted(out, key=lambda b: b["ts"])


class TestFinality:
    def test_bucket_not_final_while_still_forming(self):
        # Only the first of three 5m bars exists; the 15m bucket is incomplete.
        now = wib(2026, 8, 5, 9, 6)
        out = resample(
            [bar(wib(2026, 8, 5, 9, 0), final=True)],
            Timeframe.M5,
            Timeframe.M15,
            now=now,
        )
        assert out[0]["final"] is False

    def test_bucket_final_once_closed_and_all_sources_final(self):
        out = resample(wednesday_5m_bars(), Timeframe.M5, Timeframe.M15, now=FAR_FUTURE)
        assert all(b["final"] for b in out)

    def test_non_final_source_bar_taints_the_bucket(self):
        bars = [
            bar(wib(2026, 8, 5, 9, 0), final=True),
            bar(wib(2026, 8, 5, 9, 5), final=False),
            bar(wib(2026, 8, 5, 9, 10), final=True),
        ]
        out = resample(bars, Timeframe.M5, Timeframe.M15, now=FAR_FUTURE)
        assert out[0]["final"] is False


class TestGuards:
    def test_identity_resample_returns_sorted_input(self):
        bars = wednesday_5m_bars()
        assert resample(bars, Timeframe.M5, Timeframe.M5, now=FAR_FUTURE) == bars

    def test_cannot_downsample(self):
        with pytest.raises(ValueError, match="narrower"):
            resample([], Timeframe.H1, Timeframe.M5, now=FAR_FUTURE)

    def test_daily_is_not_an_intraday_source_or_target(self):
        with pytest.raises(ValueError, match="daily"):
            resample([], Timeframe.M5, Timeframe.D1, now=FAR_FUTURE)
        with pytest.raises(ValueError, match="daily"):
            resample([], Timeframe.D1, Timeframe.H1, now=FAR_FUTURE)


class TestSourceEquivalence:
    def test_four_hour_matches_whether_built_from_5m_or_1h(self):
        five = wednesday_5m_bars()
        one_hour = resample(five, Timeframe.M5, Timeframe.H1, now=FAR_FUTURE)
        via_5m = resample(five, Timeframe.M5, Timeframe.H4, now=FAR_FUTURE)
        via_1h = resample(one_hour, Timeframe.H1, Timeframe.H4, now=FAR_FUTURE)
        assert [b["ts"] for b in via_5m] == [b["ts"] for b in via_1h]
        for a, b in zip(via_5m, via_1h, strict=True):
            assert (a["o"], a["h"], a["l"], a["c"], a["v"]) == (
                b["o"], b["h"], b["l"], b["c"], b["v"],
            )
