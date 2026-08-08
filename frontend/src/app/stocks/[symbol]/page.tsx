"use client";

import { ArrowLeft, Sparkles } from "lucide-react";
import Link from "next/link";
import { use, useCallback, useMemo, useState } from "react";
import useSWR from "swr";

import { Badge } from "@/components/Badge";
import { CanvasChart } from "@/components/CanvasChart";
import { ErrorCard } from "@/components/ErrorCard";
import { Skeleton } from "@/components/Skeleton";
import { TimeframeSwitcher } from "@/components/TimeframeSwitcher";
import { type CandlesOut, type SymbolOut, candlesKey, fetcher } from "@/lib/api";
import { CHART_COLORS, drawIndicatorPanel, drawPriceVolume } from "@/lib/chart-draw";
import { useDefaultTimeframe } from "@/lib/favorites";
import { aiSignal, ichimoku, macd, rsi, supportResistance } from "@/lib/indicators";
import { badgeClassForPct, fmtPct, fmtPrice, metricsFromDaily } from "@/lib/metrics";
import { type TimeframeId } from "@/lib/timeframes";

const REFRESH_MS = 60_000;

// Enough history that Ichimoku's 52-bar lookback has warmup beyond the window.
const DETAIL_LIMIT = 180;

export default function StockDetailPage({
  params,
}: {
  params: Promise<{ symbol: string }>;
}) {
  const { symbol: rawSymbol } = use(params);
  const symbol = decodeURIComponent(rawSymbol).toUpperCase();

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

  const drawPrice = useCallback(
    (canvas: HTMLCanvasElement) => {
      if (!analysis) return;
      drawPriceVolume(canvas, analysis.bars, {
        showVolume: false,
        cloud: analysis.ichi,
        hlines: [
          { value: analysis.sr.resistance, color: CHART_COLORS.resistance, label: "Resistance" },
          { value: analysis.sr.support, color: CHART_COLORS.support, label: "Support" },
        ],
      });
    },
    [analysis],
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

  const sigClass =
    analysis?.sig.stance === "bullish"
      ? "badge-success"
      : analysis?.sig.stance === "bearish"
        ? "badge-error"
        : "badge-default";

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
        </div>
        {candles.error ? (
          <ErrorCard
            message={`Could not load ${symbol} candles.`}
            onRetry={() => candles.mutate()}
          />
        ) : !analysis ? (
          <Skeleton height={380} />
        ) : (
          <CanvasChart draw={drawPrice} height={380} />
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

      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Sparkles size={18} style={{ color: "var(--color-primary)" }} />
            <h5 style={{ margin: 0 }}>AI trend read</h5>
          </div>
          {analysis && (
            <Badge className={sigClass}>
              {analysis.sig.stance.charAt(0).toUpperCase() + analysis.sig.stance.slice(1)}
            </Badge>
          )}
        </div>
        {!analysis ? (
          <Skeleton height={72} />
        ) : (
          <ul
            style={{
              margin: 0,
              paddingLeft: 20,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            {analysis.sig.reasons.map((reason) => (
              <li key={reason} className="body-sm">
                {reason}
              </li>
            ))}
          </ul>
        )}
        <span className="caption" style={{ color: "var(--color-muted-soft)" }}>
          Generated from indicator rules — not financial advice.
        </span>
      </div>

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
