// Indicator math, ported as-is from the design handoff's stock-data.js.
// All functions are pure and operate on the API's Bar shape.

import type { Bar } from "./api";

export function ema(values: (number | null)[], period: number): (number | null)[] {
  const k = 2 / (period + 1);
  const out: (number | null)[] = new Array(values.length).fill(null);
  let prev: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) continue;
    prev = prev == null ? v : v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export interface MacdResult {
  line: (number | null)[];
  signal: (number | null)[];
  hist: (number | null)[];
}

export function macd(closes: number[]): MacdResult {
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  const line = closes.map((_, i) =>
    e12[i] != null && e26[i] != null ? e12[i]! - e26[i]! : null,
  );
  const signal = ema(line, 9);
  const hist = line.map((v, i) => (v != null && signal[i] != null ? v - signal[i]! : null));
  return { line, signal, hist };
}

export function rsi(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const g = Math.max(change, 0);
    const l = Math.max(-change, 0);
    if (i <= period) {
      gain += g;
      loss += l;
      if (i === period) {
        const rs = gain / period / (loss / period || 1e-9);
        out[i] = 100 - 100 / (1 + rs);
      }
    } else {
      gain = (gain * (period - 1) + g) / period;
      loss = (loss * (period - 1) + l) / period;
      const rs = gain / (loss || 1e-9);
      out[i] = 100 - 100 / (1 + rs);
    }
  }
  return out;
}

function rollingExtreme(bars: Bar[], period: number, mode: "max" | "min", idx: number): number {
  const start = Math.max(0, idx - period + 1);
  let val = mode === "max" ? -Infinity : Infinity;
  for (let i = start; i <= idx; i++) {
    const v = mode === "max" ? bars[i].h : bars[i].l;
    val = mode === "max" ? Math.max(val, v) : Math.min(val, v);
  }
  return val;
}

export interface IchimokuResult {
  tenkan: number[];
  kijun: number[];
  senkouA: number[];
  senkouB: number[];
}

export function ichimoku(bars: Bar[]): IchimokuResult {
  const tenkan: number[] = [];
  const kijun: number[] = [];
  const senkouA: number[] = [];
  const senkouB: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const t = (rollingExtreme(bars, 9, "max", i) + rollingExtreme(bars, 9, "min", i)) / 2;
    const k = (rollingExtreme(bars, 26, "max", i) + rollingExtreme(bars, 26, "min", i)) / 2;
    tenkan.push(t);
    kijun.push(k);
    senkouA.push((t + k) / 2);
    senkouB.push((rollingExtreme(bars, 52, "max", i) + rollingExtreme(bars, 52, "min", i)) / 2);
  }
  return { tenkan, kijun, senkouA, senkouB };
}

export interface SupportResistance {
  support: number;
  resistance: number;
}

export function supportResistance(bars: Bar[], lookback = 40): SupportResistance {
  const slice = bars.slice(-lookback, -3);
  if (!slice.length) return { support: bars[0].l, resistance: bars[0].h };
  return {
    support: Math.min(...slice.map((b) => b.l)),
    resistance: Math.max(...slice.map((b) => b.h)),
  };
}

export function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ax = a.slice(-n);
  const bx = b.slice(-n);
  const ma = ax.reduce((s, v) => s + v, 0) / n;
  const mb = bx.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = ax[i] - ma;
    const y = bx[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

export function returns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) out.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  return out;
}

export type Stance = "bullish" | "bearish" | "neutral";

export interface AiSignal {
  stance: Stance;
  reasons: string[];
}

export function aiSignal(
  bars: Bar[],
  ichi: IchimokuResult,
  macdRes: MacdResult,
  rsiArr: (number | null)[],
  sr: SupportResistance,
): AiSignal {
  const i = bars.length - 1;
  const price = bars[i].c;
  const reasons: string[] = [];
  let score = 0;

  if (price > Math.max(ichi.senkouA[i], ichi.senkouB[i])) {
    score++;
    reasons.push("Price is trading above the Ichimoku cloud, a bullish trend signal.");
  } else if (price < Math.min(ichi.senkouA[i], ichi.senkouB[i])) {
    score--;
    reasons.push("Price is trading below the Ichimoku cloud, a bearish trend signal.");
  } else {
    reasons.push("Price is inside the Ichimoku cloud, indicating a consolidating trend.");
  }

  if (macdRes.line[i] != null && macdRes.signal[i] != null) {
    if (macdRes.line[i]! > macdRes.signal[i]!) {
      score++;
      reasons.push("MACD line is above the signal line, supporting upward momentum.");
    } else {
      score--;
      reasons.push("MACD line is below the signal line, suggesting fading momentum.");
    }
  }

  const r = rsiArr[i];
  if (r != null) {
    if (r >= 70) {
      score--;
      reasons.push(`RSI at ${r.toFixed(0)} is in overbought territory.`);
    } else if (r <= 30) {
      score++;
      reasons.push(`RSI at ${r.toFixed(0)} is in oversold territory, room to rebound.`);
    } else {
      reasons.push(`RSI at ${r.toFixed(0)} sits in neutral range.`);
    }
  }

  if (price >= sr.resistance * 0.995) {
    reasons.push("Price is testing recent resistance — a breakout would confirm strength.");
  } else if (price <= sr.support * 1.005) {
    reasons.push("Price is testing recent support — a breakdown would signal further weakness.");
  }

  const stance: Stance = score >= 1 ? "bullish" : score <= -1 ? "bearish" : "neutral";
  return { stance, reasons: reasons.slice(0, 3) };
}

// ── Stochastic oscillator (%K smoothed over kPeriod highs/lows, %D = SMA of %K) ──

export interface StochasticResult {
  k: (number | null)[];
  d: (number | null)[];
}

export function stochastic(bars: Bar[], kPeriod = 14, dPeriod = 3): StochasticResult {
  const k: (number | null)[] = new Array(bars.length).fill(null);
  for (let i = kPeriod - 1; i < bars.length; i++) {
    const hi = rollingExtreme(bars, kPeriod, "max", i);
    const lo = rollingExtreme(bars, kPeriod, "min", i);
    k[i] = hi === lo ? 50 : ((bars[i].c - lo) / (hi - lo)) * 100;
  }
  const d: (number | null)[] = new Array(bars.length).fill(null);
  for (let i = 0; i < bars.length; i++) {
    const window = k.slice(Math.max(0, i - dPeriod + 1), i + 1).filter((v): v is number => v != null);
    if (window.length === dPeriod) d[i] = window.reduce((s, v) => s + v, 0) / dPeriod;
  }
  return { k, d };
}

// ── ADX / DMI (Wilder smoothing) ────────────────────────────────────────────

// ── Average True Range ──────────────────────────────────────────────────────

/**
 * Wilder-smoothed ATR. Gives a stop distance a volatility scale: a level a
 * fraction of an ATR below price is inside the noise and will be taken out by
 * ordinary movement, whichever structural line it sits on.
 */
export function atr(bars: Bar[], period = 14): (number | null)[] {
  const n = bars.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (n < period + 1) return out;

  let acc = 0;
  let smoothed: number | null = null;
  for (let i = 1; i < n; i++) {
    const cur = bars[i];
    const prev = bars[i - 1];
    const tr = Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c));
    if (i <= period) {
      acc += tr;
      if (i === period) {
        smoothed = acc / period;
        out[i] = smoothed;
      }
      continue;
    }
    smoothed = ((smoothed as number) * (period - 1) + tr) / period;
    out[i] = smoothed;
  }
  return out;
}

export interface AdxResult {
  adx: (number | null)[];
  plusDi: (number | null)[];
  minusDi: (number | null)[];
}

export function adx(bars: Bar[], period = 14): AdxResult {
  const n = bars.length;
  const out: AdxResult = {
    adx: new Array(n).fill(null),
    plusDi: new Array(n).fill(null),
    minusDi: new Array(n).fill(null),
  };
  if (n < period * 2 + 1) return out;

  let smTr = 0;
  let smPlus = 0;
  let smMinus = 0;
  let adxAcc: number | null = null;
  for (let i = 1; i < n; i++) {
    const cur = bars[i];
    const prev = bars[i - 1];
    const tr = Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c));
    const upMove = cur.h - prev.h;
    const downMove = prev.l - cur.l;
    const plusDm = upMove > downMove && upMove > 0 ? upMove : 0;
    const minusDm = downMove > upMove && downMove > 0 ? downMove : 0;

    if (i <= period) {
      // initial accumulation
      smTr += tr;
      smPlus += plusDm;
      smMinus += minusDm;
      if (i < period) continue;
    } else {
      // Wilder smoothing
      smTr = smTr - smTr / period + tr;
      smPlus = smPlus - smPlus / period + plusDm;
      smMinus = smMinus - smMinus / period + minusDm;
    }

    const pdi = smTr ? (smPlus / smTr) * 100 : 0;
    const mdi = smTr ? (smMinus / smTr) * 100 : 0;
    out.plusDi[i] = pdi;
    out.minusDi[i] = mdi;
    const dx = pdi + mdi ? (Math.abs(pdi - mdi) / (pdi + mdi)) * 100 : 0;

    if (i < period * 2) {
      adxAcc = adxAcc == null ? dx : adxAcc + dx;
      if (i === period * 2 - 1 && adxAcc != null) {
        adxAcc = adxAcc / period;
        out.adx[i] = adxAcc;
      }
    } else if (adxAcc != null) {
      adxAcc = (adxAcc * (period - 1) + dx) / period;
      out.adx[i] = adxAcc;
    }
  }
  return out;
}

// ── On-Balance Volume ───────────────────────────────────────────────────────

/** Returns null when the series carries no volume (e.g. index intraday). */
export function obv(bars: Bar[]): number[] | null {
  if (!bars.length || bars.some((b) => b.v == null)) return null;
  const out: number[] = new Array(bars.length);
  out[0] = 0;
  for (let i = 1; i < bars.length; i++) {
    const dir = bars[i].c > bars[i - 1].c ? 1 : bars[i].c < bars[i - 1].c ? -1 : 0;
    out[i] = out[i - 1] + dir * (bars[i].v ?? 0);
  }
  return out;
}
