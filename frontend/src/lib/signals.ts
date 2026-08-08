// Technical scorecard: ten independent bearish/neutral/bullish reads on the
// current timeframe's bars. Pure functions — testable in Node.
//
// Signal diversity is deliberate: momentum (RSI, Stochastic, MACD), trend
// (EMAs, Ichimoku), trend strength (ADX), volume flow (OBV), and price levels
// (support/resistance). Each verdict carries a one-line `detail` naming the
// evidence, so a non-expert can learn what the badge means.

import type { Bar } from "./api";
import {
  type IchimokuResult,
  type MacdResult,
  type SupportResistance,
  adx,
  ema,
  obv,
  stochastic,
} from "./indicators";

export type Verdict = "bullish" | "neutral" | "bearish" | "na";

export interface Signal {
  id: string;
  name: string;
  /** Display value, mono-formatted by the card. */
  value: string;
  verdict: Verdict;
  /** One-line evidence for the verdict. */
  detail: string;
}

export interface Scorecard {
  signals: Signal[];
  bullish: number;
  neutral: number;
  bearish: number;
  /** Net (bullish − bearish) mapped to an overall stance at ±3. */
  overall: Exclude<Verdict, "na">;
}

export interface ScorecardInputs {
  ichimoku: IchimokuResult;
  macd: MacdResult;
  rsi: (number | null)[];
  sr: SupportResistance;
}

const fmt = (v: number, digits = 0): string =>
  v.toLocaleString("en-US", { maximumFractionDigits: digits });

function last<T>(arr: (T | null)[]): T | null {
  return arr.length ? arr[arr.length - 1] : null;
}

export function computeScorecard(bars: Bar[], inputs: ScorecardInputs): Scorecard {
  const i = bars.length - 1;
  const price = bars[i].c;
  const closes = bars.map((b) => b.c);
  const signals: Signal[] = [];

  // 1 · RSI(14): extremes are contrarian, the 45–70 middle reads as momentum.
  const rsiVal = last(inputs.rsi);
  if (rsiVal == null) {
    signals.push({ id: "rsi", name: "RSI (14)", value: "—", verdict: "na", detail: "Not enough bars." });
  } else {
    let verdict: Verdict;
    let detail: string;
    if (rsiVal > 70) {
      verdict = "bearish";
      detail = "Overbought — stretched above 70, pullback risk.";
    } else if (rsiVal < 30) {
      verdict = "bullish";
      detail = "Oversold — stretched below 30, room to rebound.";
    } else if (rsiVal >= 55) {
      verdict = "bullish";
      detail = "Healthy upward momentum (55–70 band).";
    } else if (rsiVal <= 45) {
      verdict = "bearish";
      detail = "Fading momentum (30–45 band).";
    } else {
      verdict = "neutral";
      detail = "Mid-range — no momentum edge either way.";
    }
    signals.push({ id: "rsi", name: "RSI (14)", value: rsiVal.toFixed(1), verdict, detail });
  }

  // 2 · Stochastic %K/%D (14,3)
  const st = stochastic(bars);
  const k = last(st.k);
  const d = last(st.d);
  if (k == null || d == null) {
    signals.push({ id: "stoch", name: "Stochastic (14,3)", value: "—", verdict: "na", detail: "Not enough bars." });
  } else {
    let verdict: Verdict;
    let detail: string;
    if (k > 80) {
      verdict = "bearish";
      detail = "Overbought — %K above 80.";
    } else if (k < 20) {
      verdict = "bullish";
      detail = "Oversold — %K below 20.";
    } else if (Math.abs(k - d) < 1) {
      verdict = "neutral";
      detail = "%K and %D overlapping — no clear cross.";
    } else if (k > d) {
      verdict = "bullish";
      detail = "%K above %D — upward pressure.";
    } else {
      verdict = "bearish";
      detail = "%K below %D — downward pressure.";
    }
    signals.push({
      id: "stoch",
      name: "Stochastic (14,3)",
      value: `${k.toFixed(0)} / ${d.toFixed(0)}`,
      verdict,
      detail,
    });
  }

  // 3 · MACD line vs signal, histogram as confirmation
  const line = last(inputs.macd.line);
  const sig = last(inputs.macd.signal);
  const hist = last(inputs.macd.hist);
  if (line == null || sig == null || hist == null) {
    signals.push({ id: "macd", name: "MACD (12,26,9)", value: "—", verdict: "na", detail: "Not enough bars." });
  } else {
    const cross = line > sig;
    const confirmed = cross ? hist >= 0 : hist <= 0;
    const verdict: Verdict = !confirmed ? "neutral" : cross ? "bullish" : "bearish";
    signals.push({
      id: "macd",
      name: "MACD (12,26,9)",
      value: `${line.toFixed(1)} / ${sig.toFixed(1)}`,
      verdict,
      detail: !confirmed
        ? "Line and histogram disagree — momentum turning."
        : cross
          ? "MACD line above signal — upward momentum."
          : "MACD line below signal — downward momentum.",
    });
  }

  // 4 · EMA 20/50 trend cross
  const ema20 = last(ema(closes, 20));
  const ema50 = last(ema(closes, 50));
  if (ema20 == null || ema50 == null) {
    signals.push({ id: "emacross", name: "EMA 20/50", value: "—", verdict: "na", detail: "Not enough bars." });
  } else {
    const gap = (ema20 - ema50) / ema50;
    const verdict: Verdict = Math.abs(gap) < 0.001 ? "neutral" : gap > 0 ? "bullish" : "bearish";
    signals.push({
      id: "emacross",
      name: "EMA 20/50",
      value: `${fmt(ema20)} / ${fmt(ema50)}`,
      verdict,
      detail:
        verdict === "neutral"
          ? "EMAs intertwined — trendless."
          : verdict === "bullish"
            ? "Short EMA above long — uptrend structure."
            : "Short EMA below long — downtrend structure.",
    });
  }

  // 5 · Price vs EMA20
  if (ema20 == null) {
    signals.push({ id: "pricema", name: "Price vs EMA20", value: "—", verdict: "na", detail: "Not enough bars." });
  } else {
    const gap = (price - ema20) / ema20;
    const verdict: Verdict = Math.abs(gap) < 0.0025 ? "neutral" : gap > 0 ? "bullish" : "bearish";
    signals.push({
      id: "pricema",
      name: "Price vs EMA20",
      value: `${(gap * 100).toFixed(2)}%`,
      verdict,
      detail:
        verdict === "neutral"
          ? "Price sitting on its 20-bar average."
          : verdict === "bullish"
            ? "Price above its 20-bar average."
            : "Price below its 20-bar average.",
    });
  }

  // 6 · Ichimoku cloud position
  {
    const a = inputs.ichimoku.senkouA[i];
    const b = inputs.ichimoku.senkouB[i];
    const top = Math.max(a, b);
    const bottom = Math.min(a, b);
    const verdict: Verdict = price > top ? "bullish" : price < bottom ? "bearish" : "neutral";
    signals.push({
      id: "cloud",
      name: "Ichimoku cloud",
      value: verdict === "bullish" ? "above" : verdict === "bearish" ? "below" : "inside",
      verdict,
      detail:
        verdict === "bullish"
          ? `Price above the cloud (${fmt(bottom)}–${fmt(top)}).`
          : verdict === "bearish"
            ? `Price below the cloud (${fmt(bottom)}–${fmt(top)}).`
            : `Price inside the cloud (${fmt(bottom)}–${fmt(top)}) — consolidating.`,
    });
  }

  // 7 · Tenkan/Kijun cross
  {
    const t = inputs.ichimoku.tenkan[i];
    const kj = inputs.ichimoku.kijun[i];
    const gap = (t - kj) / kj;
    const verdict: Verdict = Math.abs(gap) < 0.001 ? "neutral" : gap > 0 ? "bullish" : "bearish";
    signals.push({
      id: "tk",
      name: "Tenkan / Kijun",
      value: `${fmt(t)} / ${fmt(kj)}`,
      verdict,
      detail:
        verdict === "neutral"
          ? "Conversion and base lines overlapping."
          : verdict === "bullish"
            ? "Tenkan above Kijun — short-term strength."
            : "Tenkan below Kijun — short-term weakness.",
    });
  }

  // 8 · ADX(14) + DMI direction
  const dmi = adx(bars);
  const adxVal = last(dmi.adx);
  const pdi = last(dmi.plusDi);
  const mdi = last(dmi.minusDi);
  if (adxVal == null || pdi == null || mdi == null) {
    signals.push({ id: "adx", name: "ADX (14)", value: "—", verdict: "na", detail: "Not enough bars." });
  } else {
    const verdict: Verdict = adxVal <= 20 ? "neutral" : pdi > mdi ? "bullish" : "bearish";
    signals.push({
      id: "adx",
      name: "ADX (14)",
      value: adxVal.toFixed(1),
      verdict,
      detail:
        verdict === "neutral"
          ? "ADX below 20 — no meaningful trend to follow."
          : verdict === "bullish"
            ? `Trending (ADX ${adxVal.toFixed(0)}) with +DI ${pdi.toFixed(0)} above −DI ${mdi.toFixed(0)}.`
            : `Trending (ADX ${adxVal.toFixed(0)}) with −DI ${mdi.toFixed(0)} above +DI ${pdi.toFixed(0)}.`,
    });
  }

  // 9 · OBV vs its 20-EMA — n/a when the series has no volume
  const obvArr = obv(bars);
  if (!obvArr) {
    signals.push({
      id: "obv",
      name: "OBV flow",
      value: "—",
      verdict: "na",
      detail: "No volume data on this timeframe.",
    });
  } else {
    const obvEma = last(ema(obvArr, 20));
    const obvNow = obvArr[obvArr.length - 1];
    if (obvEma == null) {
      signals.push({ id: "obv", name: "OBV flow", value: "—", verdict: "na", detail: "Not enough bars." });
    } else {
      const scale = Math.max(Math.abs(obvEma), 1);
      const gap = (obvNow - obvEma) / scale;
      const verdict: Verdict = Math.abs(gap) < 0.01 ? "neutral" : gap > 0 ? "bullish" : "bearish";
      signals.push({
        id: "obv",
        name: "OBV flow",
        value: verdict === "bullish" ? "accumulating" : verdict === "bearish" ? "distributing" : "flat",
        verdict,
        detail:
          verdict === "neutral"
            ? "On-balance volume hugging its average."
            : verdict === "bullish"
              ? "On-balance volume above its average — buyers absorbing."
              : "On-balance volume below its average — sellers dominating.",
      });
    }
  }

  // 10 · Support/resistance position
  {
    const { support, resistance } = inputs.sr;
    let verdict: Verdict;
    let detail: string;
    let value: string;
    if (price > resistance) {
      verdict = "bullish";
      value = "breakout";
      detail = `Close ${fmt(price)} above recent resistance ${fmt(resistance)}.`;
    } else if (price < support) {
      verdict = "bearish";
      value = "breakdown";
      detail = `Close ${fmt(price)} below recent support ${fmt(support)}.`;
    } else if (price >= resistance * 0.98) {
      verdict = "bearish";
      value = "at resistance";
      detail = `Within 2% of resistance ${fmt(resistance)} — rejection risk.`;
    } else if (price <= support * 1.02) {
      verdict = "bullish";
      value = "at support";
      detail = `Within 2% of support ${fmt(support)} — bounce zone.`;
    } else {
      verdict = "neutral";
      value = "mid-range";
      detail = `Between support ${fmt(support)} and resistance ${fmt(resistance)}.`;
    }
    signals.push({ id: "sr", name: "Support/Resistance", value, verdict, detail });
  }

  const bullish = signals.filter((s) => s.verdict === "bullish").length;
  const bearish = signals.filter((s) => s.verdict === "bearish").length;
  const neutral = signals.filter((s) => s.verdict === "neutral").length;
  const net = bullish - bearish;
  const overall = net >= 3 ? "bullish" : net <= -3 ? "bearish" : "neutral";

  return { signals, bullish, neutral, bearish, overall };
}
