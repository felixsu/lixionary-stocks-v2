// Per-stock card metrics computed from recent daily bars.

import type { Bar } from "./api";
import { rsi } from "./indicators";

export interface StockMetrics {
  price: number;
  /** Percent change vs the PREVIOUS session's close (market convention —
   *  deliberately not the mock's same-bar open). */
  pct: number;
  dayHigh: number;
  dayLow: number;
  /** Latest volume vs the 20-day average, as a percentage delta. Null when
   *  volume is unavailable (e.g. the index). */
  volDelta: number | null;
  rsi: number | null;
}

export function metricsFromDaily(daily: Bar[]): StockMetrics | null {
  if (daily.length < 2) return null;
  const last = daily[daily.length - 1];
  const prev = daily[daily.length - 2];
  const pct = prev.c ? ((last.c - prev.c) / prev.c) * 100 : 0;

  const volWindow = daily.slice(-21, -1).map((b) => b.v);
  let volDelta: number | null = null;
  if (last.v != null && volWindow.every((v) => v != null) && volWindow.length > 0) {
    const avg = volWindow.reduce((s, v) => s + (v as number), 0) / volWindow.length;
    volDelta = avg ? ((last.v - avg) / avg) * 100 : null;
  }

  const rsiArr = rsi(daily.map((b) => b.c));
  const rsiVal = rsiArr[rsiArr.length - 1];

  return { price: last.c, pct, dayHigh: last.h, dayLow: last.l, volDelta, rsi: rsiVal };
}

export function fmtPrice(v: number): string {
  return v.toLocaleString("id-ID", { maximumFractionDigits: 0 });
}

export function fmtPct(v: number): string {
  const s = v >= 0 ? "+" : "";
  return `${s}${v.toFixed(2)}%`;
}

export function badgeClassForPct(pct: number): string {
  return pct > 0 ? "badge-success" : pct < 0 ? "badge-error" : "badge-default";
}

export function badgeClassForVol(d: number | null): string {
  return d != null && d > 15 ? "badge-warning" : "badge-default";
}

export function badgeClassForRsi(r: number | null): string {
  if (r == null) return "badge-default";
  return r >= 70 ? "badge-error" : r <= 30 ? "badge-success" : "badge-default";
}
