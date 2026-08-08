"use client";

import { ExternalLink, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";

import { Badge } from "@/components/Badge";
import { ErrorCard } from "@/components/ErrorCard";
import { Skeleton } from "@/components/Skeleton";
import {
  type NewsItem,
  type NewsList,
  type NewsSummary,
  type SymbolOut,
  fetcher,
  newsKey,
} from "@/lib/api";

const REFRESH_MS = 300_000; // the backend cron runs every 30 min

const SENTIMENT_BADGE = {
  bullish: "badge-success",
  bearish: "badge-error",
  neutral: "badge-default",
} as const;

const WIB_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Jakarta",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function NewsRow({ item }: { item: NewsItem }) {
  const a = item.analysis;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "14px 4px",
        borderBottom: "1px solid var(--color-hairline-soft)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        {a ? (
          <Badge className={SENTIMENT_BADGE[a.sentiment]} small>
            {a.sentiment}
          </Badge>
        ) : (
          <span className="caption" style={{ color: "var(--color-muted-soft)" }}>
            pending analysis
          </span>
        )}
        {a && a.impact === "high" && (
          <Badge className="badge-warning" small>
            high impact
          </Badge>
        )}
        <span className="caption" style={{ color: "var(--color-muted-soft)" }}>
          {WIB_TIME.format(new Date(item.published_at))} WIB · {item.source} ·{" "}
          {item.feed_category}
        </span>
      </div>

      <a
        href={item.url}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          fontSize: 15,
          fontWeight: 500,
          color: "var(--color-ink)",
          textDecoration: "none",
          display: "inline-flex",
          alignItems: "baseline",
          gap: 6,
        }}
      >
        {item.title}
        <ExternalLink size={12} style={{ color: "var(--color-muted-soft)", flexShrink: 0 }} />
      </a>

      {a?.note && (
        <span className="body-sm" style={{ color: "var(--color-muted)" }}>
          {a.note}
        </span>
      )}

      {a && a.symbols.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {a.symbols.map((s) => (
            <Link
              key={s.symbol}
              href={`/stocks/${encodeURIComponent(s.symbol)}`}
              title={s.reason}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                padding: "2px 10px",
                borderRadius: 9999,
                fontSize: 11,
                fontWeight: 600,
                textDecoration: "none",
                background:
                  s.direction === "positive" ? "rgba(93,184,114,0.16)" : "rgba(198,69,69,0.14)",
                color: s.direction === "positive" ? "#3f8a4f" : "#9b3838",
              }}
            >
              {s.symbol} {s.direction === "positive" ? "▲" : "▼"}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export default function NewsPage() {
  const [sentiment, setSentiment] = useState<string | null>(null);
  const [symbol, setSymbol] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const summary = useSWR<NewsSummary>("/api/news/summary", fetcher, {
    refreshInterval: REFRESH_MS,
  });
  const news = useSWR<NewsList>(
    newsKey({ sentiment: sentiment ?? undefined, symbol: symbol ?? undefined, limit: 60 }),
    fetcher,
    { refreshInterval: REFRESH_MS },
  );
  const { data: symbols } = useSWR<SymbolOut[]>("/api/symbols?enabled=true", fetcher);

  async function refreshNow() {
    setRefreshing(true);
    try {
      await fetch("/api/news/refresh", { method: "POST" });
      // The cycle runs in the background; poll a couple of times for results.
      setTimeout(() => {
        news.mutate();
        summary.mutate();
      }, 4000);
      setTimeout(() => {
        news.mutate();
        summary.mutate();
        setRefreshing(false);
      }, 15000);
    } catch {
      setRefreshing(false);
    }
  }

  const s = summary.data;

  return (
    <div
      style={{
        maxWidth: 900,
        margin: "0 auto",
        padding: 32,
        display: "flex",
        flexDirection: "column",
        gap: 24,
      }}
    >
      {/* ── Sentiment summary ─────────────────────────────────────────── */}
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <h5 style={{ margin: 0 }}>Market sentiment from news</h5>
            {s && (
              <span className="caption" style={{ color: "var(--color-muted-soft)" }}>
                last {s.window_hours}h
              </span>
            )}
          </div>
          {s && <Badge className={SENTIMENT_BADGE[s.lean]}>{s.lean}</Badge>}
        </div>

        {!s ? (
          <Skeleton height={48} />
        ) : (
          <>
            <div
              style={{
                display: "flex",
                height: 6,
                borderRadius: 9999,
                overflow: "hidden",
                background: "var(--color-surface-cream-strong)",
              }}
            >
              {(() => {
                const total = s.bullish + s.neutral + s.bearish || 1;
                return (
                  <>
                    <div style={{ width: `${(s.bullish / total) * 100}%`, background: "var(--color-success)" }} />
                    <div style={{ width: `${(s.neutral / total) * 100}%`, background: "var(--color-muted-soft)" }} />
                    <div style={{ width: `${(s.bearish / total) * 100}%`, background: "var(--color-error)" }} />
                  </>
                );
              })()}
            </div>
            <span className="caption">
              {s.bullish} bullish · {s.neutral} neutral · {s.bearish} bearish
              {s.pending_analysis > 0 ? ` · ${s.pending_analysis} awaiting analysis` : ""}
            </span>
            {s.top_symbols.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                <span className="caption" style={{ color: "var(--color-muted-soft)" }}>
                  Most mentioned:
                </span>
                {s.top_symbols.map((t) => (
                  <Link
                    key={t.symbol}
                    href={`/stocks/${encodeURIComponent(t.symbol)}`}
                    className="role-pill"
                    style={{ textDecoration: "none", fontSize: 11 }}
                  >
                    {t.symbol} ×{t.mentions}
                  </Link>
                ))}
              </div>
            )}
          </>
        )}

        {s && !s.analysis_enabled && (
          <div className="warning-banner" style={{ padding: "12px 14px" }}>
            <span style={{ fontSize: 13 }}>
              LLM analysis is disabled — news is fetched but not classified. Set{" "}
              <code style={{ fontSize: 12 }}>LLM_PROVIDER / LLM_MODEL / LLM_API_KEY</code> in the
              backend .env and restart the worker.
            </span>
          </div>
        )}
      </div>

      {/* ── Filters ───────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div
          style={{
            display: "flex",
            gap: 6,
            background: "var(--color-surface-card)",
            padding: 4,
            borderRadius: 10,
          }}
        >
          {[null, "bullish", "neutral", "bearish"].map((v) => (
            <button
              key={v ?? "all"}
              onClick={() => setSentiment(v)}
              style={{
                height: 30,
                padding: "0 12px",
                borderRadius: 8,
                border: "none",
                fontSize: 13,
                fontWeight: 500,
                cursor: "pointer",
                background: sentiment === v ? "var(--color-primary)" : "transparent",
                color: sentiment === v ? "#fff" : "var(--color-body)",
              }}
            >
              {v ?? "All"}
            </button>
          ))}
        </div>

        <select
          className="select"
          style={{ width: 200, height: 36 }}
          value={symbol ?? ""}
          onChange={(e) => setSymbol(e.target.value || null)}
        >
          <option value="">All stocks</option>
          {(symbols ?? []).map((sym) => (
            <option key={sym.symbol} value={sym.symbol}>
              {sym.symbol}
            </option>
          ))}
        </select>

        <div style={{ flex: 1 }} />
        <button className="btn btn-secondary btn-sm" disabled={refreshing} onClick={refreshNow}>
          <RefreshCw size={13} className={refreshing ? "lx-spin" : undefined} />
          {refreshing ? "Fetching…" : "Refresh now"}
        </button>
      </div>

      {/* ── Feed ──────────────────────────────────────────────────────── */}
      <div className="card-canvas" style={{ padding: "8px 24px" }}>
        {news.error ? (
          <ErrorCard message="Could not load news." onRetry={() => news.mutate()} />
        ) : !news.data ? (
          <div style={{ padding: 16 }}>
            <Skeleton height={200} />
          </div>
        ) : news.data.items.length === 0 ? (
          <p className="body-sm" style={{ color: "var(--color-muted)", padding: 16 }}>
            Nothing here yet — the worker fetches feeds every 30 minutes, or hit Refresh now.
          </p>
        ) : (
          news.data.items.map((item) => <NewsRow key={item.url} item={item} />)
        )}
      </div>

      <span className="caption" style={{ color: "var(--color-muted-soft)" }}>
        Sources: Antara, CNBC Indonesia, Detik Finance, Kontan, Google News (energy · politics ·
        finance). Sentiment is LLM-classified from headlines — not financial advice.
      </span>
    </div>
  );
}
