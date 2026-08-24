from datetime import UTC, datetime, timedelta

from app.domain.indicators import (
    adx,
    ai_signal,
    atr,
    compute_scorecard,
    correlation,
    daily_rvol,
    ema,
    ichimoku,
    macd,
    obv,
    returns,
    rsi,
    session_rvol,
    stochastic,
    support_resistance,
    volume_spike,
)


def _sample_bars(n: int = 100) -> list[dict]:
    base_ts = datetime(2026, 8, 1, 9, 0, tzinfo=UTC)
    bars = []
    price = 5000.0
    for i in range(n):
        price += (i % 5 - 2) * 25.0
        h = price + 50.0
        l = price - 50.0
        bars.append({
            "ts": base_ts + timedelta(days=i),
            "o": price - 10.0,
            "h": h,
            "l": l,
            "c": price,
            "v": 100000 + i * 1000,
            "final": True,
        })
    return bars


def test_ema_and_macd():
    closes = [10.0, 11.0, 12.0, 13.0, 14.0, 15.0, 16.0, 17.0, 18.0, 19.0, 20.0]
    res_ema = ema(closes, 5)
    assert len(res_ema) == len(closes)
    assert res_ema[-1] is not None
    assert res_ema[-1] < 20.0  # Lags behind linear ramp

    bars = _sample_bars(60)
    closes_60 = [b["c"] for b in bars]
    res_macd = macd(closes_60)
    assert len(res_macd["line"]) == 60
    assert len(res_macd["signal"]) == 60
    assert len(res_macd["hist"]) == 60


def test_rsi():
    closes = [100.0 + i for i in range(30)]
    r = rsi(closes, 14)
    assert len(r) == 30
    assert r[-1] is not None
    assert r[-1] > 90.0  # Steady uptrend -> overbought RSI


def test_ichimoku_and_sr():
    bars = _sample_bars(60)
    ichi = ichimoku(bars)
    assert len(ichi["tenkan"]) == 60
    assert len(ichi["kijun"]) == 60
    assert len(ichi["senkouA"]) == 60
    assert len(ichi["senkouB"]) == 60

    sr = support_resistance(bars, lookback=40)
    assert sr["support"] <= sr["resistance"]
    assert sr["support"] > 0


def test_atr_adx_stoch():
    bars = _sample_bars(60)
    atr_vals = atr(bars, 14)
    assert len(atr_vals) == 60
    assert atr_vals[-1] is not None

    adx_res = adx(bars, 14)
    assert len(adx_res["adx"]) == 60

    stoch_res = stochastic(bars, 14, 3)
    assert len(stoch_res["k"]) == 60
    assert len(stoch_res["d"]) == 60


def test_scorecard():
    bars = _sample_bars(60)
    closes = [b["c"] for b in bars]
    ichi = ichimoku(bars)
    macd_res = macd(closes)
    rsi_arr = rsi(closes)
    sr = support_resistance(bars)

    sig = ai_signal(bars, ichi, macd_res, rsi_arr, sr)
    assert sig["stance"] in ("bullish", "bearish", "neutral")
    assert isinstance(sig["reasons"], list)

    scorecard = compute_scorecard(bars, ichi, macd_res, rsi_arr, sr)
    assert len(scorecard["signals"]) == 10
    assert scorecard["overall"] in ("bullish", "bearish", "neutral")
    assert scorecard["bullish"] + scorecard["bearish"] + scorecard["neutral"] <= 10


def test_volume_metrics():
    bars = _sample_bars(30)
    rvol = daily_rvol(bars, 20)
    assert rvol is not None
    assert rvol["rvol"] > 0
    assert rvol["baseline_sessions"] == 20

    spike = volume_spike(bars, 20)
    assert spike is not None
    assert isinstance(spike["z_score"], float)


def test_correlation_and_returns():
    c1 = [10.0, 11.0, 12.0, 13.0, 14.0]
    c2 = [20.0, 22.0, 24.0, 26.0, 28.0]
    r1 = returns(c1)
    r2 = returns(c2)
    corr = correlation(r1, r2)
    assert round(corr, 2) == 1.0  # Perfect correlation
