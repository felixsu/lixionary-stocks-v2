"""Enrichment math for portfolio positions (pure part of the service)."""

from datetime import datetime

import pytest
from pydantic import ValidationError

from app.api.portfolio import CashIn, PositionIn, router
from app.domain.calendar import WIB
from app.services.portfolio import SHARES_PER_LOT, _enrich, _pick_quote


def make_doc(lots=10, avg=6300.0):
    return {"symbol": "BBCA", "lots": lots, "avg_price": avg, "recommendation": None}


def daily_bar(day: str, close: float):
    """A stored 1d bar, stamped at WIB midnight of its session day."""
    return {"ts": datetime.fromisoformat(f"{day}T00:00").replace(tzinfo=WIB), "c": close}


def intraday_bar(day: str, hhmm: str, close: float):
    return {"ts": datetime.fromisoformat(f"{day}T{hhmm}").replace(tzinfo=WIB), "c": close}


class TestEnrich:
    def test_priced_position(self):
        p = _enrich(make_doc(lots=10, avg=6300), last=6375.0, prev=6350.0)
        assert p["shares"] == 10 * SHARES_PER_LOT
        assert p["cost"] == 10 * 100 * 6300  # 6,300,000
        assert p["market_value"] == 10 * 100 * 6375
        assert p["pnl"] == 10 * 100 * (6375 - 6300)  # 75,000
        assert abs(p["pnl_pct"] - (75 / 6300 * 100)) < 1e-9
        assert abs(p["day_change_pct"] - ((6375 - 6350) / 6350 * 100)) < 1e-9

    def test_unpriced_position_is_null_not_crash(self):
        p = _enrich(make_doc(), last=None, prev=None)
        assert p["cost"] == 6_300_000
        assert p["market_value"] is None
        assert p["pnl"] is None
        assert p["pnl_pct"] is None
        assert p["day_change_pct"] is None

    def test_missing_prev_close_only_disables_day_change(self):
        p = _enrich(make_doc(), last=6375.0, prev=None)
        assert p["market_value"] is not None
        assert p["day_change_pct"] is None

    def test_losing_position_negative_pnl(self):
        p = _enrich(make_doc(lots=5, avg=7000), last=6000.0, prev=None)
        assert p["pnl"] == 5 * 100 * (6000 - 7000)  # -500,000
        assert p["pnl_pct"] < 0


class TestPositionInBounds:
    def test_plausible_price_ok(self):
        assert PositionIn(lots=10, avg_price=710).avg_price == 710

    def test_absurd_price_rejected(self):
        # The "710.00 parsed as 71000 then costed ×100" class of accident.
        with pytest.raises(ValidationError):
            PositionIn(lots=10, avg_price=71_000_000)

    def test_zero_price_rejected(self):
        with pytest.raises(ValidationError):
            PositionIn(lots=10, avg_price=0)

    def test_zero_lots_rejected(self):
        with pytest.raises(ValidationError):
            PositionIn(lots=0, avg_price=710)


class TestCashIn:
    def test_zero_clears(self):
        assert CashIn(amount=0).amount == 0

    def test_negative_rejected(self):
        with pytest.raises(ValidationError):
            CashIn(amount=-1)


class TestRouteOrder:
    def test_cash_route_registered_before_symbol_capture(self):
        paths = [r.path for r in router.routes]
        assert paths.index("/api/portfolio/cash") < paths.index("/api/portfolio/{symbol}")


class TestPickQuote:
    """The 1d series is a day stale between 09:00 and 16:30 WIB; 5m covers it."""

    def test_intraday_wins_when_daily_has_not_caught_up(self):
        # Mid-session on the 21st: the newest 1d bar is still the 20th's.
        q = _pick_quote(
            [daily_bar("2026-08-20", 745.0), daily_bar("2026-08-19", 725.0)],
            intraday_bar("2026-08-21", "10:20", 780.0),
        )
        assert q.last == 780.0
        assert q.prev == 745.0  # the 20th's close is the day-change baseline
        assert q.intraday is True
        assert q.as_of.astimezone(WIB).hour == 10

    def test_daily_wins_once_it_covers_the_same_session_day(self):
        # After close_of_day settled the 21st, the 5m bar adds nothing.
        q = _pick_quote(
            [daily_bar("2026-08-21", 775.0), daily_bar("2026-08-20", 745.0)],
            intraday_bar("2026-08-21", "16:10", 780.0),
        )
        assert q.last == 775.0
        assert q.prev == 745.0
        assert q.intraday is False

    def test_stale_intraday_never_overrides_a_settled_daily(self):
        # A suspended symbol whose 5m stopped days ago must not be marked at it.
        q = _pick_quote(
            [daily_bar("2026-08-21", 775.0), daily_bar("2026-08-20", 745.0)],
            intraday_bar("2026-08-18", "15:45", 700.0),
        )
        assert q.last == 775.0
        assert q.intraday is False

    def test_intraday_only_has_no_day_change_baseline(self):
        q = _pick_quote([], intraday_bar("2026-08-21", "10:20", 780.0))
        assert q.last == 780.0
        assert q.prev is None
        assert q.intraday is True

    def test_daily_only_is_unchanged_behaviour(self):
        q = _pick_quote([daily_bar("2026-08-20", 745.0), daily_bar("2026-08-19", 725.0)], None)
        assert (q.last, q.prev, q.intraday) == (745.0, 725.0, False)

    def test_no_bars_at_all(self):
        q = _pick_quote([], None)
        assert (q.last, q.prev, q.as_of, q.intraday) == (None, None, None, False)

    def test_single_daily_bar_has_no_prev(self):
        q = _pick_quote([daily_bar("2026-08-20", 745.0)], None)
        assert q.last == 745.0
        assert q.prev is None


class TestEnrichPriceProvenance:
    def test_intraday_mark_is_flagged(self):
        ts = intraday_bar("2026-08-21", "10:20", 780.0)["ts"]
        p = _enrich(make_doc(), last=780.0, prev=745.0, as_of=ts, intraday=True)
        assert p["price_is_intraday"] is True
        assert p["price_as_of"] == ts

    def test_defaults_stay_daily(self):
        p = _enrich(make_doc(), last=6375.0, prev=6350.0)
        assert p["price_is_intraday"] is False
        assert p["price_as_of"] is None
