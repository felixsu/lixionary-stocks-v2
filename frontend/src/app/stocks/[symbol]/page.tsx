"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { use, useCallback, useMemo, useState } from "react";
import useSWR from "swr";

import { Badge } from "@/components/Badge";
import { CanvasChart } from "@/components/CanvasChart";
import { ErrorCard } from "@/components/ErrorCard";
import { LlmAnalysisCard } from "@/components/LlmAnalysisCard";
import { Skeleton } from "@/components/Skeleton";
import { TimeframeSwitcher } from "@/components/TimeframeSwitcher";
import { type CandlesOut, type SymbolOut, IHSG_SYMBOL, candlesKey, fetcher } from "@/lib/api";
import { CHART_COLORS, drawIndicatorPanel, drawPriceVolume } from "@/lib/chart-draw";
import { useDefaultTimeframe } from "@/lib/favorites";
import {
  aiSignal,
  correlation,
  ichimoku,
  macd,
  returns,
  rsi,
  supportResistance,
} from "@/lib/indicators";
import type { AnalysisInput } from "@/lib/llm";
import { badgeClassForPct, fmtPct, fmtPrice, metricsFromDaily } from "@/lib/metrics";
import { type TimeframeId } from "@/lib/timeframes";
import { classifyRvol, dailyRvol, fmtVolume, sessionRvol, volumeSpike } from "@/lib/volume";

const REFRESH_MS = 60_000;

// Enough history that Ichimoku's 52-bar lookback has warmup beyond the window.
const DETAIL_LIMIT = 180;

// ~15 sessions of 5m bars for the session-cumulative RVOL baseline.
const RVOL_5M_LIMIT = 1000;

export default function StockDetailPage({
  params,
}: {
  params: Promise<{ symbol: string }>;
}) {
  const { symbol: rawSymbol } = use(params);
  const symbol = decodeURIComponent(rawSymbol).toUpperCase();
  const isIndex = symbol.startsWith("^");

  // Independent timeframe state — deliberately not shared with the dashboard.
  const { defaultTimeframe } = useDefaultTimeframe();
  const [tfOverride, setTfOverride] = useState<TimeframeId | null>(null);
  const dtf = tfOverride ?? defaultTimeframe;

  const { data: symbols } = useSWR<SymbolOut[]>("/api/symbols", fetcher);
  const meta = symbols?.find((s) => s.symbol === symbol);

  const candles = useSWR<CandlesOut>(candlesKey(symbol, dtf, DETAIL_LIMIT), fetcher, {
    refreshInterval: REFRESH_MS,
  });
  const daily = useSWR<CandlesOut>(candlesKey(symbol, "1d", 40), fetcher, {
    refreshInterval: REFRESH_MS,
  });
  // 5m history for session RVOL (skipped for the index — no intraday volume).
  const fiveMin = useSWR<CandlesOut>(
    isIndex ? null : candlesKey(symbol, "5m", RVOL_5M_LIMIT),
    fetcher,
    { refreshInterval: REFRESH_MS },
  );
  // IHSG daily closes for the correlation figure fed to the LLM.
  const ihsgDaily = useSWR<CandlesOut>(candlesKey(IHSG_SYMBOL, "1d", 40), fetcher, {
    refreshInterval: REFRESH_MS,
  });

  const analysis = useMemo(() => {
    const bars = candles.data?.bars;
    if (!bars || bars.length < 5) return null;
    const closes = bars.map((b) => b.c);
    const ichi = ichimoku(bars);
    const sr = supportResistance(bars);
    const macdRes = macd(closes);
    const rsiArr = rsi(closes);
    const sig = aiSignal(bars, ichi, macdRes, rsiArr, sr);
    return { bars, ichi, sr, macdRes, rsiArr, sig };
  }, [candles.data]);

  const m = daily.data ? metricsFromDaily(daily.data.bars) : null;

  const volume = useMemo(() => {
    // Session-cumulative RVOL always derives from 5m (finest data); the spike
    // z-score reads the displayed timeframe's own bars.
    const session = dtf === "1d"
      ? daily.data
        ? dailyRvol(daily.data.bars)
        : null
      : fiveMin.data
        ? sessionRvol(fiveMin.data.bars)
        : null;
    const spike = analysis ? volumeSpike(analysis.bars) : null;
    return { session, spike };
  }, [dtf, daily.data, fiveMin.data, analysis]);

  const ihsgCorr = useMemo(() => {
    if (isIndex) return null;
    const a = daily.data?.bars;
    const b = ihsgDaily.data?.bars;
    if (!a?.length || !b?.length) return null;
    return correlation(returns(a.map((x) => x.c)), returns(b.map((x) => x.c)));
  }, [isIndex, daily.data, ihsgDaily.data]);

  const llmInput: AnalysisInput | null = useMemo(() => {
    if (!analysis || !m) return null;
    return {
      symbol,
      name: meta?.name ?? null,
      timeframe: dtf,
      price: m.price,
      changePct: m.pct,
      dayLow: m.dayLow,
      dayHigh: m.dayHigh,
      bars: analysis.bars,
      rsi: analysis.rsiArr[analysis.rsiArr.length - 1],
      macd: analysis.macdRes,
      ichimoku: analysis.ichi,
      sr: analysis.sr,
      heuristic: analysis.sig,
      sessionVolume: volume.session,
      volumeSpike: volume.spike,
      ihsgCorrelation: ihsgCorr,
    };
  }, [analysis, m, symbol, meta, dtf, volume, ihsgCorr]);

  const drawPrice = useCallback(
    (canvas: HTMLCanvasElement) => {
      if (!analysis || !candles.data) return;
      drawPriceVolume(canvas, analysis.bars, {
        showVolume: candles.data.has_volume,
        cloud: analysis.ichi,
        hlines: [
          { value: analysis.sr.resistance, color: CHART_COLORS.resistance, label: "Resistance" },
          { value: analysis.sr.support, color: CHART_COLORS.support, label: "Support" },
        ],
      });
    },
    [analysis, candles.data],
  );

  const drawMacd = useCallback(
    (canvas: HTMLCanvasElement) => {
      if (!analysis) return;
      drawIndicatorPanel(canvas, {
        length: analysis.bars.length,
        series: [
          { data: analysis.macdRes.line, color: CHART_COLORS.primary },
          { data: analysis.macdRes.signal, color: CHART_COLORS.kijun },
        ],
        histogram: analysis.macdRes.hist,
      });
    },
    [analysis],
  );

  const drawRsi = useCallback(
    (canvas: HTMLCanvasElement) => {
      if (!analysis) return;
      drawIndicatorPanel(canvas, {
        length: analysis.bars.length,
        series: [{ data: analysis.rsiArr, color: CHART_COLORS.primary }],
        bands: [
          { value: 70, color: CHART_COLORS.resistance, label: "70" },
          { value: 30, color: CHART_COLORS.up, label: "30" },
        ],
      });
    },
    [analysis],
  );

  const demand = volume.session ? classifyRvol(volume.session.rvol) : null;

  return (
    <div
      style={{
        maxWidth: 1360,
        margin: "0 auto",
        padding: 32,
        display: "flex",
        flexDirection: "column",
        gap: 24,
      }}
    >
      <Link
        href="/"
        className="btn-ghost btn-sm"
        style={{
          alignSelf: "flex-start",
          padding: 0,
          height: "auto",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: 13,
          fontWeight: 500,
        }}
      >
        <ArrowLeft size={14} /> Back to dashboard
      </Link>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <h2 style={{ margin: 0 }}>{symbol}</h2>
            {meta?.notes ? (
              <span className="role-pill">{meta.notes}</span>
            ) : meta?.kind === "index" ? (
              <span className="role-pill">Index</span>
            ) : null}
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 6 }}>
            {m ? (
              <>
                <span
                  style={{ fontFamily: "var(--font-mono)", fontSize: 26, color: "var(--color-ink)" }}
                >
                  {fmtPrice(m.price)}
                </span>
                <Badge className={badgeClassForPct(m.pct)}>{fmtPct(m.pct)}</Badge>
              </>
            ) : (
              <Skeleton height={32} />
            )}
            <span className="caption">{meta?.name ?? ""}</span>
          </div>
        </div>
        <TimeframeSwitcher value={dtf} onChange={setTfOverride} />
      </div>

      <div className="card-canvas" style={{ padding: "20px 24px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            marginBottom: 10,
            flexWrap: "wrap",
          }}
        >
          <span className="caption">Price · volume · Ichimoku cloud · support &amp; resistance</span>
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              fontSize: 12,
              color: "var(--color-muted)",
            }}
          >
            <span style={{ width: 10, height: 2, background: CHART_COLORS.tenkan, display: "inline-block" }} />
            Tenkan-sen
          </span>
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              fontSize: 12,
              color: "var(--color-muted)",
            }}
          >
            <span style={{ width: 10, height: 2, background: CHART_COLORS.kijun, display: "inline-block" }} />
            Kijun-sen
          </span>
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              fontSize: 12,
              color: "var(--color-muted)",
            }}
          >
            <span
              style={{
                width: 10,
                height: 2,
                background: CHART_COLORS.support,
                borderBottom: `1px dashed ${CHART_COLORS.support}`,
                display: "inline-block",
              }}
            />
            Support / Resistance
          </span>
          {candles.data && !candles.data.has_volume && (
            <span className="caption" style={{ color: "var(--color-muted-soft)", marginLeft: "auto" }}>
              Volume not available intraday for the index
            </span>
          )}
        </div>
        {candles.error ? (
          <ErrorCard
            message={`Could not load ${symbol} candles.`}
            onRetry={() => candles.mutate()}
          />
        ) : !analysis ? (
          <Skeleton height={420} />
        ) : (
          <CanvasChart draw={drawPrice} height={420} />
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div className="card-canvas" style={{ padding: "18px 22px" }}>
          <span className="caption">MACD (12, 26, 9)</span>
          {!analysis ? (
            <div style={{ marginTop: 6 }}>
              <Skeleton height={160} />
            </div>
          ) : (
            <div style={{ marginTop: 6 }}>
              <CanvasChart draw={drawMacd} height={160} />
            </div>
          )}
        </div>
        <div className="card-canvas" style={{ padding: "18px 22px" }}>
          <span className="caption">RSI (14)</span>
          {!analysis ? (
            <div style={{ marginTop: 6 }}>
              <Skeleton height={160} />
            </div>
          ) : (
            <div style={{ marginTop: 6 }}>
              <CanvasChart draw={drawRsi} height={160} />
            </div>
          )}
        </div>
      </div>

      {/* ── Volume analysis ─────────────────────────────────────────────── */}
      <div className="card-canvas" style={{ padding: "18px 22px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span className="caption">Volume analysis</span>
          {demand && <Badge className={demand.badgeClass}>{demand.label}</Badge>}
        </div>
        {isIndex && dtf !== "1d" ? (
          <p className="body-sm" style={{ margin: "10px 0 0 0", color: "var(--color-muted)" }}>
            The index has no intraday volume data — switch to Daily for volume analysis.
          </p>
        ) : !volume.session ? (
          <div style={{ marginTop: 10 }}>
            <Skeleton height={80} />
          </div>
        ) : (
          <>
            <div style={{ display: "flex", gap: 24, marginTop: 10 }}>
              <div className="well" style={{ flex: 1 }}>
                <div className="caption" style={{ marginBottom: 4 }}>
                  {dtf === "1d" ? "Today vs 20-session average" : "Session so far vs 10-session average"}
                </div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 18, color: "var(--color-ink)" }}>
                    {volume.session.rvol.toFixed(2)}×
                  </span>
                  <span className="caption" style={{ color: "var(--color-muted)" }}>
                    {fmtVolume(volume.session.sessionVolume)} vs {fmtVolume(volume.session.baselineVolume)}
                  </span>
                </div>
              </div>
              <div className="well" style={{ flex: 1 }}>
                <div className="caption" style={{ marginBottom: 4 }}>
                  Last bar vs its 20-bar average ({dtf})
                </div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 18, color: "var(--color-ink)" }}>
                    {volume.spike ? `${volume.spike.zScore >= 0 ? "+" : ""}${volume.spike.zScore.toFixed(1)}σ` : "—"}
                  </span>
                  {volume.spike && Math.abs(volume.spike.zScore) >= 2 && (
                    <span className="caption" style={{ color: "var(--color-warning)" }}>
                      unusual single-bar volume
                    </span>
                  )}
                </div>
              </div>
            </div>
            <p className="body-sm" style={{ margin: "10px 0 0 0", color: "var(--color-muted)" }}>
              {dtf === "1d"
                ? `Volume on ${volume.session.sessionDate} was ${volume.session.rvol.toFixed(2)}× the average of the prior ${volume.session.baselineSessions} sessions.`
                : `Cumulative volume on ${volume.session.sessionDate} is ${volume.session.rvol.toFixed(2)}× the average of the prior ${volume.session.baselineSessions} sessions at the same time of day — ${demand?.label.toLowerCase()}.`}
            </p>
          </>
        )}
      </div>

      <LlmAnalysisCard symbol={symbol} timeframe={dtf} input={llmInput} />

      <div className="card-canvas" style={{ padding: "18px 22px" }}>
        <span className="caption">Support &amp; resistance</span>
        <div style={{ display: "flex", gap: 24, marginTop: 8 }}>
          <div className="well" style={{ flex: 1 }}>
            <div className="caption" style={{ marginBottom: 4 }}>
              Resistance
            </div>
            <div style={{ fontFamily: "var(--font-mono)", color: "var(--color-error)", fontSize: 18 }}>
              {analysis ? fmtPrice(analysis.sr.resistance) : "—"}
            </div>
          </div>
          <div className="well" style={{ flex: 1 }}>
            <div className="caption" style={{ marginBottom: 4 }}>
              Support
            </div>
            <div style={{ fontFamily: "var(--font-mono)", color: "var(--color-info)", fontSize: 18 }}>
              {analysis ? fmtPrice(analysis.sr.support) : "—"}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
