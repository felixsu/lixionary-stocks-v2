from datetime import UTC, datetime, timedelta

from app.core.config import settings
from app.domain.timeframes import Timeframe
from app.services.backfill import BOUNDARY_SAFETY_DAYS, backfill_window


def _span_days(window: dict) -> float:
    return (window["end"] - window["start"]).total_seconds() / 86400


class TestBackfillWindow:
    def test_intraday_windows_stay_inside_yahoos_cap(self):
        """Regression: requesting exactly N days races Yahoo's boundary check.

        A 730-day 1h request failed live with "The requested range must be
        within the last 730 days" while identical requests moments earlier
        succeeded, because Yahoo measures the cap against its own clock at
        request time.
        """
        for tf, cap in (
            (Timeframe.M5, settings.backfill_5m_days),
            (Timeframe.H1, settings.backfill_1h_days),
        ):
            span = _span_days(backfill_window(tf))
            assert span < cap, f"{tf} requests {span}d against a {cap}d cap"
            assert span == cap - BOUNDARY_SAFETY_DAYS

    def test_daily_uses_period_not_a_date_range(self):
        # Daily history is uncapped, so 'max' is both simpler and deeper than
        # any range we could compute.
        window = backfill_window(Timeframe.D1)
        assert window == {"period": settings.backfill_1d_period}
        assert "start" not in window

    def test_windows_end_at_now(self):
        before = datetime.now(UTC)
        window = backfill_window(Timeframe.M5)
        assert before <= window["end"] <= datetime.now(UTC) + timedelta(seconds=1)
