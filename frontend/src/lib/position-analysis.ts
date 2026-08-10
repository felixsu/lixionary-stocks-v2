"use client";

// Per-position analysis payload builder, shared by the recommendations button
// and the chat's on-demand "analyze" round. Fetches daily candles + news and
// distills them into what the LLM actually needs.

import { type CandlesOut, type NewsList, candlesKey, fetcher, newsKey } from "./api";
import { ichimoku, macd, rsi, supportResistance } from "./indicators";
import { type Position } from "./portfolio";
import { computeScorecard } from "./signals";
import { dailyRvol } from "./volume";

export interface PositionAnalysis {
  symbol: string;
  lots: number;
  avg_price: number;
  last_close: number | null;
  market_value: number | null;
  pnl: number | null;
  pnl_pct: number | null;
  day_change_pct: number | null;
  technical_scorecard_daily: {
    overall: string;
    bullish: number;
    neutral: number;
    bearish: number;
    signals: { name: string; verdict: string; value: string }[];
  } | null;
  /** Daily relative volume vs the 20-session average. */
  volume_daily: { rvol: number; baseline_sessions: number } | null;
  recent_news: { title: string; sentiment: string; direction?: string }[];
}

export async function analyzePosition(p: Position): Promise<PositionAnalysis> {
  let scorecard: PositionAnalysis["technical_scorecard_daily"] = null;
  let volume: PositionAnalysis["volume_daily"] = null;
  let newsTags: PositionAnalysis["recent_news"] = [];
  try {
    const candles = await fetcher<CandlesOut>(candlesKey(p.symbol, "1d", 200));
    const bars = candles.bars;
    if (bars.length >= 60) {
      const sc = computeScorecard(bars, {
        ichimoku: ichimoku(bars),
        macd: macd(bars.map((b) => b.c)),
        rsi: rsi(bars.map((b) => b.c)),
        sr: supportResistance(bars),
      });
      scorecard = {
        overall: sc.overall,
        bullish: sc.bullish,
        neutral: sc.neutral,
        bearish: sc.bearish,
        signals: sc.signals.map((s) => ({ name: s.name, verdict: s.verdict, value: s.value })),
      };
    }
    const rv = dailyRvol(bars, 20);
    if (rv) volume = { rvol: Math.round(rv.rvol * 100) / 100, baseline_sessions: rv.baselineSessions };
    const news = await fetcher<NewsList>(newsKey({ symbol: p.symbol, limit: 5 }));
    newsTags = news.items
      .filter((i) => i.analysis)
      .map((i) => ({
        title: i.title,
        sentiment: i.analysis!.sentiment,
        direction: i.analysis!.symbols.find((s) => s.symbol === p.symbol)?.direction,
      }));
  } catch {
    /* missing data for a symbol must not sink the batch */
  }
  return {
    symbol: p.symbol,
    lots: p.lots,
    avg_price: p.avg_price,
    last_close: p.last_close,
    market_value: p.market_value,
    pnl: p.pnl,
    pnl_pct: p.pnl_pct,
    day_change_pct: p.day_change_pct,
    technical_scorecard_daily: scorecard,
    volume_daily: volume,
    recent_news: newsTags,
  };
}

export function analyzePositions(positions: Position[]): Promise<PositionAnalysis[]> {
  return Promise.all(positions.map(analyzePosition));
}
