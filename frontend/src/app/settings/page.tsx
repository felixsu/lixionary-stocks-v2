"use client";

import { Eye, EyeOff, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import useSWR from "swr";

import { ErrorCard } from "@/components/ErrorCard";
import { Skeleton } from "@/components/Skeleton";
import { TimeframeSwitcher } from "@/components/TimeframeSwitcher";
import { ApiError, type SymbolOut, api, fetcher } from "@/lib/api";
import { MAX_FAVORITES, useDefaultTimeframe, useFavorites } from "@/lib/favorites";
import { PROVIDERS, chat, fetchModels, providerById, useLlmSettings } from "@/lib/llm";

function LlmSettingsCard() {
  const { settings, update, configured } = useLlmSettings();
  const [models, setModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [testState, setTestState] = useState<"idle" | "testing" | "ok" | "failed">("idle");
  const [testMessage, setTestMessage] = useState<string | null>(null);

  const provider = providerById(settings.provider);

  // Refresh the model list whenever provider or key changes. Fetched live from
  // the provider's /models endpoint; falls back to a hardcoded list on failure.
  useEffect(() => {
    let cancelled = false;
    if (!provider) {
      setModels([]);
      return;
    }
    setModelsLoading(true);
    fetchModels({ ...settings, provider: provider.id }).then((list) => {
      if (cancelled) return;
      setModels(list);
      setModelsLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.provider, settings.apiKey]);

  async function testConnection() {
    setTestState("testing");
    setTestMessage(null);
    try {
      await chat(settings, [{ role: "user", content: "Reply with the single word: ok" }]);
      setTestState("ok");
      setTestMessage("Connection works.");
    } catch (err) {
      setTestState("failed");
      setTestMessage(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <span className="field-label" style={{ margin: 0 }}>
          AI analysis (LLM)
        </span>
        <p className="body-sm" style={{ margin: "4px 0 0 0", color: "var(--color-muted)" }}>
          Powers the AI trend read on the stock analysis screen. The API key is stored in this
          browser only and is sent to the provider through this app per request.
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <label className="field-label">Provider</label>
          <select
            className="select"
            value={settings.provider}
            onChange={(e) => {
              const next = providerById(e.target.value);
              update({ provider: (next?.id ?? "") as typeof settings.provider, model: "" });
              setTestState("idle");
              setTestMessage(null);
            }}
          >
            <option value="" disabled>
              Choose a provider…
            </option>
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="field-label">Model</label>
          <select
            className="select"
            value={settings.model}
            disabled={!provider || modelsLoading}
            onChange={(e) => {
              update({ model: e.target.value });
              setTestState("idle");
              setTestMessage(null);
            }}
          >
            <option value="" disabled>
              {modelsLoading ? "Loading models…" : "Choose a model…"}
            </option>
            {/* Keep a previously-saved model selectable even if the live list omits it. */}
            {settings.model && !models.includes(settings.model) && (
              <option value={settings.model}>{settings.model}</option>
            )}
            {models.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className="field-label">API key</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            className="input"
            style={{ flex: 1 }}
            type={showKey ? "text" : "password"}
            placeholder={provider?.keyPlaceholder ?? "API key"}
            value={settings.apiKey}
            onChange={(e) => {
              update({ apiKey: e.target.value });
              setTestState("idle");
              setTestMessage(null);
            }}
          />
          <button
            className="btn-icon"
            style={{ width: 40, height: 40 }}
            title={showKey ? "Hide key" : "Show key"}
            onClick={() => setShowKey((v) => !v)}
          >
            {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button
          className="btn btn-secondary btn-sm"
          disabled={!configured || testState === "testing"}
          onClick={testConnection}
        >
          {testState === "testing" ? "Testing…" : "Test connection"}
        </button>
        {testMessage && (
          <span
            className="caption"
            style={{
              color: testState === "ok" ? "var(--color-success)" : "var(--color-error)",
            }}
          >
            {testMessage}
          </span>
        )}
        {!configured && (
          <span className="caption" style={{ color: "var(--color-muted-soft)" }}>
            AI analysis stays disabled until provider, model, and key are all set.
          </span>
        )}
      </div>
    </div>
  );
}

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

      {/* ── LLM configuration ──────────────────────────────────────────── */}
      <LlmSettingsCard />

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
