// Volume anomaly analysis.
//
// The core question: is current volume unusual for THIS point in the day?
// Intraday volume is heavily U-shaped (open and close are always busy), so a
// naive rolling average misleads. The standard fix is session-cumulative
// relative volume: compare today's running total against the average running
// total at the same elapsed-session moment across prior sessions.

import type { Bar } from "./api";

/** WIB calendar date of a bar — IDX sessions never cross midnight WIB. */
export function sessionDate(ts: string): string {
  return new Date(ts).toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" });
}

function minutesOfDayWIB(ts: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jakarta",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ts));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

export interface SessionRvol {
  /** Cumulative volume of the latest session up to its last bar. */
  sessionVolume: number;
  /** Mean cumulative volume of prior sessions at the same time-of-day. */
  baselineVolume: number;
  /** sessionVolume / baselineVolume. */
  rvol: number;
  /** WIB date of the session being measured (may be a past session off-hours). */
  sessionDate: string;
  /** Number of prior sessions in the baseline. */
  baselineSessions: number;
}

/**
 * Session-cumulative relative volume from 5m bars.
 *
 * The latest session's running volume total is compared against the average of
 * the prior `baselineDays` sessions' running totals truncated at the same
 * time-of-day, so a mid-morning reading is never judged against full-day
 * volumes.
 */
export function sessionRvol(bars5m: Bar[], baselineDays = 10): SessionRvol | null {
  if (!bars5m.length) return null;

  const sessions = new Map<string, Bar[]>();
  for (const bar of bars5m) {
    if (bar.v == null) return null; // no volume series (index intraday)
    const day = sessionDate(bar.ts);
    let list = sessions.get(day);
    if (!list) sessions.set(day, (list = []));
    list.push(bar);
  }

  const days = [...sessions.keys()].sort();
  if (days.length < 2) return null;

  const currentDay = days[days.length - 1];
  const currentBars = sessions.get(currentDay)!;
  const sessionVolume = currentBars.reduce((s, b) => s + (b.v ?? 0), 0);
  const cutoffMinute = minutesOfDayWIB(currentBars[currentBars.length - 1].ts);

  const priorDays = days.slice(0, -1).slice(-baselineDays);
  const priorCums = priorDays
    .map((day) =>
      sessions
        .get(day)!
        .filter((b) => minutesOfDayWIB(b.ts) <= cutoffMinute)
        .reduce((s, b) => s + (b.v ?? 0), 0),
    )
    .filter((v) => v > 0);
  if (!priorCums.length) return null;

  const baselineVolume = priorCums.reduce((s, v) => s + v, 0) / priorCums.length;
  return {
    sessionVolume,
    baselineVolume,
    rvol: baselineVolume ? sessionVolume / baselineVolume : 0,
    sessionDate: currentDay,
    baselineSessions: priorCums.length,
  };
}

/** Daily RVOL: latest session's volume vs the SMA of the prior `period` sessions. */
export function dailyRvol(daily: Bar[], period = 20): SessionRvol | null {
  const withVol = daily.filter((b) => b.v != null);
  if (withVol.length < period + 1) return null;
  const last = withVol[withVol.length - 1];
  const window = withVol.slice(-(period + 1), -1);
  const baselineVolume = window.reduce((s, b) => s + (b.v ?? 0), 0) / window.length;
  return {
    sessionVolume: last.v ?? 0,
    baselineVolume,
    rvol: baselineVolume ? (last.v ?? 0) / baselineVolume : 0,
    sessionDate: sessionDate(last.ts),
    baselineSessions: window.length,
  };
}

export interface VolumeSpike {
  /** z-score of the latest completed bar's volume vs the prior 20 bars. */
  zScore: number;
  barVolume: number;
  meanVolume: number;
}

/** Single-bar spike detector on the displayed timeframe's own bars. */
export function volumeSpike(bars: Bar[], window = 20): VolumeSpike | null {
  const withVol = bars.filter((b) => b.v != null);
  if (withVol.length < window + 1) return null;
  // Use the last COMPLETED bar; the forming bar's volume is still accruing.
  const completed = withVol.filter((b) => b.final);
  const target = completed.length ? completed[completed.length - 1] : withVol[withVol.length - 1];
  const idx = withVol.indexOf(target);
  const prior = withVol.slice(Math.max(0, idx - window), idx);
  if (prior.length < 5) return null;
  const vols = prior.map((b) => b.v ?? 0);
  const mean = vols.reduce((s, v) => s + v, 0) / vols.length;
  const variance = vols.reduce((s, v) => s + (v - mean) ** 2, 0) / vols.length;
  const sd = Math.sqrt(variance);
  return {
    zScore: sd ? ((target.v ?? 0) - mean) / sd : 0,
    barVolume: target.v ?? 0,
    meanVolume: mean,
  };
}

export type DemandLevel = "very-high" | "elevated" | "normal" | "quiet" | "very-quiet";

export interface DemandRead {
  level: DemandLevel;
  label: string;
  badgeClass: string;
}

export function classifyRvol(rvol: number): DemandRead {
  if (rvol >= 2.0)
    return { level: "very-high", label: "Very high demand", badgeClass: "badge-error" };
  if (rvol >= 1.3) return { level: "elevated", label: "Elevated demand", badgeClass: "badge-warning" };
  if (rvol >= 0.8) return { level: "normal", label: "Normal activity", badgeClass: "badge-default" };
  if (rvol >= 0.5) return { level: "quiet", label: "Quiet", badgeClass: "badge-default" };
  return { level: "very-quiet", label: "Very quiet", badgeClass: "badge-info" };
}

export function fmtVolume(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return `${Math.round(v)}`;
}
