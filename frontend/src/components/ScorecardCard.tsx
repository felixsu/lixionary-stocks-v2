"use client";

import { Gauge } from "lucide-react";

import { Badge } from "@/components/Badge";
import type { Scorecard, Verdict } from "@/lib/signals";

const VERDICT_BADGE: Record<Verdict, string> = {
  bullish: "badge-success",
  bearish: "badge-error",
  neutral: "badge-default",
  na: "badge-default",
};

const VERDICT_LABEL: Record<Verdict, string> = {
  bullish: "Bullish",
  bearish: "Bearish",
  neutral: "Neutral",
  na: "n/a",
};

export function ScorecardCard({ scorecard, timeframe }: { scorecard: Scorecard; timeframe: string }) {
  const { signals, bullish, neutral, bearish, overall } = scorecard;
  const counted = bullish + neutral + bearish || 1;

  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Gauge size={18} style={{ color: "var(--color-primary)" }} />
          <h5 style={{ margin: 0 }}>Technical scorecard</h5>
          <span className="caption" style={{ color: "var(--color-muted-soft)" }}>
            {timeframe}
          </span>
        </div>
        <Badge className={VERDICT_BADGE[overall]}>{VERDICT_LABEL[overall]}</Badge>
      </div>

      {/* Proportion bar + counts */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div
          style={{
            display: "flex",
            height: 6,
            borderRadius: 9999,
            overflow: "hidden",
            background: "var(--color-surface-cream-strong)",
          }}
        >
          <div style={{ width: `${(bullish / counted) * 100}%`, background: "var(--color-success)" }} />
          <div style={{ width: `${(neutral / counted) * 100}%`, background: "var(--color-muted-soft)" }} />
          <div style={{ width: `${(bearish / counted) * 100}%`, background: "var(--color-error)" }} />
        </div>
        <span className="caption">
          {bullish} bullish · {neutral} neutral · {bearish} bearish
          {signals.some((s) => s.verdict === "na") ? " · some unavailable" : ""}
        </span>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "0 24px",
        }}
      >
        {signals.map((s) => (
          <div
            key={s.id}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              padding: "10px 0",
              borderBottom: "1px solid var(--color-hairline-soft)",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: "var(--color-ink)" }}>{s.name}</div>
              <div className="caption" style={{ color: "var(--color-muted)", marginTop: 1 }}>
                {s.detail}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--color-body-strong)" }}>
                {s.value}
              </span>
              <span style={{ width: 64, display: "flex", justifyContent: "flex-end" }}>
                {s.verdict === "na" ? (
                  <span className="caption" style={{ color: "var(--color-muted-soft)" }}>
                    n/a
                  </span>
                ) : (
                  <Badge className={VERDICT_BADGE[s.verdict]} small>
                    {VERDICT_LABEL[s.verdict]}
                  </Badge>
                )}
              </span>
            </div>
          </div>
        ))}
      </div>

      <span className="caption" style={{ color: "var(--color-muted-soft)" }}>
        Rule-based reads on the selected timeframe — not financial advice.
      </span>
    </div>
  );
}
