"use client";

import {
  Check,
  CheckCircle2,
  Eye,
  EyeOff,
  HelpCircle,
  ListFilter,
  Plus,
  Send,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import useSWR from "swr";

import { Badge } from "@/components/Badge";
import { ErrorCard } from "@/components/ErrorCard";
import { Skeleton } from "@/components/Skeleton";
import { TimeframeSwitcher } from "@/components/TimeframeSwitcher";
import { ApiError, type SymbolOut, type TelegramConfig, api, fetcher } from "@/lib/api";
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

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button
          className="btn btn-secondary btn-sm"
          disabled={!configured || testState === "testing"}
          onClick={testConnection}
        >
          {testState === "testing" ? "Testing…" : "Test connection"}
        </button>
        {configured && (
          <button
            className="btn btn-secondary btn-sm"
            onClick={async () => {
              try {
                await api.putBackendLlm({
                  provider: settings.provider,
                  model: settings.model,
                  api_key: settings.apiKey,
                });
                setTestState("ok");
                setTestMessage("Saved to backend worker.");
              } catch (err) {
                setTestState("failed");
                setTestMessage(`Save failed: ${err instanceof Error ? err.message : err}`);
              }
            }}
          >
            Save to backend worker
          </button>
        )}
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

function TelegramSettingsCard() {
  const { data: config, mutate } = useSWR<TelegramConfig>("/api/notifications/telegram", fetcher);
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (config?.chat_id && !chatId) {
      setChatId(config.chat_id);
    }
  }, [config, chatId]);

  async function handleSave() {
    setSaving(true);
    setSaveSuccess(false);
    try {
      await api.updateTelegramConfig({
        bot_token: botToken.trim() || undefined,
        chat_id: chatId.trim() || undefined,
      });
      mutate();
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err) {
      alert(`Failed to save Telegram settings: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      await api.testTelegramMessage({
        bot_token: botToken.trim() || undefined,
        chat_id: chatId.trim() || undefined,
      });
      setTestResult({ ok: true, message: "Test notification delivered! Check your Telegram." });
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="field-label" style={{ margin: 0 }}>
              Profile & Telegram Notifications
            </span>
            {config?.configured ? (
              <Badge className="badge-success">Connected</Badge>
            ) : (
              <Badge className="badge-default">Not configured</Badge>
            )}
          </div>
          <p className="body-sm" style={{ margin: "4px 0 0 0", color: "var(--color-muted)" }}>
            Receive instant price alert notifications on Telegram when watchlist stocks hit entry, target, or stop loss levels.
          </p>
        </div>

        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setShowGuide((v) => !v)}
          style={{ display: "flex", alignItems: "center", gap: 4 }}
        >
          <HelpCircle size={14} /> {showGuide ? "Hide Setup Guide" : "Bot Setup Guide"}
        </button>
      </div>

      {showGuide && (
        <div
          className="well"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            fontSize: 13,
            lineHeight: 1.6,
            background: "var(--color-surface-cream-strong)",
          }}
        >
          <div style={{ fontWeight: 600, color: "var(--color-ink)" }}>Quick 3-step Telegram Bot Setup:</div>
          <ol style={{ margin: 0, paddingLeft: 20 }}>
            <li>
              <b>Create Bot:</b> Open Telegram, message <code>@BotFather</code>, send <code>/newbot</code>, follow the prompts, and copy the HTTP API Token.
            </li>
            <li>
              <b>Get Chat ID:</b> Search for <code>@userinfobot</code> on Telegram, send <code>/start</code>, and copy your numeric <b>Id</b> (e.g. <code>123456789</code>).
            </li>
            <li>
              <b>Start Chat:</b> Open your newly created bot on Telegram and click <b>Start</b> (bots cannot initiate messages first).
            </li>
          </ol>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <label className="field-label">Telegram User ID / Chat ID</label>
          <input
            type="text"
            className="input"
            style={{ width: "100%" }}
            placeholder="e.g. 123456789"
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
          />
          <span className="caption" style={{ color: "var(--color-muted)" }}>
            Your numeric Telegram ID from @userinfobot
          </span>
        </div>

        <div>
          <label className="field-label">Telegram Bot Token</label>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              type={showToken ? "text" : "password"}
              className="input"
              style={{ flex: 1 }}
              placeholder={config?.masked_token ? `Configured (${config.masked_token})` : "e.g. 123456:ABC-DEF..."}
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
            />
            <button
              type="button"
              className="btn-icon"
              style={{ width: 38, height: 38 }}
              onClick={() => setShowToken((v) => !v)}
              title={showToken ? "Hide token" : "Show token"}
            >
              {showToken ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
          <span className="caption" style={{ color: "var(--color-muted)" }}>
            HTTP API token issued by @BotFather
          </span>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={saving || (!chatId && !botToken)}
            onClick={handleSave}
          >
            {saving ? "Saving…" : saveSuccess ? "Saved!" : "Save Telegram Settings"}
          </button>

          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={testing || (!config?.configured && !botToken && !chatId)}
            onClick={handleTest}
          >
            <Send size={13} /> {testing ? "Sending…" : "Send Test Message"}
          </button>
        </div>

        {testResult && (
          <span
            className="caption"
            style={{ color: testResult.ok ? "var(--color-success)" : "var(--color-error)" }}
          >
            {testResult.message}
          </span>
        )}
      </div>
    </div>
  );
}

type SettingsTab = "watchlist" | "ai" | "telegram" | "general";

function SettingsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab") as SettingsTab | null;
  const initialTab: SettingsTab =
    tabParam && ["watchlist", "ai", "telegram", "general"].includes(tabParam)
      ? tabParam
      : "watchlist";

  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);

  useEffect(() => {
    const current = searchParams.get("tab") as SettingsTab | null;
    if (current && ["watchlist", "ai", "telegram", "general"].includes(current)) {
      setActiveTab(current);
    }
  }, [searchParams]);

  const handleTabChange = (tab: SettingsTab) => {
    setActiveTab(tab);
    router.replace(`/settings?tab=${tab}`, { scroll: false });
  };

  const { favorites, add, remove } = useFavorites();
  const { defaultTimeframe, setDefaultTimeframe } = useDefaultTimeframe();
  const { configured: llmConfigured } = useLlmSettings();
  const { data: tgConfig } = useSWR<TelegramConfig>("/api/notifications/telegram", fetcher);

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

  const tabs: {
    id: SettingsTab;
    label: string;
    icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
    badge?: React.ReactNode;
  }[] = [
    {
      id: "watchlist",
      label: "Watchlist & Data",
      icon: ListFilter,
      badge: (
        <span
          className="role-pill"
          style={{
            fontSize: 11,
            padding: "1px 6px",
            background: activeTab === "watchlist" ? "var(--color-surface-cream-strong)" : undefined,
          }}
        >
          {favorites.length}/{MAX_FAVORITES}
        </span>
      ),
    },
    {
      id: "ai",
      label: "AI Analysis",
      icon: Sparkles,
      badge: (
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: 9999,
            background: llmConfigured ? "var(--color-success)" : "var(--color-muted-soft)",
            display: "inline-block",
          }}
          title={llmConfigured ? "AI configured" : "AI not configured"}
        />
      ),
    },
    {
      id: "telegram",
      label: "Telegram",
      icon: Send,
      badge: (
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: 9999,
            background: tgConfig?.configured ? "var(--color-success)" : "var(--color-muted-soft)",
            display: "inline-block",
          }}
          title={tgConfig?.configured ? "Telegram connected" : "Telegram not configured"}
        />
      ),
    },
    {
      id: "general",
      label: "General",
      icon: SlidersHorizontal,
    },
  ];

  return (
    <div
      style={{
        maxWidth: 760,
        margin: "0 auto",
        padding: "32px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 20,
      }}
    >
      <div>
        <h3 style={{ margin: "0 0 4px 0" }}>Settings</h3>
        <p className="body-sm" style={{ margin: 0, color: "var(--color-muted)" }}>
          Manage your watchlists, AI integrations, alerts, and preferences.
        </p>
      </div>

      {/* Tab Navigation */}
      <div
        style={{
          display: "flex",
          gap: 6,
          borderBottom: "1px solid var(--color-hairline)",
          paddingBottom: 0,
          overflowX: "auto",
        }}
      >
        {tabs.map((t) => {
          const active = t.id === activeTab;
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => handleTabChange(t.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "10px 14px",
                border: "none",
                background: "transparent",
                cursor: "pointer",
                fontSize: 13,
                fontWeight: active ? 600 : 400,
                color: active ? "var(--color-ink)" : "var(--color-muted)",
                borderBottom: active ? "2px solid var(--color-primary)" : "2px solid transparent",
                marginBottom: -1,
                whiteSpace: "nowrap",
                transition: "all 0.15s ease",
              }}
            >
              <Icon
                size={15}
                style={{ color: active ? "var(--color-primary)" : "var(--color-muted)" }}
              />
              <span>{t.label}</span>
              {t.badge}
            </button>
          );
        })}
      </div>

      {/* ── Watchlist & Data Tab ────────────────────────────────────── */}
      {activeTab === "watchlist" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {/* Dashboard favorites */}
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

          {/* Backend data subscriptions */}
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
        </div>
      )}

      {/* ── AI Analysis Tab ─────────────────────────────────────────── */}
      {activeTab === "ai" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <LlmSettingsCard />
        </div>
      )}

      {/* ── Telegram Tab ────────────────────────────────────────────── */}
      {activeTab === "telegram" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <TelegramSettingsCard />
        </div>
      )}

      {/* ── General Preferences Tab ─────────────────────────────────── */}
      {activeTab === "general" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
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
      )}
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<Skeleton height={200} />}>
      <SettingsContent />
    </Suspense>
  );
}
