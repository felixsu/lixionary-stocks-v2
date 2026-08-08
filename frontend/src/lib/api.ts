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
};

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
