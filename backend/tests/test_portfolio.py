"""Enrichment math for portfolio positions (pure part of the service)."""

import pytest
from pydantic import ValidationError

from app.api.portfolio import CashIn, PositionIn, router
from app.services.portfolio import SHARES_PER_LOT, _enrich


def make_doc(lots=10, avg=6300.0):
    return {"symbol": "BBCA", "lots": lots, "avg_price": avg, "recommendation": None}


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
