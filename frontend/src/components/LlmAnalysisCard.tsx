"use client";

// AI trend read card, LLM-powered. States: disabled (no config) → idle →
// loading → result | error. Results are cached per symbol+timeframe so
// navigation doesn't burn API credit.

import { RefreshCw, Settings, Sparkles } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { Badge } from "@/components/Badge";
import {
  type AnalysisInput,
  type AnalysisResult,
  type TradePlan,
  buildAnalysisMessages,
  cachedAnalysis,
  chat,
  parseAnalysis,
  providerById,
  storeAnalysis,
  useLlmSettings,
} from "@/lib/llm";

const STANCE_BADGE: Record<AnalysisResult["stance"], string> = {
  bullish: "badge-success",
  bearish: "badge-error",
  neutral: "badge-default",
};

const fmtLevel = (v: number) => v.toLocaleString("id-ID");

/**
 * Entry / stop / target, snapped to IDX ticks upstream so every number shown is
 * one an order can actually be placed at.
 */
function TradePlanRow({ plan }: { plan: TradePlan }) {
  const cells: { label: string; value: string; sub: string | null; color?: string }[] = [
    {
      label: "Entry",
      value: plan.entry != null ? fmtLevel(plan.entry) : "—",
      sub: plan.entry == null ? "no long setup" : null,
    },
    {
      label: "Stop loss",
      value: plan.stop != null ? fmtLevel(plan.stop) : "—",
      sub: plan.riskPct != null ? `−${plan.riskPct.toFixed(1)}%` : null,
      color: "var(--color-error)",
    },
    {
      label: "Target",
      value: plan.target != null ? fmtLevel(plan.target) : "—",
      sub: plan.rewardPct != null ? `+${plan.rewardPct.toFixed(1)}%` : null,
      color: "var(--color-success)",
    },
  ];

  return (
    <div className="well" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <span className="caption">Levels</span>
        {plan.rr != null && (
          <span className="caption" style={{ color: "var(--color-muted)" }}>
            Reward:risk {plan.rr.toFixed(1)}:1
          </span>
        )}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
        {cells.map((c) => (
          <div key={c.label} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span className="caption">{c.label}</span>
            <span
              className="mono"
              style={{ fontSize: 15, color: c.value === "—" ? "var(--color-muted-soft)" : c.color }}
            >
              {c.value}
            </span>
            {c.sub && (
              <span className="caption" style={{ color: "var(--color-muted-soft)" }}>
                {c.sub}
              </span>
            )}
          </div>
        ))}
      </div>
      {plan.basis && (
        <span className="caption" style={{ color: "var(--color-muted)" }}>
          {plan.basis}
        </span>
      )}
    </div>
  );
}

export function LlmAnalysisCard({
  symbol,
  timeframe,
  input,
}: {
  symbol: string;
  timeframe: string;
  /** Null while chart data is still loading. */
  input: AnalysisInput | null;
}) {
  const { settings, configured } = useLlmSettings();
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the cached analysis for this symbol+timeframe on mount/switch.
  useEffect(() => {
    setResult(cachedAnalysis(symbol, timeframe));
    setError(null);
  }, [symbol, timeframe]);

  async function generate() {
    if (!input || loading) return;
    setLoading(true);
    setError(null);
    try {
      const raw = await chat(settings, buildAnalysisMessages(input));
      const parsed = parseAnalysis(raw, input.price);
      const full: AnalysisResult = {
        ...parsed,
        generatedAt: new Date().toISOString(),
        provider: settings.provider,
        model: settings.model,
      };
      storeAnalysis(symbol, timeframe, full);
      setResult(full);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Sparkles size={18} style={{ color: "var(--color-primary)" }} />
          <h5 style={{ margin: 0 }}>AI trend read</h5>
        </div>
        {result && (
          <Badge className={STANCE_BADGE[result.stance]}>
            {result.stance.charAt(0).toUpperCase() + result.stance.slice(1)}
          </Badge>
        )}
      </div>

      {!configured ? (
        <div
          className="well"
          style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "space-between" }}
        >
          <span className="body-sm" style={{ color: "var(--color-muted)" }}>
            AI analysis is disabled — missing LLM configuration.
          </span>
          <Link href="/settings" className="btn btn-secondary btn-sm" style={{ textDecoration: "none" }}>
            <Settings size={14} /> Configure
          </Link>
        </div>
      ) : (
        <>
          {result && (
            <>
              {result.summary && <p className="body-sm" style={{ margin: 0 }}>{result.summary}</p>}
              {result.plan && <TradePlanRow plan={result.plan} />}
              {result.bullets.length > 0 && (
                <ul
                  style={{
                    margin: 0,
                    paddingLeft: 20,
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  {result.bullets.map((b) => (
                    <li key={b} className="body-sm">
                      {b}
                    </li>
                  ))}
                </ul>
              )}
              {result.risks.length > 0 && (
                <div className="well" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="caption">Risks</span>
                  {result.risks.map((r) => (
                    <span key={r} className="body-sm">
                      {r}
                    </span>
                  ))}
                </div>
              )}
            </>
          )}

          {error && (
            <span className="caption" style={{ color: "var(--color-error)" }}>
              Analysis failed: {error}
            </span>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button
              className="btn btn-primary btn-sm"
              disabled={loading || !input}
              onClick={generate}
            >
              <RefreshCw size={14} className={loading ? "lx-spin" : undefined} />
              {loading ? "Analysing…" : result ? "Regenerate" : "Generate analysis"}
            </button>
            {result && (
              <span className="caption" style={{ color: "var(--color-muted-soft)" }}>
                {providerById(result.provider)?.label ?? result.provider} · {result.model} ·{" "}
                {new Date(result.generatedAt).toLocaleString()}
              </span>
            )}
          </div>
        </>
      )}

      <span className="caption" style={{ color: "var(--color-muted-soft)" }}>
        Generated by an LLM from indicator data — not financial advice.
      </span>
    </div>
  );
}
