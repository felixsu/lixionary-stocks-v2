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
