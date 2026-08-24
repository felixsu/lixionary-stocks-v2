from app.domain.idx_ticks import is_on_tick, round_to_tick, tick_size


def test_tick_size_bands():
    assert tick_size(50) == 1
    assert tick_size(199) == 1
    assert tick_size(200) == 2
    assert tick_size(498) == 2
    assert tick_size(500) == 5
    assert tick_size(1995) == 5
    assert tick_size(2000) == 10
    assert tick_size(4990) == 10
    assert tick_size(5000) == 25
    assert tick_size(12500) == 25
    assert tick_size(0) == 1
    assert tick_size(-100) == 1


def test_round_to_tick():
    # Band < 200 (tick = 1)
    assert round_to_tick(75.4) == 75.0
    assert round_to_tick(75.6) == 76.0

    # Band 200-500 (tick = 2)
    assert round_to_tick(211.0, "nearest") == 212.0
    assert round_to_tick(211.0, "down") == 210.0
    assert round_to_tick(211.0, "up") == 212.0

    # Band 500-2000 (tick = 5)
    assert round_to_tick(743.0, "nearest") == 745.0
    assert round_to_tick(743.0, "down") == 740.0
    assert round_to_tick(743.0, "up") == 745.0

    # Band 2000-5000 (tick = 10)
    assert round_to_tick(3412.0, "nearest") == 3410.0
    assert round_to_tick(3416.0, "nearest") == 3420.0
    assert round_to_tick(3412.0, "down") == 3410.0
    assert round_to_tick(3412.0, "up") == 3420.0

    # Band >= 5000 (tick = 25)
    assert round_to_tick(6315.0, "nearest") == 6325.0
    assert round_to_tick(6315.0, "down") == 6300.0
    assert round_to_tick(6315.0, "up") == 6325.0


def test_is_on_tick():
    assert is_on_tick(75.0) is True
    assert is_on_tick(212.0) is True
    assert is_on_tick(211.0) is False
    assert is_on_tick(745.0) is True
    assert is_on_tick(742.0) is False
    assert is_on_tick(6325.0) is True
    assert is_on_tick(6310.0) is False
