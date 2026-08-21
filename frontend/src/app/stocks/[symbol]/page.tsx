"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { use, useCallback, useEffect, useMemo, useState } from "react";
import useSWR from "swr";

import { Badge } from "@/components/Badge";
import { ErrorCard } from "@/components/ErrorCard";
import { type ChartView, InteractiveChart } from "@/components/InteractiveChart";
import { LlmAnalysisCard } from "@/components/LlmAnalysisCard";
import { RelatedNewsCard } from "@/components/RelatedNewsCard";
import { ScorecardCard } from "@/components/ScorecardCard";
import { Skeleton } from "@/components/Skeleton";
import { TimeframeSwitcher } from "@/components/TimeframeSwitcher";
import { type CandlesOut, type SymbolOut, IHSG_SYMBOL, candlesKey, fetcher } from "@/lib/api";
import { CHART_COLORS, drawPriceVolume, drawVolumePanel } from "@/lib/chart-draw";
import { useDefaultTimeframe } from "@/lib/favorites";
import {
  aiSignal,
  atr,
  correlation,
  ichimoku,
  macd,
  returns,
  rsi,
  supportResistance,
} from "@/lib/indicators";
import type { AnalysisInput } from "@/lib/llm";
import { badgeClassForPct, fmtPct, fmtPrice, metricsFromDaily } from "@/lib/metrics";
import { computeScorecard } from "@/lib/signals";
import { type TimeframeId } from "@/lib/timeframes";
import { type XViewport } from "@/lib/viewport";
import { classifyRvol, dailyRvol, fmtVolume, sessionRvol, volumeSpike } from "@/lib/volume";

const REFRESH_MS = 60_000;

// Fetched depth (roomy, for zooming out); the initial view shows the last 180
// bars so Ichimoku's 52-bar lookback still has warmup beyond the window.
const DETAIL_LIMIT = 400;
const INITIAL_DETAIL_VIEW = 180;

/** Overlay toggles persisted alongside the other UI prefs. Default: shown. */
function useOverlayPref(key: string): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(true);
  useEffect(() => {
    setValue(localStorage.getItem(key) !== "0");
  }, [key]);
  const set = (v: boolean) => {
    localStorage.setItem(key, v ? "1" : "0");
    setValue(v);
  };
  return [value, set];
}

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

  // Shared X viewport across the price, MACD, and RSI charts.
  const [viewport, setViewport] = useState<XViewport>({
    offset: 0,
    count: INITIAL_DETAIL_VIEW,
  });
  const [overlayRsi, setOverlayRsi] = useOverlayPref("lixionary.overlay.rsi");
  const [overlayMacd, setOverlayMacd] = useOverlayPref("lixionary.overlay.macd");

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
    const scorecard = computeScorecard(bars, { ichimoku: ichi, macd: macdRes, rsi: rsiArr, sr });
    const atrArr = atr(bars);
    return { bars, ichi, sr, macdRes, rsiArr, sig, scorecard, atr: atrArr[atrArr.length - 1] };
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
      atr: analysis.atr,
      heuristic: analysis.sig,
      scorecard: analysis.scorecard,
      sessionVolume: volume.session,
      volumeSpike: volume.spike,
      ihsgCorrelation: ihsgCorr,
    };
  }, [analysis, m, symbol, meta, dtf, volume, ihsgCorr]);

  const intraday = dtf !== "1d";
  const totalBars = analysis?.bars.length ?? 0;
  const onViewportChange = useCallback((v: XViewport) => setViewport(v), []);

  const drawPrice = useCallback(
    (canvas: HTMLCanvasElement, view: ChartView) => {
      if (!analysis || !candles.data) return;
      drawPriceVolume(canvas, analysis.bars, {
        showVolume: false, // volume lives in its own detached panel below
        cloud: analysis.ichi,
        hlines: [
          { value: analysis.sr.resistance, color: CHART_COLORS.resistance, label: "Resistance" },
          { value: analysis.sr.support, color: CHART_COLORS.support, label: "Support" },
        ],
        viewport: view.viewport,
        yState: view.yState,
        cursor: view.cursor,
        intraday,
        overlays: {
          rsi: overlayRsi ? analysis.rsiArr : undefined,
          macdLine: overlayMacd ? analysis.macdRes.line : undefined,
          macdSignal: overlayMacd ? analysis.macdRes.signal : undefined,
        },
      });
    },
    [analysis, candles.data, intraday, overlayRsi, overlayMacd],
  );

  const drawVolume = useCallback(
    (canvas: HTMLCanvasElement, view: ChartView) => {
      if (!analysis) return;
      drawVolumePanel(canvas, analysis.bars, {
        viewport: view.viewport,
        yState: view.yState,
        cursor: view.cursor,
        intraday,
      });
    },
    [analysis, intraday],
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
        <TimeframeSwitcher
          value={dtf}
          onChange={(next) => {
            setTfOverride(next);
            setViewport({ offset: 0, count: INITIAL_DETAIL_VIEW });
          }}
        />
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
          <span className="caption">Price · Ichimoku cloud · support &amp; resistance</span>
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
          {overlayRsi && (
            <span
              style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--color-muted)" }}
            >
              <span style={{ width: 10, height: 2, background: CHART_COLORS.primary, display: "inline-block" }} />
              RSI
            </span>
          )}
          {overlayMacd && (
            <span
              style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--color-muted)" }}
            >
              <span style={{ width: 10, height: 2, background: "#d4a017", display: "inline-block" }} />
              MACD
            </span>
          )}
          <span style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
            <OverlayChip label="RSI" active={overlayRsi} onToggle={() => setOverlayRsi(!overlayRsi)} />
            <OverlayChip label="MACD" active={overlayMacd} onToggle={() => setOverlayMacd(!overlayMacd)} />
          </span>
          {candles.data && !candles.data.has_volume && (
            <span className="caption" style={{ color: "var(--color-muted-soft)" }}>
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
          <Skeleton height={380} />
        ) : (
          <InteractiveChart
            draw={drawPrice}
            height={380}
            barCount={totalBars}
            viewport={viewport}
            onViewportChange={onViewportChange}
          />
        )}
      </div>

      {candles.data?.has_volume && (
        <div className="card-canvas" style={{ padding: "18px 22px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span className="caption">Volume · {dtf}</span>
            <span className="caption" style={{ color: "var(--color-muted-soft)" }}>
              X follows the price chart · shift+scroll to zoom, drag to pan vertically
            </span>
          </div>
          {!analysis ? (
            <div style={{ marginTop: 6 }}>
              <Skeleton height={150} />
            </div>
          ) : (
            <div style={{ marginTop: 6 }}>
              <InteractiveChart
                draw={drawVolume}
                height={150}
                barCount={totalBars}
                viewport={viewport}
                onViewportChange={onViewportChange}
              />
            </div>
          )}
        </div>
      )}

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

      {analysis && <ScorecardCard scorecard={analysis.scorecard} timeframe={dtf} />}

      <RelatedNewsCard symbol={symbol} />

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

function OverlayChip({
  label,
  active,
  onToggle,
}: {
  label: string;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      title={active ? `Remove ${label} from the price chart` : `Superpose ${label} onto the price chart`}
      style={{
        height: 24,
        padding: "0 10px",
        borderRadius: 9999,
        border: "1px solid " + (active ? "var(--color-primary)" : "var(--color-hairline)"),
        background: active ? "var(--color-primary)" : "var(--color-canvas)",
        color: active ? "#fff" : "var(--color-muted)",
        fontSize: 11,
        fontWeight: 600,
        cursor: "pointer",
        transition: "background 120ms ease, color 120ms ease",
      }}
    >
      {label}
    </button>
  );
}
