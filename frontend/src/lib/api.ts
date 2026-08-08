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
