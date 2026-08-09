"use client";

// Asset allocation donut: one slice per position plus a neutral cash slice.
// Color follows the entity (alphabetical slot order), so slices don't repaint
// when values fluctuate. The legend is always shown — several series colors
// sit below 3:1 contrast on the cream surface, and the legend is the relief.

import { useState } from "react";

import { type Portfolio } from "@/lib/portfolio";
import { annulusPath, computeSlices } from "@/lib/donut-math";

const SERIES_VARS = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `var(--color-chart-${i})`);
const CASH_LABEL = "Cash";
const MAX_SLICES = 8;

const fmtIdr = (v: number) => v.toLocaleString("id-ID", { maximumFractionDigits: 0 });

export function AllocationDonut({ portfolio }: { portfolio: Portfolio }) {
  const [hovered, setHovered] = useState<string | null>(null);

  // Color slot follows the backend's alphabetical position order.
  const colorBySymbol = new Map<string, string>(
    portfolio.positions.map((p, i) => [p.symbol, SERIES_VARS[i % SERIES_VARS.length]]),
  );

  let anyUnpriced = false;
  let items = portfolio.positions.map((p) => {
    if (p.market_value == null) anyUnpriced = true;
    return { label: p.symbol, value: p.market_value ?? p.cost };
  });

  if (items.length > MAX_SLICES) {
    const ranked = [...items].sort((a, b) => b.value - a.value);
    const keep = new Set(ranked.slice(0, MAX_SLICES).map((i) => i.label));
    const otherTotal = items.filter((i) => !keep.has(i.label)).reduce((s, i) => s + i.value, 0);
    items = [...items.filter((i) => keep.has(i.label)), { label: "Other", value: otherTotal }];
  }
  if (portfolio.cash > 0) items.push({ label: CASH_LABEL, value: portfolio.cash });

  const slices = computeSlices(items);
  const totalAssets = portfolio.totals.market_value + portfolio.cash;

  if (slices.length === 0) {
    return (
      <p className="caption" style={{ margin: "8px 0 0", color: "var(--color-muted)" }}>
        Add positions or cash to see your allocation.
      </p>
    );
  }

  const colorFor = (label: string): string => {
    if (label === CASH_LABEL) return "var(--color-chart-cash)";
    if (label === "Other") return "var(--color-chart-other)";
    return colorBySymbol.get(label) ?? "var(--color-chart-other)";
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
      <div style={{ position: "relative", width: 180, height: 180 }}>
        <svg viewBox="0 0 200 200" width={180} height={180} role="img" aria-label="Asset allocation">
          {slices.map((s) => (
            <path
              key={s.label}
              d={annulusPath(100, 100, 90, 62, s.startAngle, s.endAngle)}
              fill={colorFor(s.label)}
              stroke="var(--color-surface-card)"
              strokeWidth={2}
              opacity={hovered !== null && hovered !== s.label ? 0.35 : 1}
              onMouseEnter={() => setHovered(s.label)}
              onMouseLeave={() => setHovered(null)}
            >
              <title>{`${s.label}: Rp ${fmtIdr(s.value)} (${s.pct.toFixed(1)}%)`}</title>
            </path>
          ))}
        </svg>
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
            textAlign: "center",
          }}
        >
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 15, color: "var(--color-ink)" }}>
            Rp {fmtIdr(totalAssets)}
          </span>
          <span className="caption" style={{ color: "var(--color-muted)" }}>
            Total assets
          </span>
        </div>
      </div>

      <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 4 }}>
        {slices.map((s) => (
          <div
            key={s.label}
            style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}
            onMouseEnter={() => setHovered(s.label)}
            onMouseLeave={() => setHovered(null)}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 3,
                background: colorFor(s.label),
                flexShrink: 0,
              }}
            />
            <span style={{ color: "var(--color-body)", flex: 1, minWidth: 0 }}>{s.label}</span>
            <span className="mono" style={{ color: "var(--color-muted)", fontSize: 12 }}>
              {s.pct.toFixed(1)}%
            </span>
            <span
              className="mono"
              style={{ color: "var(--color-muted)", fontSize: 12, minWidth: 90, textAlign: "right" }}
            >
              Rp {fmtIdr(s.value)}
            </span>
          </div>
        ))}
      </div>

      {anyUnpriced && (
        <span className="caption" style={{ color: "var(--color-muted-soft)", alignSelf: "flex-start" }}>
          Positions without a stored price are shown at cost.
        </span>
      )}
    </div>
  );
}
