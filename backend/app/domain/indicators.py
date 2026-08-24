"""Technical indicators and signal scorecards for IDX equities.

Pure functions matching the math in the frontend's indicators.ts, signals.ts,
and volume.ts.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from datetime import datetime
from typing import Any, Literal
from zoneinfo import ZoneInfo

WIB = ZoneInfo("Asia/Jakarta")


def ema(values: Sequence[float | None], period: int) -> list[float | None]:
    k = 2.0 / (period + 1)
    out: list[float | None] = [None] * len(values)
    prev: float | None = None
    for i, v in enumerate(values):
        if v is None:
            continue
        prev = v if prev is None else v * k + prev * (1 - k)
        out[i] = prev
    return out


def macd(closes: Sequence[float]) -> dict[str, list[float | None]]:
    e12 = ema(closes, 12)
    e26 = ema(closes, 26)
    line: list[float | None] = [
        (e12[i] - e26[i]) if (e12[i] is not None and e26[i] is not None) else None
        for i in range(len(closes))
    ]
    signal = ema(line, 9)
    hist: list[float | None] = [
        (line[i] - signal[i]) if (line[i] is not None and signal[i] is not None) else None
        for i in range(len(closes))
    ]
    return {"line": line, "signal": signal, "hist": hist}


def rsi(closes: Sequence[float], period: int = 14) -> list[float | None]:
    n = len(closes)
    out: list[float | None] = [None] * n
    if n <= period:
        return out

    gain = 0.0
    loss = 0.0
    for i in range(1, n):
        change = closes[i] - closes[i - 1]
        g = max(change, 0.0)
        l = max(-change, 0.0)
        if i <= period:
            gain += g
            loss += l
            if i == period:
                rs = (gain / period) / (loss / period or 1e-9)
                out[i] = 100.0 - 100.0 / (1.0 + rs)
        else:
            gain = (gain * (period - 1) + g) / period
            loss = (loss * (period - 1) + l) / period
            rs = gain / (loss or 1e-9)
            out[i] = 100.0 - 100.0 / (1.0 + rs)
    return out


def _rolling_extreme(
    bars: Sequence[dict[str, Any]], period: int, mode: Literal["max", "min"], idx: int
) -> float:
    start = max(0, idx - period + 1)
    if mode == "max":
        return max(bars[i]["h"] for i in range(start, idx + 1))
    return min(bars[i]["l"] for i in range(start, idx + 1))


def ichimoku(bars: Sequence[dict[str, Any]]) -> dict[str, list[float]]:
    tenkan: list[float] = []
    kijun: list[float] = []
    senkou_a: list[float] = []
    senkou_b: list[float] = []
    for i in range(len(bars)):
        t = (_rolling_extreme(bars, 9, "max", i) + _rolling_extreme(bars, 9, "min", i)) / 2.0
        k = (_rolling_extreme(bars, 26, "max", i) + _rolling_extreme(bars, 26, "min", i)) / 2.0
        tenkan.append(t)
        kijun.append(k)
        senkou_a.append((t + k) / 2.0)
        senkou_b.append(
            (_rolling_extreme(bars, 52, "max", i) + _rolling_extreme(bars, 52, "min", i)) / 2.0
        )
    return {"tenkan": tenkan, "kijun": kijun, "senkouA": senkou_a, "senkouB": senkou_b}


def support_resistance(bars: Sequence[dict[str, Any]], lookback: int = 40) -> dict[str, float]:
    if not bars:
        return {"support": 0.0, "resistance": 0.0}
    slice_bars = bars[-lookback:-3] if len(bars) >= 4 else bars
    if not slice_bars:
        slice_bars = bars
    return {
        "support": min(b["l"] for b in slice_bars),
        "resistance": max(b["h"] for b in slice_bars),
    }


def atr(bars: Sequence[dict[str, Any]], period: int = 14) -> list[float | None]:
    n = len(bars)
    out: list[float | None] = [None] * n
    if n < period + 1:
        return out

    acc = 0.0
    smoothed: float | None = None
    for i in range(1, n):
        cur = bars[i]
        prev = bars[i - 1]
        tr = max(cur["h"] - cur["l"], abs(cur["h"] - prev["c"]), abs(cur["l"] - prev["c"]))
        if i <= period:
            acc += tr
            if i == period:
                smoothed = acc / period
                out[i] = smoothed
            continue
        if smoothed is not None:
            smoothed = (smoothed * (period - 1) + tr) / period
            out[i] = smoothed
    return out


def adx(bars: Sequence[dict[str, Any]], period: int = 14) -> dict[str, list[float | None]]:
    n = len(bars)
    adx_arr: list[float | None] = [None] * n
    plus_di: list[float | None] = [None] * n
    minus_di: list[float | None] = [None] * n
    if n < period * 2 + 1:
        return {"adx": adx_arr, "plusDi": plus_di, "minusDi": minus_di}

    sm_tr = 0.0
    sm_plus = 0.0
    sm_minus = 0.0
    adx_acc: float | None = None

    for i in range(1, n):
        cur = bars[i]
        prev = bars[i - 1]
        tr = max(cur["h"] - cur["l"], abs(cur["h"] - prev["c"]), abs(cur["l"] - prev["c"]))
        up_move = cur["h"] - prev["h"]
        down_move = prev["l"] - cur["l"]
        plus_dm = up_move if (up_move > down_move and up_move > 0) else 0.0
        minus_dm = down_move if (down_move > up_move and down_move > 0) else 0.0

        if i <= period:
            sm_tr += tr
            sm_plus += plus_dm
            sm_minus += minus_dm
            if i < period:
                continue
        else:
            sm_tr = sm_tr - sm_tr / period + tr
            sm_plus = sm_plus - sm_plus / period + plus_dm
            sm_minus = sm_minus - sm_minus / period + minus_dm

        pdi = (sm_plus / sm_tr * 100.0) if sm_tr else 0.0
        mdi = (sm_minus / sm_tr * 100.0) if sm_tr else 0.0
        plus_di[i] = pdi
        minus_di[i] = mdi
        dx = (abs(pdi - mdi) / (pdi + mdi) * 100.0) if (pdi + mdi) else 0.0

        if i < period * 2:
            adx_acc = dx if adx_acc is None else adx_acc + dx
            if i == period * 2 - 1 and adx_acc is not None:
                adx_acc = adx_acc / period
                adx_arr[i] = adx_acc
        elif adx_acc is not None:
            adx_acc = (adx_acc * (period - 1) + dx) / period
            adx_arr[i] = adx_acc

    return {"adx": adx_arr, "plusDi": plus_di, "minusDi": minus_di}


def stochastic(
    bars: Sequence[dict[str, Any]], k_period: int = 14, d_period: int = 3
) -> dict[str, list[float | None]]:
    n = len(bars)
    k: list[float | None] = [None] * n
    for i in range(k_period - 1, n):
        hi = _rolling_extreme(bars, k_period, "max", i)
        lo = _rolling_extreme(bars, k_period, "min", i)
        k[i] = 50.0 if hi == lo else ((bars[i]["c"] - lo) / (hi - lo)) * 100.0

    d: list[float | None] = [None] * n
    for i in range(n):
        window = [v for v in k[max(0, i - d_period + 1) : i + 1] if v is not None]
        if len(window) == d_period:
            d[i] = sum(window) / d_period

    return {"k": k, "d": d}


def obv(bars: Sequence[dict[str, Any]]) -> list[float] | None:
    if not bars or any(b.get("v") is None for b in bars):
        return None
    out = [0.0] * len(bars)
    for i in range(1, len(bars)):
        c_cur = bars[i]["c"]
        c_prev = bars[i - 1]["c"]
        direction = 1 if c_cur > c_prev else -1 if c_cur < c_prev else 0
        out[i] = out[i - 1] + direction * (bars[i]["v"] or 0)
    return out


def returns(closes: Sequence[float]) -> list[float]:
    out: list[float] = []
    for i in range(1, len(closes)):
        if closes[i - 1] != 0:
            out.append((closes[i] - closes[i - 1]) / closes[i - 1])
        else:
            out.append(0.0)
    return out


def correlation(a: Sequence[float], b: Sequence[float]) -> float:
    n = min(len(a), len(b))
    if n < 2:
        return 0.0
    ax = list(a[-n:])
    bx = list(b[-n:])
    ma = sum(ax) / n
    mb = sum(bx) / n
    num = 0.0
    da = 0.0
    db = 0.0
    for i in range(n):
        x = ax[i] - ma
        y = bx[i] - mb
        num += x * y
        da += x * x
        db += y * y
    return (num / math.sqrt(da * db)) if (da and db) else 0.0


def ai_signal(
    bars: Sequence[dict[str, Any]],
    ichi: dict[str, list[float]],
    macd_res: dict[str, list[float | None]],
    rsi_arr: list[float | None],
    sr: dict[str, float],
) -> dict[str, Any]:
    i = len(bars) - 1
    price = bars[i]["c"]
    reasons: list[str] = []
    score = 0

    cloud_top = max(ichi["senkouA"][i], ichi["senkouB"][i])
    cloud_bottom = min(ichi["senkouA"][i], ichi["senkouB"][i])

    if price > cloud_top:
        score += 1
        reasons.append("Price is trading above the Ichimoku cloud, a bullish trend signal.")
    elif price < cloud_bottom:
        score -= 1
        reasons.append("Price is trading below the Ichimoku cloud, a bearish trend signal.")
    else:
        reasons.append("Price is inside the Ichimoku cloud, indicating a consolidating trend.")

    line = macd_res["line"][i]
    sig = macd_res["signal"][i]
    if line is not None and sig is not None:
        if line > sig:
            score += 1
            reasons.append("MACD line is above the signal line, supporting upward momentum.")
        else:
            score -= 1
            reasons.append("MACD line is below the signal line, suggesting fading momentum.")

    r = rsi_arr[i]
    if r is not None:
        if r >= 70:
            score -= 1
            reasons.append(f"RSI at {r:.0f} is in overbought territory.")
        elif r <= 30:
            score += 1
            reasons.append(f"RSI at {r:.0f} is in oversold territory, room to rebound.")
        else:
            reasons.append(f"RSI at {r:.0f} sits in neutral range.")

    if price >= sr["resistance"] * 0.995:
        reasons.append("Price is testing recent resistance — a breakout would confirm strength.")
    elif price <= sr["support"] * 1.005:
        reasons.append("Price is testing recent support — a breakdown would signal further weakness.")

    stance: Literal["bullish", "bearish", "neutral"] = (
        "bullish" if score >= 1 else "bearish" if score <= -1 else "neutral"
    )
    return {"stance": stance, "reasons": reasons[:3]}


def compute_scorecard(
    bars: Sequence[dict[str, Any]],
    ichi: dict[str, list[float]],
    macd_res: dict[str, list[float | None]],
    rsi_arr: list[float | None],
    sr: dict[str, float],
) -> dict[str, Any]:
    i = len(bars) - 1
    price = bars[i]["c"]
    closes = [b["c"] for b in bars]
    signals: list[dict[str, str]] = []

    # 1. RSI (14)
    r_val = rsi_arr[i] if rsi_arr else None
    if r_val is None:
        signals.append(
            {"id": "rsi", "name": "RSI (14)", "value": "—", "verdict": "na", "detail": "Not enough bars."}
        )
    else:
        if r_val > 70:
            verdict = "bearish"
            detail = "Overbought — stretched above 70, pullback risk."
        elif r_val < 30:
            verdict = "bullish"
            detail = "Oversold — stretched below 30, room to rebound."
        elif r_val >= 55:
            verdict = "bullish"
            detail = "Healthy upward momentum (55–70 band)."
        elif r_val <= 45:
            verdict = "bearish"
            detail = "Fading momentum (30–45 band)."
        else:
            verdict = "neutral"
            detail = "Mid-range — no momentum edge either way."
        signals.append(
            {"id": "rsi", "name": "RSI (14)", "value": f"{r_val:.1f}", "verdict": verdict, "detail": detail}
        )

    # 2. Stochastic %K/%D (14,3)
    st = stochastic(bars)
    k = st["k"][i] if st["k"] else None
    d = st["d"][i] if st["d"] else None
    if k is None or d is None:
        signals.append(
            {"id": "stoch", "name": "Stochastic (14,3)", "value": "—", "verdict": "na", "detail": "Not enough bars."}
        )
    else:
        if k > 80:
            verdict = "bearish"
            detail = "Overbought — %K above 80."
        elif k < 20:
            verdict = "bullish"
            detail = "Oversold — %K below 20."
        elif abs(k - d) < 1:
            verdict = "neutral"
            detail = "%K and %D overlapping — no clear cross."
        elif k > d:
            verdict = "bullish"
            detail = "%K above %D — upward pressure."
        else:
            verdict = "bearish"
            detail = "%K below %D — downward pressure."
        signals.append(
            {
                "id": "stoch",
                "name": "Stochastic (14,3)",
                "value": f"{k:.0f} / {d:.0f}",
                "verdict": verdict,
                "detail": detail,
            }
        )

    # 3. MACD (12,26,9)
    line = macd_res["line"][i]
    sig = macd_res["signal"][i]
    hist = macd_res["hist"][i]
    if line is None or sig is None or hist is None:
        signals.append(
            {"id": "macd", "name": "MACD (12,26,9)", "value": "—", "verdict": "na", "detail": "Not enough bars."}
        )
    else:
        cross = line > sig
        confirmed = hist >= 0 if cross else hist <= 0
        verdict = "neutral" if not confirmed else "bullish" if cross else "bearish"
        detail = (
            "Line and histogram disagree — momentum turning."
            if not confirmed
            else "MACD line above signal — upward momentum."
            if cross
            else "MACD line below signal — downward momentum."
        )
        signals.append(
            {
                "id": "macd",
                "name": "MACD (12,26,9)",
                "value": f"{line:.1f} / {sig:.1f}",
                "verdict": verdict,
                "detail": detail,
            }
        )

    # 4. EMA 20/50
    ema20_arr = ema(closes, 20)
    ema50_arr = ema(closes, 50)
    ema20 = ema20_arr[i] if ema20_arr else None
    ema50 = ema50_arr[i] if ema50_arr else None
    if ema20 is None or ema50 is None or ema50 == 0:
        signals.append(
            {"id": "emacross", "name": "EMA 20/50", "value": "—", "verdict": "na", "detail": "Not enough bars."}
        )
    else:
        gap = (ema20 - ema50) / ema50
        verdict = "neutral" if abs(gap) < 0.001 else "bullish" if gap > 0 else "bearish"
        detail = (
            "EMAs intertwined — trendless."
            if verdict == "neutral"
            else "Short EMA above long — uptrend structure."
            if verdict == "bullish"
            else "Short EMA below long — downtrend structure."
        )
        signals.append(
            {
                "id": "emacross",
                "name": "EMA 20/50",
                "value": f"{ema20:,.0f} / {ema50:,.0f}",
                "verdict": verdict,
                "detail": detail,
            }
        )

    # 5. Price vs EMA20
    if ema20 is None or ema20 == 0:
        signals.append(
            {"id": "pricema", "name": "Price vs EMA20", "value": "—", "verdict": "na", "detail": "Not enough bars."}
        )
    else:
        gap = (price - ema20) / ema20
        verdict = "neutral" if abs(gap) < 0.0025 else "bullish" if gap > 0 else "bearish"
        detail = (
            "Price sitting on its 20-bar average."
            if verdict == "neutral"
            else "Price above its 20-bar average."
            if verdict == "bullish"
            else "Price below its 20-bar average."
        )
        signals.append(
            {
                "id": "pricema",
                "name": "Price vs EMA20",
                "value": f"{gap * 100:.2f}%",
                "verdict": verdict,
                "detail": detail,
            }
        )

    # 6. Ichimoku cloud
    top = max(ichi["senkouA"][i], ichi["senkouB"][i])
    bottom = min(ichi["senkouA"][i], ichi["senkouB"][i])
    verdict = "bullish" if price > top else "bearish" if price < bottom else "neutral"
    value_str = "above" if verdict == "bullish" else "below" if verdict == "bearish" else "inside"
    detail = (
        f"Price above the cloud ({bottom:,.0f}–{top:,.0f})."
        if verdict == "bullish"
        else f"Price below the cloud ({bottom:,.0f}–{top:,.0f})."
        if verdict == "bearish"
        else f"Price inside the cloud ({bottom:,.0f}–{top:,.0f}) — consolidating."
    )
    signals.append(
        {"id": "cloud", "name": "Ichimoku cloud", "value": value_str, "verdict": verdict, "detail": detail}
    )

    # 7. Tenkan / Kijun
    t = ichi["tenkan"][i]
    kj = ichi["kijun"][i]
    if kj == 0:
        gap = 0.0
    else:
        gap = (t - kj) / kj
    verdict = "neutral" if abs(gap) < 0.001 else "bullish" if gap > 0 else "bearish"
    detail = (
        "Conversion and base lines overlapping."
        if verdict == "neutral"
        else "Tenkan above Kijun — short-term strength."
        if verdict == "bullish"
        else "Tenkan below Kijun — short-term weakness."
    )
    signals.append(
        {"id": "tk", "name": "Tenkan / Kijun", "value": f"{t:,.0f} / {kj:,.0f}", "verdict": verdict, "detail": detail}
    )

    # 8. ADX (14) + DMI
    dmi = adx(bars)
    adx_val = dmi["adx"][i] if dmi["adx"] else None
    pdi = dmi["plusDi"][i] if dmi["plusDi"] else None
    mdi = dmi["minusDi"][i] if dmi["minusDi"] else None
    if adx_val is None or pdi is None or mdi is None:
        signals.append(
            {"id": "adx", "name": "ADX (14)", "value": "—", "verdict": "na", "detail": "Not enough bars."}
        )
    else:
        verdict = "neutral" if adx_val <= 20 else "bullish" if pdi > mdi else "bearish"
        detail = (
            "ADX below 20 — no meaningful trend to follow."
            if verdict == "neutral"
            else f"Trending (ADX {adx_val:.0f}) with +DI {pdi:.0f} above −DI {mdi:.0f}."
            if verdict == "bullish"
            else f"Trending (ADX {adx_val:.0f}) with −DI {mdi:.0f} above +DI {pdi:.0f}."
        )
        signals.append(
            {"id": "adx", "name": "ADX (14)", "value": f"{adx_val:.1f}", "verdict": verdict, "detail": detail}
        )

    # 9. OBV flow
    obv_arr = obv(bars)
    if obv_arr is None:
        signals.append(
            {
                "id": "obv",
                "name": "OBV flow",
                "value": "—",
                "verdict": "na",
                "detail": "No volume data on this timeframe.",
            }
        )
    else:
        obv_ema_arr = ema(obv_arr, 20)
        obv_ema = obv_ema_arr[i] if obv_ema_arr else None
        obv_now = obv_arr[-1]
        if obv_ema is None:
            signals.append(
                {"id": "obv", "name": "OBV flow", "value": "—", "verdict": "na", "detail": "Not enough bars."}
            )
        else:
            scale = max(abs(obv_ema), 1.0)
            gap = (obv_now - obv_ema) / scale
            verdict = "neutral" if abs(gap) < 0.01 else "bullish" if gap > 0 else "bearish"
            val_text = "accumulating" if verdict == "bullish" else "distributing" if verdict == "bearish" else "flat"
            detail = (
                "On-balance volume hugging its average."
                if verdict == "neutral"
                else "On-balance volume above its average — buyers absorbing."
                if verdict == "bullish"
                else "On-balance volume below its average — sellers dominating."
            )
            signals.append(
                {"id": "obv", "name": "OBV flow", "value": val_text, "verdict": verdict, "detail": detail}
            )

    # 10. Support/Resistance
    support = sr["support"]
    resistance = sr["resistance"]
    if price > resistance:
        verdict = "bullish"
        value_str = "breakout"
        detail = f"Close {price:,.0f} above recent resistance {resistance:,.0f}."
    elif price < support:
        verdict = "bearish"
        value_str = "breakdown"
        detail = f"Close {price:,.0f} below recent support {support:,.0f}."
    elif price >= resistance * 0.98:
        verdict = "bearish"
        value_str = "at resistance"
        detail = f"Within 2% of resistance {resistance:,.0f} — rejection risk."
    elif price <= support * 1.02:
        verdict = "bullish"
        value_str = "at support"
        detail = f"Within 2% of support {support:,.0f} — bounce zone."
    else:
        verdict = "neutral"
        value_str = "mid-range"
        detail = f"Between support {support:,.0f} and resistance {resistance:,.0f}."
    signals.append(
        {"id": "sr", "name": "Support/Resistance", "value": value_str, "verdict": verdict, "detail": detail}
    )

    bullish_cnt = sum(1 for s in signals if s["verdict"] == "bullish")
    bearish_cnt = sum(1 for s in signals if s["verdict"] == "bearish")
    neutral_cnt = sum(1 for s in signals if s["verdict"] == "neutral")
    net = bullish_cnt - bearish_cnt
    overall = "bullish" if net >= 3 else "bearish" if net <= -3 else "neutral"

    return {
        "signals": signals,
        "bullish": bullish_cnt,
        "neutral": neutral_cnt,
        "bearish": bearish_cnt,
        "overall": overall,
    }


def _session_date_wib(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=ZoneInfo("UTC"))
    return dt.astimezone(WIB).strftime("%Y-%m-%d")


def _minutes_of_day_wib(dt: datetime) -> int:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=ZoneInfo("UTC"))
    local = dt.astimezone(WIB)
    return local.hour * 60 + local.minute


def session_rvol(bars5m: Sequence[dict[str, Any]], baseline_days: int = 10) -> dict[str, Any] | None:
    if not bars5m:
        return None

    sessions: dict[str, list[dict[str, Any]]] = {}
    for bar in bars5m:
        if bar.get("v") is None:
            return None
        day = _session_date_wib(bar["ts"])
        sessions.setdefault(day, []).append(bar)

    days = sorted(sessions.keys())
    if len(days) < 2:
        return None

    current_day = days[-1]
    current_bars = sessions[current_day]
    session_volume = sum(b.get("v") or 0 for b in current_bars)
    cutoff_minute = _minutes_of_day_wib(current_bars[-1]["ts"])

    prior_days = days[:-1][-baseline_days:]
    prior_cums: list[int] = []
    for day in prior_days:
        day_cum = sum(
            b.get("v") or 0
            for b in sessions[day]
            if _minutes_of_day_wib(b["ts"]) <= cutoff_minute
        )
        if day_cum > 0:
            prior_cums.append(day_cum)

    if not prior_cums:
        return None

    baseline_volume = sum(prior_cums) / len(prior_cums)
    rvol = (session_volume / baseline_volume) if baseline_volume else 0.0

    return {
        "session_volume": session_volume,
        "baseline_volume": baseline_volume,
        "rvol": rvol,
        "session_date": current_day,
        "baseline_sessions": len(prior_cums),
    }


def daily_rvol(daily: Sequence[dict[str, Any]], period: int = 20) -> dict[str, Any] | None:
    with_vol = [b for b in daily if b.get("v") is not None]
    if len(with_vol) < period + 1:
        return None
    last_bar = with_vol[-1]
    window = with_vol[-(period + 1) : -1]
    baseline_volume = sum(b["v"] for b in window) / len(window)
    vol = last_bar.get("v") or 0
    return {
        "session_volume": vol,
        "baseline_volume": baseline_volume,
        "rvol": (vol / baseline_volume) if baseline_volume else 0.0,
        "session_date": _session_date_wib(last_bar["ts"]),
        "baseline_sessions": len(window),
    }


def volume_spike(bars: Sequence[dict[str, Any]], window: int = 20) -> dict[str, Any] | None:
    with_vol = [b for b in bars if b.get("v") is not None]
    if len(with_vol) < window + 1:
        return None

    completed = [b for b in with_vol if b.get("final", False)]
    target = completed[-1] if completed else with_vol[-1]
    idx = with_vol.index(target)
    prior = with_vol[max(0, idx - window) : idx]
    if len(prior) < 5:
        return None

    vols = [b["v"] or 0 for b in prior]
    mean = sum(vols) / len(vols)
    variance = sum((v - mean) ** 2 for v in vols) / len(vols)
    sd = math.sqrt(variance)
    target_vol = target["v"] or 0

    return {
        "z_score": ((target_vol - mean) / sd) if sd else 0.0,
        "bar_volume": target_vol,
        "mean_volume": mean,
    }
