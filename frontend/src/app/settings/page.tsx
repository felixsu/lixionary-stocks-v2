"use client";

import { Plus, X } from "lucide-react";
import { useState } from "react";
import useSWR from "swr";

import { ErrorCard } from "@/components/ErrorCard";
import { Skeleton } from "@/components/Skeleton";
import { TimeframeSwitcher } from "@/components/TimeframeSwitcher";
import { ApiError, type SymbolOut, api, fetcher } from "@/lib/api";
import { MAX_FAVORITES, useDefaultTimeframe, useFavorites } from "@/lib/favorites";

export default function SettingsPage() {
  const { favorites, add, remove } = useFavorites();
  const { defaultTimeframe, setDefaultTimeframe } = useDefaultTimeframe();

  const symbolsSwr = useSWR<SymbolOut[]>("/api/symbols", fetcher);
  const symbols = symbolsSwr.data;

  const [newTicker, setNewTicker] = useState("");
  const [subscribing, setSubscribing] = useState(false);
  const [subscribeError, setSubscribeError] = useState<string | null>(null);
  // Inline two-step confirm for unsubscribe (no native dialog).
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  const nameOf = (code: string) => symbols?.find((s) => s.symbol === code)?.name ?? "";
  const addable = (symbols ?? []).filter(
    (s) => s.enabled && !favorites.includes(s.symbol),
  );

  async function subscribe() {
    const ticker = newTicker.trim().toUpperCase();
    if (!ticker) return;
    setSubscribing(true);
    setSubscribeError(null);
    try {
      await api.addSymbol(ticker);
      setNewTicker("");
      await symbolsSwr.mutate();
    } catch (err) {
      setSubscribeError(
        err instanceof ApiError ? err.message : "Could not reach the backend.",
      );
    } finally {
      setSubscribing(false);
    }
  }

  async function unsubscribe(code: string) {
    setRemoving(true);
    try {
      await api.removeSymbol(code);
      remove(code); // drop from dashboard favorites too if present
      setConfirmingRemove(null);
      await symbolsSwr.mutate();
    } catch (err) {
      setSubscribeError(
        err instanceof ApiError ? err.message : "Could not reach the backend.",
      );
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div
      style={{
        maxWidth: 760,
        margin: "0 auto",
        padding: 32,
        display: "flex",
        flexDirection: "column",
        gap: 24,
      }}
    >
      <div>
        <h3 style={{ margin: "0 0 4px 0" }}>Watchlist</h3>
        <p className="body-sm" style={{ margin: 0, color: "var(--color-muted)" }}>
          Choose up to {MAX_FAVORITES} IHSG stocks to show on your dashboard.
        </p>
      </div>

      {/* ── Dashboard favorites (client-side only) ─────────────────────── */}
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span className="field-label" style={{ margin: 0 }}>
            Favorites ({favorites.length}/{MAX_FAVORITES})
          </span>
        </div>

        {favorites.length === 0 && (
          <span className="body-sm" style={{ color: "var(--color-muted)" }}>
            Nothing here yet — add a stock below.
          </span>
        )}
        <div style={{ display: "flex", flexDirection: "column" }}>
          {favorites.map((code) => (
            <div
              key={code}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "12px 4px",
                borderBottom: "1px solid var(--color-hairline-soft)",
              }}
            >
              <div>
                <span style={{ fontWeight: 500, color: "var(--color-ink)", fontSize: 14 }}>
                  {code}
                </span>
                <span className="body-sm" style={{ color: "var(--color-muted)", marginLeft: 8 }}>
                  {nameOf(code)}
                </span>
              </div>
              <button
                className="btn-icon"
                style={{ width: 30, height: 30 }}
                title="Remove from dashboard"
                onClick={() => remove(code)}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>

        {favorites.length < MAX_FAVORITES ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <select
              className="select"
              style={{ flex: 1 }}
              value=""
              onChange={(e) => {
                if (e.target.value) add(e.target.value);
              }}
            >
              <option value="" disabled>
                Add a stock to your watchlist…
              </option>
              {addable.map((s) => (
                <option key={s.symbol} value={s.symbol}>
                  {s.symbol} — {s.name ?? s.symbol}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <span className="caption" style={{ color: "var(--color-muted-soft)" }}>
            Maximum of {MAX_FAVORITES} favorites reached. Remove one to add another.
          </span>
        )}
        <span className="caption" style={{ color: "var(--color-muted-soft)" }}>
          Favorites only affect what your dashboard shows — data keeps collecting for every
          subscribed symbol below.
        </span>
      </div>

      {/* ── Backend subscriptions (polling + history accumulation) ─────── */}
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <span className="field-label" style={{ margin: 0 }}>
            Data subscriptions
          </span>
          <p className="body-sm" style={{ margin: "4px 0 0 0", color: "var(--color-muted)" }}>
            Symbols the backend polls from Yahoo Finance every 5 minutes. Unsubscribing stops
            polling and 5-minute history accumulation — intraday history older than 60 days can
            never be refetched.
          </p>
        </div>

        {symbolsSwr.error ? (
          <ErrorCard
            message="Could not load subscriptions."
            onRetry={() => symbolsSwr.mutate()}
          />
        ) : !symbols ? (
          <Skeleton height={120} />
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {symbols.map((s) => (
              <div
                key={s.symbol}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "12px 4px",
                  borderBottom: "1px solid var(--color-hairline-soft)",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <span style={{ fontWeight: 500, color: "var(--color-ink)", fontSize: 14 }}>
                    {s.symbol}
                  </span>
                  <span className="body-sm" style={{ color: "var(--color-muted)", marginLeft: 8 }}>
                    {s.name ?? ""}
                  </span>
                  {s.last_error && (
                    <span className="caption" style={{ color: "var(--color-error)", marginLeft: 8 }}>
                      {s.last_error}
                    </span>
                  )}
                </div>
                {confirmingRemove === s.symbol ? (
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <button
                      className="btn btn-danger-outline btn-sm"
                      disabled={removing}
                      onClick={() => unsubscribe(s.symbol)}
                    >
                      {removing ? "Removing…" : "Stop collecting data"}
                    </button>
                    <button
                      className="btn btn-secondary btn-sm"
                      disabled={removing}
                      onClick={() => setConfirmingRemove(null)}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    className="btn-icon"
                    style={{ width: 30, height: 30 }}
                    title="Unsubscribe (stops data collection)"
                    onClick={() => setConfirmingRemove(s.symbol)}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            className="input"
            style={{ flex: 1 }}
            placeholder="Subscribe a new IDX ticker, e.g. BBNI"
            value={newTicker}
            disabled={subscribing}
            onChange={(e) => {
              setNewTicker(e.target.value);
              setSubscribeError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") subscribe();
            }}
          />
          <button
            className="btn btn-primary"
            disabled={subscribing || !newTicker.trim()}
            onClick={subscribe}
          >
            <Plus size={16} /> {subscribing ? "Validating…" : "Subscribe"}
          </button>
        </div>
        {subscribeError && (
          <span className="caption" style={{ color: "var(--color-error)" }}>
            {subscribeError}
          </span>
        )}
      </div>

      {/* ── Default timeframe ──────────────────────────────────────────── */}
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <span className="field-label" style={{ margin: 0 }}>
          Default timeframe
        </span>
        <p className="body-sm" style={{ margin: 0, color: "var(--color-muted)" }}>
          Used when the dashboard loads.
        </p>
        <TimeframeSwitcher value={defaultTimeframe} onChange={setDefaultTimeframe} />
      </div>
    </div>
  );
}
