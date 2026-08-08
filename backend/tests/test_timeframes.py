import pytest

from app.domain.timeframes import (
    BASE_TIMEFRAMES,
    Timeframe,
    allowed_sources,
    is_base,
    parse,
)


def test_base_timeframes_are_the_fetched_three():
    assert BASE_TIMEFRAMES == (Timeframe.M5, Timeframe.H1, Timeframe.D1)
    assert is_base(Timeframe.M5)
    assert not is_base(Timeframe.M15)


@pytest.mark.parametrize(
    ("target", "expected"),
    [
        (Timeframe.M5, (Timeframe.M5,)),
        (Timeframe.M15, (Timeframe.M5,)),
        (Timeframe.M30, (Timeframe.M5,)),
        (Timeframe.H1, (Timeframe.M5, Timeframe.H1)),
        (Timeframe.H2, (Timeframe.M5, Timeframe.H1)),
        (Timeframe.H4, (Timeframe.M5, Timeframe.H1)),
    ],
)
def test_allowed_sources_ordered_finest_first(target, expected):
    assert allowed_sources(target) == expected


def test_daily_is_never_derived_from_intraday():
    # Yahoo's 1d bar carries the closing auction and split/dividend adjustment,
    # neither reconstructable by summing 5m bars.
    assert allowed_sources(Timeframe.D1) == (Timeframe.D1,)


def test_parse_rejects_unknown():
    assert parse("15m") is Timeframe.M15
    with pytest.raises(ValueError, match="unknown timeframe"):
        parse("3m")
