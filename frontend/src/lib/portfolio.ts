"use client";

// Portfolio: types, chat protocol, and the action executor.
//
// The LLM parses free text into structured actions but NEVER does arithmetic —
// weighted averages and lot math happen here, deterministically. Invalid
// actions come back as chat corrections, never silent failures.

import { api, encodeSymbol } from "./api";
import { type LlmSettings, chat } from "./llm";
import { IDR_PRICE_MAX, IDR_PRICE_MIN } from "./parse-idr";
import { type PositionAnalysis } from "./position-analysis";

export const SHARES_PER_LOT = 100;

// ── API types ───────────────────────────────────────────────────────────────

export interface Recommendation {
  action: "add_more" | "hold" | "reduce" | "cut_loss" | "take_profit";
  summary: string;
  reasons: string[];
  model: string;
  generated_at: string;
}

export interface Position {
  symbol: string;
  lots: number;
  avg_price: number;
  notes?: string | null;
  recommendation: Recommendation | null;
  shares: number;
  cost: number;
  last_close: number | null;
  prev_close: number | null;
  /** When last_close was observed; null when no bar exists. */
  price_as_of: string | null;
  /** True when last_close came from the live 5m series rather than a settled daily bar. */
  price_is_intraday: boolean;
  market_value: number | null;
  pnl: number | null;
  pnl_pct: number | null;
  day_change_pct: number | null;
}

export interface Portfolio {
  positions: Position[];
  cash: number;
  totals: {
    cost: number;
    market_value: number;
    pnl: number;
    pnl_pct: number | null;
    unpriced_cost: number;
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(body?.detail ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const portfolioApi = {
  get: () => request<Portfolio>("/api/portfolio"),
  put: (symbol: string, lots: number, avgPrice: number) =>
    request<Position>(`/api/portfolio/${encodeSymbol(symbol)}`, {
      method: "PUT",
      body: JSON.stringify({ lots, avg_price: avgPrice }),
    }),
  delete: (symbol: string) =>
    request<{ deleted: string }>(`/api/portfolio/${encodeSymbol(symbol)}`, {
      method: "DELETE",
    }),
  putCash: (amount: number) =>
    request<{ amount: number }>("/api/portfolio/cash", {
      method: "PUT",
      body: JSON.stringify({ amount }),
    }),
  patchRecommendation: (symbol: string, rec: Recommendation) =>
    request<{ stored: string }>(`/api/portfolio/${encodeSymbol(symbol)}/recommendation`, {
      method: "PATCH",
      body: JSON.stringify(rec),
    }),
};

// ── Chat protocol ───────────────────────────────────────────────────────────

export type ChatAction =
  | { type: "set_position"; symbol: string; lots: number; avg_price: number }
  | { type: "add_purchase"; symbol: string; lots: number; price: number }
  | { type: "sell_lots"; symbol: string; lots: number }
  | { type: "remove_position"; symbol: string }
  | { type: "analyze"; symbols: string[] };

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  /** Result lines from executed actions (assistant turns only). */
  results?: { ok: boolean; text: string }[];
}

const CHAT_SYSTEM_PROMPT = `You are the portfolio assistant for Indonesian (IDX) stock holdings inside a personal analytics app. The user writes free text (often mixing English and Indonesian). You have two jobs:
1) DATA ENTRY — turn holding statements into structured actions, and ASK for anything missing before acting.
2) ADVISOR — answer questions about the portfolio ("what should I do with BBCA?", "should I average down?").
1 lot = 100 shares; prices are in IDR (rupiah).

Respond with a single JSON object, no markdown fences:
{"reply": "<reply text>", "actions": [ ... ]}

Action shapes (use ONLY these):
- {"type": "set_position", "symbol": "BBCA", "lots": 10, "avg_price": 6300}   // absolute: "I hold 10 lots of BBCA at average 6300"
- {"type": "add_purchase", "symbol": "BBCA", "lots": 5, "price": 6000}        // incremental buy: "bought 5 more lots at 6000" — the APP computes the new average, never you
- {"type": "sell_lots", "symbol": "BBCA", "lots": 3}                          // partial or full sale
- {"type": "remove_position", "symbol": "BBCA"}                               // "remove BBCA" / "I closed my BBCA position"
- {"type": "analyze", "symbols": ["BBCA"]}                                    // request the daily technical scorecard, volume and recent news for HELD positions before advising

Advisory rules:
- Every message includes the full portfolio (lots, avg price, last close, market value, P&L, any stored AI view), the cash reserve, and totals.
- For "what should I do" questions about specific holdings, emit ONE analyze action for those symbols and use "reply" only to say you are looking at the data. When the message contains "analysis_data", answer directly and NEVER emit analyze again.
- Ground advice in the provided numbers and cite them (P&L %, signal verdicts, RVOL, news sentiment). Never invent prices or news.
- Any buy-more / average-down suggestion MUST be checked against the cash reserve: state the approximate cost (lots × 100 × price) and whether cash covers it. Illustrative arithmetic like this is allowed in advice — but stored positions are still only ever changed via actions, with the app doing the math.
- Advisory replies: a short paragraph or up to 5 "- " bullet lines; you may bold key phrases with **...**. End with one short line noting this is informational analysis, not financial advice.

Entry rules:
- NEVER invent lots or prices. If either is missing for a buy, return "actions": [] and ask for exactly what's missing in "reply".
- NEVER compute averages, totals, or P&L for ACTIONS — emit the raw purchase and let the app do the math.
- Symbols are IDX tickers (usually 4 letters). Uppercase them. If the user names a company instead of a ticker ("Bank Central Asia"), map it only when the tracked list makes it unambiguous; otherwise ask.
- "avg_price"/"price" are ALWAYS the per-SHARE price in rupiah — never per lot and never a total. IDX per-share prices are whole rupiah, typically 50–30,000. If the user gives a per-lot or total amount, ask for the per-share price instead.
- Number reading: "6.3k"/"6300"/"Rp6.300" all mean 6300. A dot followed by exactly 3 digits is an Indonesian thousands separator ("6.300" = 6300); a dot or comma followed by 1–2 digits is a decimal ("710.00" = 710, "6300,5" = 6300.5).
- If a stated per-share price falls outside 50–1,000,000 rupiah, do NOT act — return "actions": [] and ask the user to confirm the price.
- Multiple statements in one message → multiple actions.
- For pure entry messages keep "reply" to one or two sentences; confirm what you understood.`;

interface ChatResponse {
  reply: string;
  actions: ChatAction[];
}

function parseChatResponse(raw: string): ChatResponse {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("assistant reply was not JSON");
  const parsed = JSON.parse(text.slice(start, end + 1)) as {
    reply?: string;
    actions?: unknown;
  };
  const actions: ChatAction[] = [];
  if (Array.isArray(parsed.actions)) {
    for (const a of parsed.actions) {
      if (a && typeof a === "object" && typeof (a as { type?: string }).type === "string") {
        actions.push(a as ChatAction);
      }
    }
  }
  return { reply: typeof parsed.reply === "string" ? parsed.reply : "", actions };
}

export async function sendChatMessage(
  settings: LlmSettings,
  history: ChatTurn[],
  userMessage: string,
  portfolio: Portfolio | null,
  trackedSymbols: { symbol: string; name: string | null }[],
  analysisData?: PositionAnalysis[],
): Promise<ChatResponse> {
  const context = {
    cash: portfolio?.cash ?? 0,
    totals: portfolio?.totals ?? null,
    current_portfolio: (portfolio?.positions ?? []).map((p) => ({
      symbol: p.symbol,
      lots: p.lots,
      avg_price: p.avg_price,
      last_close: p.last_close,
      market_value: p.market_value,
      pnl: p.pnl,
      pnl_pct: p.pnl_pct,
      day_change_pct: p.day_change_pct,
      ai_view: p.recommendation
        ? {
            action: p.recommendation.action,
            summary: p.recommendation.summary,
            generated_at: p.recommendation.generated_at,
          }
        : null,
    })),
    tracked_symbols: trackedSymbols.map((s) => `${s.symbol} (${s.name ?? s.symbol})`),
  };

  const analysisBlock = analysisData
    ? `\n\nanalysis_data (you requested this; answer now, do NOT emit another analyze): ${JSON.stringify(analysisData)}`
    : "";

  const messages = [
    { role: "system" as const, content: CHAT_SYSTEM_PROMPT },
    // Recent turns for conversational continuity (questions about missing info).
    ...history.slice(-8).map((t) => ({
      role: t.role === "user" ? ("user" as const) : ("system" as const),
      content: t.role === "user" ? t.content : `(your previous reply) ${t.content}`,
    })),
    {
      role: "user" as const,
      content: `${JSON.stringify(context)}${analysisBlock}\n\nUser message: ${userMessage}`,
    },
  ];

  const raw = await chat(settings, messages);
  return parseChatResponse(raw);
}

// ── Action executor (deterministic math lives here) ─────────────────────────

const fmtIdr = (v: number) => v.toLocaleString("id-ID", { maximumFractionDigits: 0 });

export async function executeActions(
  actions: ChatAction[],
  portfolio: Portfolio | null,
  trackedSymbols: string[],
): Promise<{ ok: boolean; text: string }[]> {
  const results: { ok: boolean; text: string }[] = [];
  // Track state across actions in the same message ("set BBCA... then sell 2").
  const state = new Map<string, { lots: number; avg: number }>(
    (portfolio?.positions ?? []).map((p) => [p.symbol, { lots: p.lots, avg: p.avg_price }]),
  );

  const ensureSubscribed = async (symbol: string): Promise<void> => {
    if (trackedSymbols.includes(symbol)) return;
    try {
      await api.addSymbol(symbol); // validates on Yahoo, starts data collection
      results.push({ ok: true, text: `Subscribed ${symbol} for price tracking.` });
      trackedSymbols.push(symbol);
    } catch (err) {
      throw new Error(
        `${symbol} could not be validated on IDX (${err instanceof Error ? err.message : err})`,
      );
    }
  };

  for (const action of actions) {
    // Handled by the chat component's two-pass flow; a stray one that reaches
    // the executor is a no-op, not an error (and has no `symbol` to validate).
    if (action.type === "analyze") continue;
    const symbol = "symbol" in action ? action.symbol?.trim().toUpperCase() : "";
    try {
      if (!symbol || !/^[A-Z^][A-Z0-9.]{1,9}$/.test(symbol)) {
        throw new Error(`"${symbol}" is not a valid ticker`);
      }

      switch (action.type) {
        case "set_position": {
          if (!(action.lots > 0) || !(action.avg_price > 0)) {
            throw new Error("lots and average price must be positive");
          }
          if (action.avg_price < IDR_PRICE_MIN || action.avg_price > IDR_PRICE_MAX) {
            throw new Error(
              `price ${fmtIdr(action.avg_price)} is outside the plausible IDX per-share range (1–1.000.000 IDR)`,
            );
          }
          await ensureSubscribed(symbol);
          await portfolioApi.put(symbol, Math.round(action.lots), action.avg_price);
          state.set(symbol, { lots: Math.round(action.lots), avg: action.avg_price });
          results.push({
            ok: true,
            text: `✓ ${symbol}: ${Math.round(action.lots)} lots @ avg ${fmtIdr(action.avg_price)}`,
          });
          break;
        }
        case "add_purchase": {
          if (!(action.lots > 0) || !(action.price > 0)) {
            throw new Error("lots and price must be positive");
          }
          if (action.price < IDR_PRICE_MIN || action.price > IDR_PRICE_MAX) {
            throw new Error(
              `price ${fmtIdr(action.price)} is outside the plausible IDX per-share range (1–1.000.000 IDR)`,
            );
          }
          await ensureSubscribed(symbol);
          const cur = state.get(symbol);
          const addLots = Math.round(action.lots);
          // Weighted average — computed here, never by the model.
          const newLots = (cur?.lots ?? 0) + addLots;
          const newAvg = cur
            ? (cur.lots * cur.avg + addLots * action.price) / newLots
            : action.price;
          await portfolioApi.put(symbol, newLots, newAvg);
          state.set(symbol, { lots: newLots, avg: newAvg });
          results.push({
            ok: true,
            text: `✓ ${symbol}: +${addLots} lots @ ${fmtIdr(action.price)} → ${newLots} lots, avg ${fmtIdr(newAvg)}`,
          });
          break;
        }
        case "sell_lots": {
          const cur = state.get(symbol);
          if (!cur) throw new Error(`no ${symbol} position to sell from`);
          const sellLots = Math.round(action.lots);
          if (!(sellLots > 0)) throw new Error("lots must be positive");
          if (sellLots > cur.lots) {
            throw new Error(`you hold ${cur.lots} lots of ${symbol}, cannot sell ${sellLots}`);
          }
          const remaining = cur.lots - sellLots;
          if (remaining === 0) {
            await portfolioApi.delete(symbol);
            state.delete(symbol);
            results.push({ ok: true, text: `✓ ${symbol}: sold all — position closed` });
          } else {
            await portfolioApi.put(symbol, remaining, cur.avg);
            state.set(symbol, { lots: remaining, avg: cur.avg });
            results.push({
              ok: true,
              text: `✓ ${symbol}: −${sellLots} lots → ${remaining} lots, avg unchanged ${fmtIdr(cur.avg)}`,
            });
          }
          break;
        }
        case "remove_position": {
          await portfolioApi.delete(symbol);
          state.delete(symbol);
          results.push({ ok: true, text: `✓ ${symbol}: position removed` });
          break;
        }
        default:
          throw new Error(`unknown action type`);
      }
    } catch (err) {
      results.push({
        ok: false,
        text: `✗ ${symbol || "?"}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return results;
}

// ── Chat history persistence ────────────────────────────────────────────────

const CHAT_KEY = "lixionary.portfolio.chat";
const MAX_TURNS = 20;

export function loadChatHistory(): ChatTurn[] {
  try {
    const raw = localStorage.getItem(CHAT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as ChatTurn[]).slice(-MAX_TURNS) : [];
  } catch {
    return [];
  }
}

export function saveChatHistory(turns: ChatTurn[]): void {
  localStorage.setItem(CHAT_KEY, JSON.stringify(turns.slice(-MAX_TURNS)));
}

// ── Recommendations ─────────────────────────────────────────────────────────

const REC_SYSTEM_PROMPT = `You are a technical analyst reviewing a personal IDX stock portfolio. You receive: available cash (IDR), portfolio totals, and for each position its entry price, current price, lots (1 lot = 100 shares), market value, P&L, a 10-signal daily technical scorecard, daily relative volume (RVOL vs the 20-session average), and recent news sentiment tags. Recommend ONE action per position based ONLY on this data.

Respond with a single JSON object, no markdown fences:
{"positions": [{"symbol": "...", "action": "add_more"|"hold"|"reduce"|"cut_loss"|"take_profit", "summary": "<one sentence>", "reasons": ["<2-3 short bullets citing the data>"]}], "portfolio_note": "<one sentence on overall portfolio risk: concentration, cash allocation>"}

Guidance: "cut_loss" for deteriorating technicals with meaningful drawdown; "take_profit" for stretched gains with weakening signals; "add_more" (including averaging down) ONLY when technicals AND news support it AND available cash can plausibly fund a meaningful buy — one reason bullet must cite the cash constraint (approx cost = lots × 100 × price); never recommend add_more when cash is near zero. Be conservative — "hold" is the default when evidence is mixed. This is informational analysis, not advice; the app shows a disclaimer.`;

export interface RecommendationResponse {
  positions: {
    symbol: string;
    action: Recommendation["action"];
    summary: string;
    reasons: string[];
  }[];
  portfolio_note: string;
}

const REC_ACTIONS = new Set(["add_more", "hold", "reduce", "cut_loss", "take_profit"]);

export async function generateRecommendations(
  settings: LlmSettings,
  payload: object,
): Promise<RecommendationResponse> {
  const raw = await chat(settings, [
    { role: "system", content: REC_SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify(payload) },
  ]);
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("response was not JSON");
  const parsed = JSON.parse(text.slice(start, end + 1)) as {
    positions?: unknown;
    portfolio_note?: string;
  };
  const positions: RecommendationResponse["positions"] = [];
  if (Array.isArray(parsed.positions)) {
    for (const p of parsed.positions) {
      if (
        p &&
        typeof p === "object" &&
        typeof (p as { symbol?: string }).symbol === "string" &&
        REC_ACTIONS.has((p as { action?: string }).action ?? "")
      ) {
        const entry = p as { symbol: string; action: string; summary?: string; reasons?: unknown };
        positions.push({
          symbol: entry.symbol.toUpperCase(),
          action: entry.action as Recommendation["action"],
          summary: typeof entry.summary === "string" ? entry.summary : "",
          reasons: Array.isArray(entry.reasons)
            ? entry.reasons.filter((r): r is string => typeof r === "string").slice(0, 3)
            : [],
        });
      }
    }
  }
  return {
    positions,
    portfolio_note: typeof parsed.portfolio_note === "string" ? parsed.portfolio_note : "",
  };
}
