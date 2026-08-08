from datetime import date, datetime, time
from zoneinfo import ZoneInfo

from app.domain.calendar import (
    WIB,
    is_poll_window_open,
    is_session_open,
    is_trading_day,
    next_open,
    next_trading_day,
    session_anchor,
    session_day,
    session_segments,
    to_utc,
)


def wib(y, m, d, hh=0, mm=0):
    return datetime(y, m, d, hh, mm, tzinfo=WIB)


class TestTradingDay:
    def test_weekday_is_trading_day(self):
        assert is_trading_day(date(2026, 8, 5))  # Wednesday

    def test_weekend_is_not(self):
        assert not is_trading_day(date(2026, 8, 8))  # Saturday
        assert not is_trading_day(date(2026, 8, 9))  # Sunday

    def test_known_holiday_from_calendar_file(self):
        # 2026-03-19 is in the observed holiday set (Idul Fitri period).
        assert not is_trading_day(date(2026, 3, 19))

    def test_new_year_is_holiday(self):
        assert not is_trading_day(date(2026, 1, 1))

    def test_extra_holidays_override(self):
        d = date(2026, 8, 5)
        assert is_trading_day(d)
        assert not is_trading_day(d, extra_holidays={d})


class TestSessionSegments:
    def test_mon_thu_has_session_one_until_noon(self):
        segs = session_segments(date(2026, 8, 5))  # Wednesday
        assert segs[0] == (time(9, 0), time(12, 0))
        assert segs[1] == (time(13, 30), time(15, 50))

    def test_friday_session_one_ends_earlier(self):
        segs = session_segments(date(2026, 8, 7))  # Friday
        assert segs[0] == (time(9, 0), time(11, 30))
        assert segs[1] == (time(14, 0), time(15, 50))

    def test_closed_day_has_no_segments(self):
        assert session_segments(date(2026, 8, 8)) == ()


class TestSessionOpen:
    def test_open_during_session_one(self):
        assert is_session_open(wib(2026, 8, 5, 10, 0))

    def test_closed_during_lunch_break(self):
        assert not is_session_open(wib(2026, 8, 5, 12, 30))

    def test_friday_lunch_break_starts_earlier(self):
        # 11:45 is still Session I on Wednesday but already lunch on Friday.
        assert is_session_open(wib(2026, 8, 5, 11, 45))
        assert not is_session_open(wib(2026, 8, 7, 11, 45))

    def test_open_during_auction(self):
        assert is_session_open(wib(2026, 8, 5, 16, 0))

    def test_closed_before_open_and_after_close(self):
        assert not is_session_open(wib(2026, 8, 5, 8, 59))
        assert not is_session_open(wib(2026, 8, 5, 16, 20))


class TestPollWindow:
    def test_boundaries(self):
        assert not is_poll_window_open(wib(2026, 8, 5, 8, 59))
        assert is_poll_window_open(wib(2026, 8, 5, 9, 0))
        assert is_poll_window_open(wib(2026, 8, 5, 16, 29))
        assert not is_poll_window_open(wib(2026, 8, 5, 16, 30))

    def test_poll_window_spans_lunch(self):
        # The market is shut but the delayed feed is still catching up, so we
        # keep polling straight through the break.
        assert not is_session_open(wib(2026, 8, 5, 12, 30))
        assert is_poll_window_open(wib(2026, 8, 5, 12, 30))

    def test_closed_on_weekend_and_holiday(self):
        assert not is_poll_window_open(wib(2026, 8, 8, 10, 0))
        assert not is_poll_window_open(wib(2026, 3, 19, 10, 0))

    def test_accepts_utc_input(self):
        # 03:00 UTC == 10:00 WIB, inside the window.
        assert is_poll_window_open(to_utc(wib(2026, 8, 5, 10, 0)))


class TestNavigation:
    def test_next_trading_day_skips_weekend(self):
        assert next_trading_day(date(2026, 8, 7)) == date(2026, 8, 10)

    def test_next_trading_day_skips_holiday_run(self):
        # 2026-03-18..20 and 03-23..24 are all closed; 03-17 -> 03-25.
        assert next_trading_day(date(2026, 3, 17)) == date(2026, 3, 25)

    def test_next_open_same_day_before_bell(self):
        assert next_open(wib(2026, 8, 5, 7, 0)) == session_anchor(date(2026, 8, 5))

    def test_next_open_rolls_forward_after_close(self):
        assert next_open(wib(2026, 8, 7, 17, 0)) == session_anchor(date(2026, 8, 10))


class TestSessionDay:
    def test_utc_evening_maps_to_next_wib_day(self):
        # 2026-08-04 18:00 UTC is 2026-08-05 01:00 WIB.
        utc_evening = datetime(2026, 8, 4, 18, 0, tzinfo=ZoneInfo("UTC"))
        assert session_day(utc_evening) == date(2026, 8, 5)

    def test_anchor_is_nine_am_wib(self):
        a = session_anchor(date(2026, 8, 5))
        assert a.hour == 9 and a.minute == 0
        assert a.tzinfo is WIB
