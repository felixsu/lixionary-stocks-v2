// Typed client for the FastAPI backend, reached through the Next.js /api rewrite.

export interface Bar {
  ts: string; // bucket OPEN time, UTC ISO
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
  final: boolean;
}

export interface CandlesOut {
  symbol: string;
  timeframe: string;
  source_timeframe: string | null;
  derived: boolean;
  has_volume: boolean;
  count: number;
  bars: Bar[];
}

export interface CoverageEntry {
  first: string | null;
  last: string | null;
  count: number;
}

export interface SymbolOut {
  symbol: string;
  yahoo_symbol: string;
  name: string | null;
  kind: "stock" | "index";
  enabled: boolean;
  notes: string | null;
  coverage: Record<string, CoverageEntry>;
  last_poll_at: string | null;
  last_error: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export const IHSG_SYMBOL = "^JKSE";

/** `^JKSE` must be URL-encoded as `%5EJKSE` in paths. */
export function encodeSymbol(symbol: string): string {
  return encodeURIComponent(symbol);
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (typeof body?.detail === "string") detail = body.detail;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(detail, res.status);
  }
  return res.json() as Promise<T>;
}

export function candlesKey(symbol: string, timeframe: string, limit: number): string {
  return `/api/candles/${encodeSymbol(symbol)}?timeframe=${timeframe}&limit=${limit}`;
}

export const fetcher = <T>(path: string): Promise<T> => request<T>(path);

export const api = {
  candles: (symbol: string, timeframe: string, limit: number) =>
    request<CandlesOut>(candlesKey(symbol, timeframe, limit)),

  symbols: (enabled?: boolean) =>
    request<SymbolOut[]>(`/api/symbols${enabled === undefined ? "" : `?enabled=${enabled}`}`),

  addSymbol: (symbol: string) =>
    request<SymbolOut>("/api/symbols", {
      method: "POST",
      body: JSON.stringify({ symbol }),
    }),

  removeSymbol: (symbol: string) =>
    request<{ symbols_deleted: number; candles_deleted: number }>(
      `/api/symbols/${encodeSymbol(symbol)}`,
      { method: "DELETE" },
    ),

  getFavorites: () => request<{ symbols: string[] }>("/api/analytics/favorites"),

  putFavorites: (symbols: string[]) =>
    request<{ symbols: string[] }>("/api/analytics/favorites", {
      method: "PUT",
      body: JSON.stringify({ symbols }),
    }),

  getLatestAnalysis: (symbol: string, timeframe?: string, slot?: string) => {
    const params = new URLSearchParams();
    if (timeframe) params.set("timeframe", timeframe);
    if (slot) params.set("slot", slot);
    const qs = params.toString();
    return request<BackendAnalysis>(`/api/analytics/${encodeSymbol(symbol)}${qs ? `?${qs}` : ""}`);
  },

  runAnalytics: (slot: string = "ad_hoc", timeframe: "both" | "1d" | "1h" = "both") =>
    request<{ run_id: string; detail?: string; status?: string }>("/api/analytics/run", {
      method: "POST",
      body: JSON.stringify({ slot, timeframe }),
    }),

  getPortfolioNote: () => request<{ note: string | null; model?: string; generated_at?: string }>("/api/portfolio/note"),

  runRecommendations: (slot: string = "ad_hoc") =>
    request<{ run_id: string; status: string }>("/api/portfolio/recommendations/run", {
      method: "POST",
      body: JSON.stringify({ slot }),
    }),

  getBackendLlm: () =>
    request<{
      provider: string;
      model: string;
      has_api_key: boolean;
      api_key_masked: string;
      is_configured: boolean;
    }>("/api/system/llm"),

  putBackendLlm: (config: { provider: string; model: string; api_key?: string }) =>
    request<{
      provider: string;
      model: string;
      has_api_key: boolean;
      is_configured: boolean;
    }>("/api/system/llm", {
      method: "PUT",
      body: JSON.stringify(config),
    }),

  getNotifications: (limit = 50, unreadOnly = false) =>
    request<{ items: NotificationItem[]; unread_count: number }>(
      `/api/notifications?limit=${limit}${unreadOnly ? "&unread_only=true" : ""}`,
    ),

  markNotificationsRead: (ids?: string[]) =>
    request<{ modified_count: number }>("/api/notifications/read", {
      method: "POST",
      body: JSON.stringify({ ids }),
    }),

  clearNotifications: () =>
    request<{ deleted_count: number }>("/api/notifications", {
      method: "DELETE",
    }),

  getAlertTargets: () =>
    request<{ targets: AlertTarget[] }>("/api/notifications/targets"),

  updateAlertTarget: (
    symbol: string,
    payload: {
      entry?: number | null;
      stop?: number | null;
      target?: number | null;
      basis?: string | null;
      enabled?: boolean;
    },
  ) =>
    request<AlertTarget>(`/api/notifications/targets/${encodeSymbol(symbol)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),

  resetAlertTarget: (symbol: string) =>
    request<{ symbol: string; reverted_to_ai: boolean }>(
      `/api/notifications/targets/${encodeSymbol(symbol)}`,
      { method: "DELETE" },
    ),

  checkAlertsNow: () =>
    request<{
      status: string;
      evaluated_count: number;
      triggered_count: number;
      alerts: Array<{ id: string; symbol: string; alert_type: string; price: number; target_price: number }>;
    }>("/api/notifications/check", {
      method: "POST",
    }),

  simulateAlert: (payload: {
    symbol: string;
    alert_type: "entry_hit" | "target_hit" | "stop_hit";
    current_price: number;
    target_price: number;
    basis?: string;
    send_telegram?: boolean;
  }) =>
    request<NotificationItem>("/api/notifications/simulate", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  getTelegramConfig: () =>
    request<TelegramConfig>("/api/notifications/telegram"),

  updateTelegramConfig: (payload: { bot_token?: string; chat_id?: string }) =>
    request<TelegramConfig>("/api/notifications/telegram", {
      method: "PUT",
      body: JSON.stringify(payload),
    }),

  testTelegramMessage: (payload?: { bot_token?: string; chat_id?: string; message?: string }) =>
    request<{ status: string; message_id?: number }>("/api/notifications/telegram/test", {
      method: "POST",
      body: JSON.stringify(payload ?? {}),
    }),
};

// ── Backend Analysis ────────────────────────────────────────────────────────

export interface TradePlan {
  entry: number | null;
  stop: number | null;
  target: number | null;
  basis: string;
  risk_pct?: number | null;
  reward_pct?: number | null;
  rr?: number | null;
}

export interface BackendAnalysis {
  symbol: string;
  timeframe: string;
  slot: "pre_market" | "mid_day" | "ad_hoc";
  price: number;
  stance: "bullish" | "bearish" | "neutral";
  summary: string;
  bullets: string[];
  risks: string[];
  plan: TradePlan | null;
  model: string;
  generated_at: string;
}

export function analysisKey(symbol: string, timeframe?: string): string {
  return `/api/analytics/${encodeSymbol(symbol)}${timeframe ? `?timeframe=${timeframe}` : ""}`;
}

// ── News ────────────────────────────────────────────────────────────────────

export interface NewsSymbolTag {
  symbol: string;
  direction: "positive" | "negative";
  reason: string;
}

export interface NewsAnalysis {
  relevant: boolean;
  sentiment: "bullish" | "bearish" | "neutral";
  impact: "high" | "medium" | "low";
  note: string;
  symbols: NewsSymbolTag[];
  model: string;
  analyzed_at: string;
}

export interface NewsItem {
  url: string;
  title: string;
  source: string;
  feed_category: string;
  summary: string;
  published_at: string;
  analysis: NewsAnalysis | null;
}

export interface NewsList {
  analysis_enabled: boolean;
  count: number;
  items: NewsItem[];
}

export interface NewsSummary {
  analysis_enabled: boolean;
  window_hours: number;
  bullish: number;
  bearish: number;
  neutral: number;
  lean: "bullish" | "bearish" | "neutral";
  top_symbols: { symbol: string; mentions: number; positive: number }[];
  total_items: number;
  pending_analysis: number;
}

export function newsKey(opts: { symbol?: string; sentiment?: string; limit?: number } = {}): string {
  const params = new URLSearchParams();
  if (opts.symbol) params.set("symbol", opts.symbol);
  if (opts.sentiment) params.set("sentiment", opts.sentiment);
  params.set("limit", String(opts.limit ?? 50));
  return `/api/news?${params.toString()}`;
}

// ── Notifications & Price Alerts ───────────────────────────────────────────

export interface NotificationItem {
  id: string;
  symbol: string;
  name?: string | null;
  alert_type: "entry_hit" | "target_hit" | "stop_hit";
  current_price: number;
  target_price: number;
  basis?: string | null;
  source: "ai" | "manual" | "simulation";
  session_date: string;
  created_at: string;
  read: boolean;
  simulated?: boolean;
  telegram_status: "sent" | "skipped" | "error" | "pending";
}

export interface AlertTarget {
  symbol: string;
  name?: string | null;
  current_price?: number | null;
  entry?: number | null;
  stop?: number | null;
  target?: number | null;
  basis?: string | null;
  source: "ai" | "manual";
  enabled: boolean;
  entry_dist_pct?: number | null;
  target_dist_pct?: number | null;
  stop_dist_pct?: number | null;
  entry_triggered_today: boolean;
  target_triggered_today: boolean;
  stop_triggered_today: boolean;
}

export interface TelegramConfig {
  configured: boolean;
  has_token: boolean;
  has_chat_id: boolean;
  chat_id: string;
  masked_token: string;
}

