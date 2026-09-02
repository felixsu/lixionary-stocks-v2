"use client";

import { Check, Eye, EyeOff, Pencil, Plus, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";

import { AllocationDonut } from "@/components/AllocationDonut";
import { Badge } from "@/components/Badge";
import { ErrorCard } from "@/components/ErrorCard";
import { Skeleton } from "@/components/Skeleton";
import { type SymbolOut, fetcher } from "@/lib/api";
import { useLlmSettings } from "@/lib/llm";
import {
  type Portfolio,
  type Position,
  type Recommendation,
  generateRecommendations,
  portfolioApi,
} from "@/lib/portfolio";
import { IDR_PRICE_MAX, IDR_PRICE_MIN, parseIdrNumber } from "@/lib/parse-idr";
import { analyzePositions } from "@/lib/position-analysis";
import { masked, maskedPlain, useHideAmounts } from "@/lib/privacy";

const REFRESH_MS = 60_000;

const REC_BADGE: Record<Recommendation["action"], string> = {
  add_more: "badge-success",
  take_profit: "badge-success",
  hold: "badge-default",
  reduce: "badge-warning",
  cut_loss: "badge-error",
};

const REC_LABEL: Record<Recommendation["action"], string> = {
  add_more: "Add more",
  take_profit: "Take profit",
  hold: "Hold",
  reduce: "Reduce",
  cut_loss: "Cut loss",
};

const fmtIdr = (v: number) => v.toLocaleString("id-ID", { maximumFractionDigits: 0 });
const fmtPctSigned = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

function pnlColor(v: number | null): string {
  if (v == null) return "var(--color-muted)";
  return v > 0 ? "#3f8a4f" : v < 0 ? "var(--color-error)" : "var(--color-body)";
}

function SummaryTile({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="card" style={{ flex: 1, padding: "16px 20px" }}>
      <div className="caption">{label}</div>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 22,
          color: color ?? "var(--color-ink)",
          marginTop: 4,
        }}
      >
        {value}
      </div>
      {sub && (
        <div className="caption" style={{ color: color ?? "var(--color-muted)", marginTop: 2 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function ManualAddForm({
  editing,
  onSaved,
  onCancel,
}: {
  editing: Position | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [symbol, setSymbol] = useState(editing?.symbol ?? "");
  const [lots, setLots] = useState(editing ? String(editing.lots) : "");
  const [price, setPrice] = useState(editing ? String(editing.avg_price) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const sym = symbol.trim().toUpperCase();
    const nLots = parseIdrNumber(lots);
    const nPrice = parseIdrNumber(price);
    if (!sym || nLots == null || !Number.isInteger(nLots) || nLots < 1 || nLots > 1_000_000) {
      setError("Fill symbol and a whole number of lots (1–1.000.000).");
      return;
    }
    if (nPrice == null || nPrice < IDR_PRICE_MIN || nPrice > IDR_PRICE_MAX) {
      setError("Avg price looks wrong — enter the per-share price in rupiah (e.g. 710 or 6.300).");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await portfolioApi.put(sym, nLots, nPrice);
      setSymbol("");
      setLots("");
      setPrice("");
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          className="input"
          style={{ width: 110 }}
          placeholder="Symbol"
          value={symbol}
          disabled={editing != null}
          onChange={(e) => setSymbol(e.target.value)}
        />
        <input
          className="input"
          style={{ width: 90 }}
          placeholder="Lots"
          inputMode="numeric"
          value={lots}
          onChange={(e) => setLots(e.target.value)}
        />
        <input
          className="input"
          style={{ flex: 1 }}
          placeholder="Avg price/share (IDR)"
          inputMode="decimal"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
        />
        <button className="btn btn-secondary" disabled={busy} onClick={save}>
          {editing ? <Check size={15} /> : <Plus size={15} />} {editing ? "Save" : "Add"}
        </button>
        {editing && (
          <button className="btn btn-ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      {error && (
        <span className="caption" style={{ color: "var(--color-error)" }}>
          {error}
        </span>
      )}
    </div>
  );
}

function CashTile({
  cash,
  hidden,
  onSaved,
}: {
  cash: number;
  hidden: boolean;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function save() {
    // 0 is allowed here (clearing the reserve) — parseIdrNumber rejects it,
    // so special-case the literal zero forms.
    const trimmed = value.trim();
    const amount = /^0+$/.test(trimmed) ? 0 : parseIdrNumber(trimmed);
    if (amount == null || amount > 1_000_000_000_000) {
      setError(true);
      return;
    }
    setBusy(true);
    try {
      await portfolioApi.putCash(amount);
      setEditing(false);
      setError(false);
      onSaved();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ flex: 1, padding: "16px 20px", position: "relative" }}>
      <div className="caption">Cash reserve</div>
      {editing ? (
        <div style={{ display: "flex", gap: 6, marginTop: 4, alignItems: "center" }}>
          <input
            className="input"
            style={{ flex: 1, minWidth: 0, fontFamily: "var(--font-mono)" }}
            inputMode="decimal"
            autoFocus
            value={value}
            placeholder="e.g. 5.000.000"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") setEditing(false);
            }}
          />
          <button className="btn-icon" style={{ width: 26, height: 26 }} title="Save" disabled={busy} onClick={save}>
            <Check size={13} />
          </button>
          <button
            className="btn-icon"
            style={{ width: 26, height: 26 }}
            title="Cancel"
            disabled={busy}
            onClick={() => {
              setEditing(false);
              setError(false);
            }}
          >
            <X size={13} />
          </button>
        </div>
      ) : (
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 22, color: "var(--color-ink)", marginTop: 4 }}>
          {/* Edit mode force-shows the real value — the pencil is an explicit reveal. */}
          {masked(hidden, `Rp ${fmtIdr(cash)}`)}
        </div>
      )}
      {error && (
        <div className="caption" style={{ color: "var(--color-error)", marginTop: 2 }}>
          Enter an amount in rupiah, e.g. 5.000.000
        </div>
      )}
      {!editing && (
        <button
          className="btn-icon"
          style={{ width: 26, height: 26, position: "absolute", top: 12, right: 12 }}
          title="Edit cash reserve"
          onClick={() => {
            setValue(cash > 0 ? String(cash) : "");
            setEditing(true);
          }}
        >
          <Pencil size={12} />
        </button>
      )}
    </div>
  );
}

function ActionSuggestionsCard({
  positions,
  configured,
  recBusy,
  onGetRecommendations,
}: {
  positions: Position[];
  configured: boolean;
  recBusy: boolean;
  onGetRecommendations: () => void;
}) {
  const withRecs = positions.filter((p) => p.recommendation != null);

  // Counts by action
  const counts = withRecs.reduce((acc, p) => {
    const act = p.recommendation!.action;
    acc[act] = (acc[act] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return (
    <div className="card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="field-label" style={{ margin: 0 }}>Action Suggestions</span>
            {withRecs.length > 0 && (
              <span className="caption" style={{ color: "var(--color-muted)" }}>
                ({withRecs.length}/{positions.length})
              </span>
            )}
          </div>
          <p className="caption" style={{ margin: "2px 0 0 0", color: "var(--color-muted)" }}>
            AI-driven buy, hold, or exit suggestions based on technical setups and recent news.
          </p>
        </div>

        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={recBusy || !configured || positions.length === 0}
          onClick={onGetRecommendations}
          title={!configured ? "Configure LLM in Settings first" : undefined}
          style={{ flexShrink: 0 }}
        >
          <Sparkles size={13} className={recBusy ? "lx-spin" : undefined} />
          {recBusy ? "Analyzing…" : withRecs.length > 0 ? "Refresh" : "Analyze"}
        </button>
      </div>

      {!configured ? (
        <div className="well" style={{ display: "flex", flexDirection: "column", gap: 6, padding: "12px 14px" }}>
          <span className="body-sm" style={{ color: "var(--color-muted)" }}>
            Suggestions require an AI model configured in Settings.
          </span>
          <Link href="/settings?tab=ai" className="caption" style={{ color: "var(--color-primary)", textDecoration: "none" }}>
            Configure LLM Provider →
          </Link>
        </div>
      ) : positions.length === 0 ? (
        <div className="well" style={{ padding: "16px", textAlign: "center" }}>
          <span className="caption" style={{ color: "var(--color-muted)" }}>
            Add positions to get portfolio-wide action suggestions.
          </span>
        </div>
      ) : withRecs.length === 0 ? (
        <div className="well" style={{ padding: "20px 16px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
          <Sparkles size={22} style={{ color: "var(--color-primary)", opacity: 0.7 }} />
          <div style={{ fontSize: 13, fontWeight: 500, color: "var(--color-ink)" }}>
            No recommendations generated yet
          </div>
          <p className="caption" style={{ color: "var(--color-muted)", margin: 0 }}>
            Click &ldquo;Analyze&rdquo; to evaluate all {positions.length} holdings against current technicals and catalysts.
          </p>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={recBusy}
            onClick={onGetRecommendations}
            style={{ marginTop: 4 }}
          >
            <Sparkles size={13} className={recBusy ? "lx-spin" : undefined} />
            {recBusy ? "Analyzing…" : "Analyze Holdings Now"}
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {/* Action summary pills */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, paddingBottom: 8, borderBottom: "1px solid var(--color-hairline)" }}>
            {Boolean(counts.add_more) && (
              <Badge className="badge-success" small>
                {counts.add_more} Add more
              </Badge>
            )}
            {Boolean(counts.take_profit) && (
              <Badge className="badge-success" small>
                {counts.take_profit} Take profit
              </Badge>
            )}
            {Boolean(counts.hold) && (
              <Badge className="badge-default" small>
                {counts.hold} Hold
              </Badge>
            )}
            {Boolean(counts.reduce) && (
              <Badge className="badge-warning" small>
                {counts.reduce} Reduce
              </Badge>
            )}
            {Boolean(counts.cut_loss) && (
              <Badge className="badge-error" small>
                {counts.cut_loss} Cut loss
              </Badge>
            )}
          </div>

          {/* Cards for each position with recommendation */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 420, overflowY: "auto", paddingRight: 2 }}>
            {withRecs.map((p) => {
              const rec = p.recommendation!;
              return (
                <div
                  key={p.symbol}
                  className="well"
                  style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 6 }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <Link
                      href={`/stocks/${encodeURIComponent(p.symbol)}`}
                      style={{ fontWeight: 600, color: "var(--color-ink)", textDecoration: "none", fontSize: 14 }}
                    >
                      {p.symbol}
                    </Link>
                    <Badge className={REC_BADGE[rec.action]} small>
                      {REC_LABEL[rec.action]}
                    </Badge>
                  </div>

                  {rec.summary && (
                    <div style={{ fontSize: 13, color: "var(--color-ink)", lineHeight: 1.45 }}>
                      {rec.summary}
                    </div>
                  )}

                  {rec.reasons && rec.reasons.length > 0 && (
                    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "var(--color-muted)", lineHeight: 1.5 }}>
                      {rec.reasons.slice(0, 3).map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  )}

                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 4 }}>
                    <span className="caption" style={{ color: "var(--color-muted-soft)", fontSize: 11 }}>
                      {new Date(rec.generated_at).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })} · {new Date(rec.generated_at).toLocaleDateString("id-ID", { month: "short", day: "numeric" })}
                    </span>
                    <span className="caption" style={{ color: "var(--color-muted-soft)", fontSize: 11 }}>
                      {rec.model}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default function PortfolioPage() {
  const { settings, configured } = useLlmSettings();
  const portfolio = useSWR<Portfolio>("/api/portfolio", fetcher, {
    refreshInterval: REFRESH_MS,
  });
  const { data: symbols } = useSWR<SymbolOut[]>("/api/symbols", fetcher);

  const [recBusy, setRecBusy] = useState(false);
  const [recError, setRecError] = useState<string | null>(null);
  const [localNote, setLocalNote] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [editing, setEditing] = useState<Position | null>(null);
  const { hidden, toggle: toggleHidden } = useHideAmounts();

  const noteSwr = useSWR<{ note: string | null; model?: string; generated_at?: string }>(
    "/api/portfolio/note",
    fetcher,
    { refreshInterval: REFRESH_MS },
  );

  const activeNote = localNote || noteSwr.data?.note || null;
  const data = portfolio.data;

  async function getRecommendations() {
    if (!data || data.positions.length === 0 || recBusy) return;
    setRecBusy(true);
    setRecError(null);
    try {
      const perPosition = await analyzePositions(data.positions);

      const response = await generateRecommendations(settings, {
        cash: data.cash,
        totals: data.totals,
        positions: perPosition,
        note: "IDX portfolio; prices IDR; 1 lot = 100 shares; cash is uninvested IDR available for new buys",
      });

      const now = new Date().toISOString();
      const model = `${settings.provider}/${settings.model}`;
      await Promise.all(
        response.positions.map((r) =>
          portfolioApi
            .patchRecommendation(r.symbol, {
              action: r.action,
              summary: r.summary,
              reasons: r.reasons,
              model,
              generated_at: now,
            })
            .catch(() => undefined),
        ),
      );
      setLocalNote(response.portfolio_note || null);
      await portfolio.mutate();
    } catch (err) {
      setRecError(err instanceof Error ? err.message : String(err));
    } finally {
      setRecBusy(false);
    }
  }

  async function removePosition(symbol: string) {
    setRemoving(symbol);
    try {
      await portfolioApi.delete(symbol);
      await portfolio.mutate();
    } finally {
      setRemoving(null);
    }
  }

  const gridCols = "90px 60px 1fr 1fr 1fr 1fr 90px 110px 68px";

  function priceTitle(p: Position) {
    if (p.price_as_of == null) return "No price data";
    const when = new Date(p.price_as_of).toLocaleString();
    return p.price_is_intraday
      ? `Live 5m close at ${when} (~10 min delayed)`
      : `Settled daily close for ${when}`;
  }

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
      {/* ── Summary ─────────────────────────────────────────────────────── */}
      {!data ? (
        <Skeleton height={90} />
      ) : (
        <div style={{ display: "flex", gap: 16 }}>
          <SummaryTile label="Total cost" value={masked(hidden, `Rp ${fmtIdr(data.totals.cost)}`)} />
          <SummaryTile
            label="Market value"
            value={masked(hidden, `Rp ${fmtIdr(data.totals.market_value)}`)}
            sub={
              data.totals.unpriced_cost > 0
                ? `excl. ${masked(hidden, `Rp ${fmtIdr(data.totals.unpriced_cost)}`)} unpriced`
                : undefined
            }
          />
          <SummaryTile
            label="Unrealized P&L"
            value={masked(hidden, `Rp ${fmtIdr(data.totals.pnl)}`)}
            sub={data.totals.pnl_pct != null ? fmtPctSigned(data.totals.pnl_pct) : undefined}
            color={pnlColor(data.totals.pnl)}
          />
          <CashTile cash={data.cash} hidden={hidden} onSaved={() => portfolio.mutate()} />
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 380px", gap: 24, alignItems: "start" }}>
        {/* ── Positions ─────────────────────────────────────────────────── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <h5 style={{ margin: 0 }}>Positions</h5>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button
                className="btn-icon"
                style={{ width: 28, height: 28 }}
                title={hidden ? "Show amounts" : "Hide amounts"}
                onClick={toggleHidden}
              >
                {hidden ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
              <button
                className="btn btn-primary btn-sm"
                disabled={recBusy || !configured || !data || data.positions.length === 0}
                onClick={getRecommendations}
                title={!configured ? "Configure an LLM provider in Settings first" : undefined}
              >
                <Sparkles size={14} className={recBusy ? "lx-spin" : undefined} />
                {recBusy ? "Analysing…" : "Get recommendations"}
              </button>
            </div>
          </div>

          {portfolio.error ? (
            <ErrorCard message="Could not load portfolio." onRetry={() => portfolio.mutate()} />
          ) : !data ? (
            <Skeleton height={200} />
          ) : data.positions.length === 0 ? (
            <div className="card-canvas" style={{ padding: 32, textAlign: "center" }}>
              <p className="body-sm" style={{ margin: 0, color: "var(--color-muted)" }}>
                No positions yet — tell the assistant what you hold, or add manually below.
              </p>
            </div>
          ) : (
            <div className="dt">
              <div className="dt-head" style={{ gridTemplateColumns: gridCols, gap: 8 }}>
                <span>Symbol</span>
                <span className="text-right">Lots</span>
                <span className="text-right">Avg price</span>
                <span className="text-right">Last</span>
                <span className="text-right">Value</span>
                <span className="text-right">P&amp;L</span>
                <span className="text-right">P&amp;L %</span>
                <span>AI view</span>
                <span />
              </div>
              {data.positions.map((p: Position) => (
                <div
                  key={p.symbol}
                  className="dt-row"
                  style={{ gridTemplateColumns: gridCols, gap: 8, cursor: "default" }}
                >
                  <Link
                    href={`/stocks/${encodeURIComponent(p.symbol)}`}
                    className="dt-name"
                    style={{ textDecoration: "none" }}
                  >
                    {p.symbol}
                  </Link>
                  <span className="text-right mono" style={{ fontSize: 13 }}>
                    {maskedPlain(hidden, String(p.lots))}
                  </span>
                  <span className="text-right mono" style={{ fontSize: 13 }}>
                    {maskedPlain(hidden, fmtIdr(p.avg_price))}
                  </span>
                  <span
                    className="text-right mono"
                    style={{ fontSize: 13 }}
                    title={priceTitle(p)}
                  >
                    {p.last_close != null ? fmtIdr(p.last_close) : "—"}
                    {p.price_is_intraday && <span className="caption"> ·live</span>}
                  </span>
                  <span className="text-right mono" style={{ fontSize: 13 }}>
                    {p.market_value != null ? maskedPlain(hidden, fmtIdr(p.market_value)) : "—"}
                  </span>
                  <span className="text-right mono" style={{ fontSize: 13, color: pnlColor(p.pnl) }}>
                    {p.pnl != null ? maskedPlain(hidden, fmtIdr(p.pnl)) : "—"}
                  </span>
                  <span className="text-right mono" style={{ fontSize: 13, color: pnlColor(p.pnl) }}>
                    {p.pnl_pct != null ? fmtPctSigned(p.pnl_pct) : "—"}
                  </span>
                  <span>
                    {p.recommendation ? (
                      <span
                        title={`${p.recommendation.summary}\n\n• ${p.recommendation.reasons.join("\n• ")}\n\n${p.recommendation.model} · ${new Date(p.recommendation.generated_at).toLocaleString()}`}
                      >
                        <Badge className={REC_BADGE[p.recommendation.action]} small>
                          {REC_LABEL[p.recommendation.action]}
                        </Badge>
                      </span>
                    ) : (
                      <span className="caption" style={{ color: "var(--color-muted-soft)" }}>
                        —
                      </span>
                    )}
                  </span>
                  <span style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                    <button
                      className="btn-icon"
                      style={{ width: 26, height: 26 }}
                      title="Edit position"
                      onClick={() => setEditing(p)}
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      className="btn-icon"
                      style={{ width: 26, height: 26 }}
                      title="Remove position"
                      disabled={removing === p.symbol}
                      onClick={() => removePosition(p.symbol)}
                    >
                      <X size={12} />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}

          {recError && (
            <span className="caption" style={{ color: "var(--color-error)" }}>
              Recommendations failed: {recError}
            </span>
          )}
          {activeNote && (
            <div className="well">
              <span className="caption">Portfolio note</span>
              <p className="body-sm" style={{ margin: "4px 0 0 0" }}>
                {activeNote}
              </p>
            </div>
          )}

          <div className="card" style={{ padding: 16 }}>
            <span className="field-label">
              {editing ? `Edit ${editing.symbol}` : "Add manually"}
            </span>
            {/* key remounts the form when the edit target changes, so useState
                initializers pick up the prefill without effect-syncing. */}
            <ManualAddForm
              key={editing?.symbol ?? "new"}
              editing={editing}
              onSaved={() => {
                setEditing(null);
                portfolio.mutate();
              }}
              onCancel={() => setEditing(null)}
            />
          </div>

          <span className="caption" style={{ color: "var(--color-muted-soft)" }}>
            Prices are the last stored daily close (delayed ~10 min while the market is open).
            AI views are generated from technical and news data — not financial advice.
          </span>
        </div>

        {/* ── Allocation + Action Suggestions ─────────────────────────── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          {data && (
            <div className="card" style={{ padding: 16 }}>
              <span className="field-label">Allocation</span>
              <AllocationDonut portfolio={data} />
            </div>
          )}
          <ActionSuggestionsCard
            positions={data?.positions ?? []}
            configured={configured}
            recBusy={recBusy}
            onGetRecommendations={getRecommendations}
          />
        </div>
      </div>
    </div>
  );
}
