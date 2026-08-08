"use client";

import { GitCompare, Minimize2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";

import { Badge } from "@/components/Badge";
import { CanvasChart } from "@/components/CanvasChart";
import { ErrorCard } from "@/components/ErrorCard";
import { Skeleton } from "@/components/Skeleton";
import { TimeframeSwitcher } from "@/components/TimeframeSwitcher";
import {
  type Bar,
  type CandlesOut,
  type SymbolOut,
  IHSG_SYMBOL,
  candlesKey,
  fetcher,
} from "@/lib/api";
import { drawPriceVolume } from "@/lib/chart-draw";
import { useDefaultTimeframe, useFavorites } from "@/lib/favorites";
import { correlation, returns } from "@/lib/indicators";
import {
  badgeClassForPct,
  badgeClassForRsi,
  badgeClassForVol,
  fmtPct,
  fmtPrice,
  metricsFromDaily,
} from "@/lib/metrics";
import { type TimeframeId, timeframeLabel } from "@/lib/timeframes";

const REFRESH_MS = 60_000;

// Bars shown per timeframe — matches the design prototype's visual density.
const CHART_LIMITS: Record<TimeframeId, number> = { "5m": 66, "1h": 42, "2h": 32, "1d": 130 };

function useCandles(symbol: string | null, timeframe: TimeframeId) {
  return useSWR<CandlesOut>(
    symbol ? candlesKey(symbol, timeframe, CHART_LIMITS[timeframe]) : null,
    fetcher,
    { refreshInterval: REFRESH_MS },
  );
}

/** Intersect two bar series on timestamp so overlay/correlation stay aligned
 *  even when the API returns slightly different bar counts. */
function alignSeries(stock: Bar[], index: Bar[]): { stock: Bar[]; indexCloses: number[] } {
  const byTs = new Map(index.map((b) => [b.ts, b]));
  const alignedStock: Bar[] = [];
  const indexCloses: number[] = [];
  for (const bar of stock) {
    const match = byTs.get(bar.ts);
    if (match) {
      alignedStock.push(bar);
      indexCloses.push(match.c);
    }
  }
  return { stock: alignedStock, indexCloses };
}

function FavoriteCard({
  code,
  name,
  expanded,
  onToggleExpand,
}: {
  code: string;
  name: string;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const router = useRouter();
  const { data, error } = useSWR<CandlesOut>(candlesKey(code, "1d", 40), fetcher, {
    refreshInterval: REFRESH_MS,
  });

  const m = data ? metricsFromDaily(data.bars) : null;
  const ExpandIcon = expanded ? Minimize2 : GitCompare;

  return (
    <div
      className="card"
      style={{ cursor: "pointer", transition: "background 100ms ease" }}
      onClick={() => router.push(`/stocks/${encodeURIComponent(code)}`)}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontWeight: 500, color: "var(--color-ink)", fontSize: 15 }}>{code}</div>
          <div className="caption" style={{ marginTop: 1 }}>
            {name}
          </div>
        </div>
        <button
          className="btn-icon"
          style={{ width: 30, height: 30 }}
          title="Compare with IHSG"
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand();
          }}
        >
          <ExpandIcon size={15} />
        </button>
      </div>

      {error ? (
        <div className="caption" style={{ marginTop: 14, color: "var(--color-error)" }}>
          Failed to load
        </div>
      ) : !m ? (
        <div style={{ marginTop: 14 }}>
          <Skeleton height={64} />
        </div>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 14 }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 20, color: "var(--color-ink)" }}>
              {fmtPrice(m.price)}
            </span>
            <Badge className={badgeClassForPct(m.pct)}>{fmtPct(m.pct)}</Badge>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 14 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                fontSize: 12,
                color: "var(--color-muted)",
              }}
            >
              <span>Day range</span>
              <span style={{ fontFamily: "var(--font-mono)", color: "var(--color-body-strong)" }}>
                {fmtPrice(m.dayLow)} – {fmtPrice(m.dayHigh)}
              </span>
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                fontSize: 12,
                color: "var(--color-muted)",
              }}
            >
              <span>Vol vs 20d avg</span>
              <Badge className={badgeClassForVol(m.volDelta)} small>
                {m.volDelta == null ? "—" : `${m.volDelta >= 0 ? "+" : ""}${m.volDelta.toFixed(0)}%`}
              </Badge>
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                fontSize: 12,
                color: "var(--color-muted)",
              }}
            >
              <span>RSI (14)</span>
              <Badge className={badgeClassForRsi(m.rsi)} small>
                {m.rsi == null ? "—" : m.rsi.toFixed(0)}
              </Badge>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default function DashboardPage() {
  const { favorites } = useFavorites();
  const { defaultTimeframe } = useDefaultTimeframe();
  const [tfOverride, setTfOverride] = useState<TimeframeId | null>(null);
  const [expandedCode, setExpandedCode] = useState<string | null>(null);
  const tf = tfOverride ?? defaultTimeframe;

  const { data: symbols } = useSWR<SymbolOut[]>("/api/symbols", fetcher, {
    refreshInterval: REFRESH_MS,
  });
  const nameOf = useCallback(
    (code: string) => symbols?.find((s) => s.symbol === code)?.name ?? code,
    [symbols],
  );

  const ihsg = useCandles(IHSG_SYMBOL, tf);
  const ihsgDaily = useSWR<CandlesOut>(candlesKey(IHSG_SYMBOL, "1d", 5), fetcher, {
    refreshInterval: REFRESH_MS,
  });
  const expanded = useCandles(expandedCode, tf);

  const ihsgMetrics = ihsgDaily.data ? metricsFromDaily(ihsgDaily.data.bars) : null;

  const comparison = useMemo(() => {
    if (!expanded.data?.bars.length || !ihsg.data?.bars.length) return null;
    const { stock, indexCloses } = alignSeries(expanded.data.bars, ihsg.data.bars);
    if (stock.length < 2) return null;
    const corr = correlation(
      returns(stock.map((b) => b.c)),
      returns(indexCloses),
    );
    return { bars: stock, indexCloses, corr };
  }, [expanded.data, ihsg.data]);

  const drawIhsg = useCallback(
    (canvas: HTMLCanvasElement) => {
      if (!ihsg.data) return;
      drawPriceVolume(canvas, ihsg.data.bars, { showVolume: ihsg.data.has_volume });
    },
    [ihsg.data],
  );

  const drawComparison = useCallback(
    (canvas: HTMLCanvasElement) => {
      if (!comparison) return;
      drawPriceVolume(canvas, comparison.bars, {
        showVolume: false,
        compareSeries: comparison.indexCloses,
      });
    },
    [comparison],
  );

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
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div className="eyebrow">IHSG · Composite Index</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 4 }}>
            {ihsgMetrics ? (
              <>
                <span
                  style={{ fontFamily: "var(--font-mono)", fontSize: 32, color: "var(--color-ink)" }}
                >
                  {fmtPrice(ihsgMetrics.price)}
                </span>
                <Badge className={badgeClassForPct(ihsgMetrics.pct)}>
                  {fmtPct(ihsgMetrics.pct)}
                </Badge>
              </>
            ) : (
              <Skeleton height={40} />
            )}
          </div>
        </div>
        <TimeframeSwitcher
          value={tf}
          onChange={(next) => setTfOverride(next)}
        />
      </div>

      <div className="card-canvas" style={{ padding: "20px 24px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 8,
          }}
        >
          <span className="caption">IHSG · {timeframeLabel(tf)}</span>
          {ihsg.data && !ihsg.data.has_volume && (
            <span className="caption" style={{ color: "var(--color-muted-soft)" }}>
              Volume not available intraday for the index
            </span>
          )}
        </div>
        {ihsg.error ? (
          <ErrorCard message="Could not load IHSG data." onRetry={() => ihsg.mutate()} />
        ) : !ihsg.data ? (
          <Skeleton height={340} />
        ) : (
          <CanvasChart draw={drawIhsg} height={340} />
        )}
      </div>

      {expandedCode && (
        <div className="card-canvas" style={{ padding: "20px 24px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 8,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span className="caption">
                {expandedCode} — {nameOf(expandedCode)} · {timeframeLabel(tf)} · compared to IHSG
              </span>
              {comparison && (
                <span className="badge badge-default">
                  correlation {comparison.corr.toFixed(2)}
                </span>
              )}
            </div>
            <button
              className="btn-ghost btn-sm"
              style={{ height: 28, padding: "0 8px" }}
              onClick={() => setExpandedCode(null)}
            >
              Close
            </button>
          </div>
          {!comparison ? <Skeleton height={220} /> : <CanvasChart draw={drawComparison} height={220} />}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h5 style={{ margin: 0 }}>Your stockpicks</h5>
        <a href="/settings" style={{ fontSize: 13, textDecoration: "none" }}>
          Manage favorites
        </a>
      </div>

      {favorites.length === 0 ? (
        <div
          className="card-canvas"
          style={{ padding: 32, textAlign: "center", color: "var(--color-muted)" }}
        >
          <p className="body-sm" style={{ margin: 0 }}>
            No favorites yet — pick up to 10 stocks in{" "}
            <a href="/settings">Settings</a> to see them here.
          </p>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
          {favorites.map((code) => (
            <FavoriteCard
              key={code}
              code={code}
              name={nameOf(code)}
              expanded={expandedCode === code}
              onToggleExpand={() =>
                setExpandedCode((cur) => (cur === code ? null : code))
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
