"use client";

// AI trend read card, LLM-powered.
// Automatically displays scheduled backend analysis (8AM Pre-market / 1PM Mid-day)
// with the option to regenerate on-demand.

import { RefreshCw, Settings, Sparkles } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";

import { Badge } from "@/components/Badge";
import {
  type BackendAnalysis,
  type TradePlan,
  analysisKey,
  fetcher,
} from "@/lib/api";
import {
  type AnalysisInput,
  type AnalysisResult,
  buildAnalysisMessages,
  cachedAnalysis,
  chat,
  parseAnalysis,
  providerById,
  storeAnalysis,
  useLlmSettings,
} from "@/lib/llm";

const STANCE_BADGE: Record<string, string> = {
  bullish: "badge-success",
  bearish: "badge-error",
  neutral: "badge-default",
};

const SLOT_LABEL: Record<string, string> = {
  pre_market: "Pre-market (08:00 WIB)",
  mid_day: "Mid-day (13:00 WIB)",
  post_market: "Post-market (17:00 WIB)",
  ad_hoc: "On-demand",
};

const fmtLevel = (v: number) => v.toLocaleString("id-ID");

function TradePlanRow({ plan }: { plan: TradePlan }) {
  const riskPct = plan.risk_pct ?? null;
  const rewardPct = plan.reward_pct ?? null;

  const cells: { label: string; value: string; sub: string | null; color?: string }[] = [
    {
      label: "Entry",
      value: plan.entry != null ? fmtLevel(plan.entry) : "—",
      sub: plan.entry == null ? "no long setup" : null,
    },
    {
      label: "Stop loss",
      value: plan.stop != null ? fmtLevel(plan.stop) : "—",
      sub: riskPct != null ? `−${riskPct.toFixed(1)}%` : null,
      color: "var(--color-error)",
    },
    {
      label: "Target",
      value: plan.target != null ? fmtLevel(plan.target) : "—",
      sub: rewardPct != null ? `+${rewardPct.toFixed(1)}%` : null,
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
  const [localResult, setLocalResult] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch latest backend-generated analysis
  const backendSwr = useSWR<BackendAnalysis>(
    symbol ? analysisKey(symbol, timeframe) : null,
    fetcher,
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );

  // Load any local client-cached analysis
  useEffect(() => {
    setLocalResult(cachedAnalysis(symbol, timeframe));
    setError(null);
  }, [symbol, timeframe]);

  // Combine: prioritize freshly generated local result if newer than backend
  const activeAnalysis: (AnalysisResult | BackendAnalysis) | null = useMemo(() => {
    if (localResult && backendSwr.data) {
      const localTime = new Date(localResult.generatedAt).getTime();
      const backendTime = new Date(backendSwr.data.generated_at).getTime();
      return localTime >= backendTime ? localResult : backendSwr.data;
    }
    return localResult || backendSwr.data || null;
  }, [localResult, backendSwr.data]);

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
      setLocalResult(full);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  const stance = activeAnalysis?.stance ?? "neutral";
  const generatedAt =
    "generated_at" in (activeAnalysis || {})
      ? (activeAnalysis as BackendAnalysis).generated_at
      : (activeAnalysis as AnalysisResult | null)?.generatedAt;

  const slot = "slot" in (activeAnalysis || {}) ? (activeAnalysis as BackendAnalysis).slot : null;
  const model = activeAnalysis?.model ?? "";

  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Sparkles size={18} style={{ color: "var(--color-primary)" }} />
          <h5 style={{ margin: 0 }}>AI trend read</h5>
          {slot && (
            <span className="role-pill" style={{ fontSize: 11 }}>
              {SLOT_LABEL[slot] ?? slot}
            </span>
          )}
        </div>
        {activeAnalysis && (
          <Badge className={STANCE_BADGE[stance]}>
            {stance.charAt(0).toUpperCase() + stance.slice(1)}
          </Badge>
        )}
      </div>

      {!configured && !activeAnalysis ? (
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
          {activeAnalysis && (
            <>
              {activeAnalysis.summary && (
                <p className="body-sm" style={{ margin: 0 }}>
                  {activeAnalysis.summary}
                </p>
              )}
              {activeAnalysis.plan && <TradePlanRow plan={activeAnalysis.plan} />}
              {activeAnalysis.bullets && activeAnalysis.bullets.length > 0 && (
                <ul
                  style={{
                    margin: 0,
                    paddingLeft: 20,
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  {activeAnalysis.bullets.map((b) => (
                    <li key={b} className="body-sm">
                      {b}
                    </li>
                  ))}
                </ul>
              )}
              {activeAnalysis.risks && activeAnalysis.risks.length > 0 && (
                <div className="well" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="caption">Risks</span>
                  {activeAnalysis.risks.map((r) => (
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

          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            {configured && (
              <button
                className="btn btn-primary btn-sm"
                disabled={loading || !input}
                onClick={generate}
              >
                <RefreshCw size={14} className={loading ? "lx-spin" : undefined} />
                {loading ? "Analysing…" : activeAnalysis ? "Regenerate" : "Generate analysis"}
              </button>
            )}
            {generatedAt && (
              <span className="caption" style={{ color: "var(--color-muted-soft)" }}>
                {providerById(activeAnalysis?.model)?.label ?? model} ·{" "}
                {new Date(generatedAt).toLocaleString()}
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
