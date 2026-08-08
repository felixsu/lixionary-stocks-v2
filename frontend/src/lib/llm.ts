"use client";

// LLM analysis: provider registry, browser-stored settings, prompt building,
// and lenient response parsing.
//
// All three supported providers expose OpenAI-compatible chat-completions
// endpoints, so a single request shape serves them all (via /api/llm, which
// exists purely to sidestep browser CORS — the key is stored in localStorage
// and transits only through this app's own server per request).

import { useCallback, useSyncExternalStore } from "react";

import type { Bar } from "./api";
import type { AiSignal, IchimokuResult, MacdResult, SupportResistance } from "./indicators";
import type { SessionRvol, VolumeSpike } from "./volume";

export type ProviderId = "gemini" | "minimax" | "openai";

export interface Provider {
  id: ProviderId;
  label: string;
  baseUrl: string;
  /** Shown when the live /models fetch fails. */
  fallbackModels: string[];
  /** Client-side filter for the live model list. */
  modelFilter: (id: string) => boolean;
  keyPlaceholder: string;
}

export const PROVIDERS: Provider[] = [
  {
    id: "gemini",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    fallbackModels: ["gemini-3.1-pro", "gemini-3.6-flash", "gemini-2.5-pro", "gemini-2.5-flash"],
    modelFilter: (id) => id.includes("gemini") && !/image|embed|tts|audio|live|veo|imagen/.test(id),
    keyPlaceholder: "AIza…",
  },
  {
    id: "minimax",
    label: "MiniMax",
    baseUrl: "https://api.minimax.io/v1",
    fallbackModels: ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.5"],
    modelFilter: (id) => /minimax|abab/i.test(id) && !/speech|music|video|embed/i.test(id),
    keyPlaceholder: "MiniMax API key",
  },
  {
    id: "openai",
    label: "ChatGPT (OpenAI)",
    baseUrl: "https://api.openai.com/v1",
    fallbackModels: ["gpt-5.6", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4"],
    modelFilter: (id) =>
      /^(gpt|o\d)/.test(id) &&
      !/audio|realtime|image|tts|whisper|embed|moderation|transcribe|search|codex/.test(id),
    keyPlaceholder: "sk-…",
  },
];

export function providerById(id: string | null | undefined): Provider | null {
  return PROVIDERS.find((p) => p.id === id) ?? null;
}

// ── Settings (localStorage) ─────────────────────────────────────────────────

export interface LlmSettings {
  provider: ProviderId | "";
  model: string;
  apiKey: string;
}

const SETTINGS_KEY = "lixionary.llm";
const EMPTY_SETTINGS: LlmSettings = { provider: "", model: "", apiKey: "" };

const listeners = new Set<() => void>();
function emit() {
  for (const l of listeners) l();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

let cachedRaw: string | null = null;
let cachedSettings: LlmSettings = EMPTY_SETTINGS;

function readSettings(): LlmSettings {
  const raw = localStorage.getItem(SETTINGS_KEY);
  if (raw === cachedRaw) return cachedSettings;
  cachedRaw = raw;
  try {
    const parsed = raw ? (JSON.parse(raw) as Partial<LlmSettings>) : {};
    cachedSettings = {
      provider: providerById(parsed.provider)?.id ?? "",
      model: typeof parsed.model === "string" ? parsed.model : "",
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
    };
  } catch {
    cachedSettings = EMPTY_SETTINGS;
  }
  return cachedSettings;
}

export function isConfigured(s: LlmSettings): boolean {
  return Boolean(s.provider && s.model && s.apiKey);
}

export function useLlmSettings() {
  const settings = useSyncExternalStore(subscribe, readSettings, () => EMPTY_SETTINGS);
  const update = useCallback((changes: Partial<LlmSettings>) => {
    const next = { ...readSettings(), ...changes };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    emit();
  }, []);
  return { settings, update, configured: isConfigured(settings) };
}

// ── Proxy client ────────────────────────────────────────────────────────────

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

async function callProxy(body: object): Promise<Response> {
  return fetch("/api/llm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function fetchModels(settings: LlmSettings): Promise<string[]> {
  const provider = providerById(settings.provider);
  if (!provider) return [];
  if (!settings.apiKey) return provider.fallbackModels;
  try {
    const res = await callProxy({
      action: "models",
      provider: provider.id,
      apiKey: settings.apiKey,
    });
    if (!res.ok) return provider.fallbackModels;
    const data = (await res.json()) as { data?: { id?: string }[] };
    const ids = (data.data ?? [])
      .map((m) => m.id ?? "")
      .filter((id) => id && provider.modelFilter(id))
      .sort()
      .reverse(); // newest naming first, roughly
    return ids.length ? ids : provider.fallbackModels;
  } catch {
    return provider.fallbackModels;
  }
}

export async function chat(settings: LlmSettings, messages: ChatMessage[]): Promise<string> {
  const res = await callProxy({
    action: "chat",
    provider: settings.provider,
    apiKey: settings.apiKey,
    model: settings.model,
    messages,
  });
  const data = (await res.json().catch(() => null)) as {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string } | string;
    detail?: string;
  } | null;
  if (!res.ok) {
    const msg =
      (typeof data?.error === "object" ? data.error?.message : data?.error) ||
      data?.detail ||
      `provider returned HTTP ${res.status}`;
    throw new Error(msg);
  }
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("provider returned an empty response");
  return content;
}

// ── Prompt & result ─────────────────────────────────────────────────────────

export interface AnalysisResult {
  stance: "bullish" | "bearish" | "neutral";
  summary: string;
  bullets: string[];
  risks: string[];
  generatedAt: string;
  provider: string;
  model: string;
}

export interface AnalysisInput {
  symbol: string;
  name: string | null;
  timeframe: string;
  price: number;
  changePct: number;
  dayLow: number;
  dayHigh: number;
  bars: Bar[];
  rsi: number | null;
  macd: MacdResult;
  ichimoku: IchimokuResult;
  sr: SupportResistance;
  heuristic: AiSignal;
  sessionVolume: SessionRvol | null;
  volumeSpike: VolumeSpike | null;
  ihsgCorrelation: number | null;
}

const SYSTEM_PROMPT = `You are a technical analyst covering Indonesia Stock Exchange (IDX) equities. You are given computed indicator data for one stock on one timeframe; the price feed is delayed about 10 minutes. Analyse ONLY the data provided — do not invent news, fundamentals, or prices.

Respond with a single JSON object, no markdown fences, exactly this shape:
{"stance": "bullish"|"bearish"|"neutral", "summary": "<one sentence overall read>", "bullets": ["<3 to 5 short observations grounded in the data>"], "risks": ["<1 to 2 things that would invalidate this read>"]}

Be specific and quantitative (cite the numbers you were given). This is informational analysis, not investment advice, and the app already displays a disclaimer — do not add one.`;

export function buildAnalysisMessages(input: AnalysisInput): ChatMessage[] {
  const i = input.bars.length - 1;
  const last = <T,>(arr: (T | null)[]): T | null => (i >= 0 ? arr[i] : null);
  const recent = input.bars.slice(-20).map((b) => ({
    t: b.ts,
    o: b.o,
    h: b.h,
    l: b.l,
    c: b.c,
    v: b.v,
  }));
  const price = input.price;
  const cloudTop = Math.max(input.ichimoku.senkouA[i] ?? 0, input.ichimoku.senkouB[i] ?? 0);
  const cloudBottom = Math.min(input.ichimoku.senkouA[i] ?? 0, input.ichimoku.senkouB[i] ?? 0);

  const payload = {
    symbol: input.symbol,
    name: input.name,
    timeframe: input.timeframe,
    last_price: price,
    change_pct_vs_prev_close: round2(input.changePct),
    day_range: { low: input.dayLow, high: input.dayHigh },
    recent_bars: recent,
    indicators: {
      rsi14: input.rsi != null ? round2(input.rsi) : null,
      macd: {
        line: round4(last(input.macd.line)),
        signal: round4(last(input.macd.signal)),
        histogram: round4(last(input.macd.hist)),
      },
      ichimoku: {
        tenkan: round2(input.ichimoku.tenkan[i]),
        kijun: round2(input.ichimoku.kijun[i]),
        cloud_top: round2(cloudTop),
        cloud_bottom: round2(cloudBottom),
        price_vs_cloud:
          price > cloudTop ? "above" : price < cloudBottom ? "below" : "inside",
      },
      support: round2(input.sr.support),
      resistance: round2(input.sr.resistance),
    },
    volume: {
      session_rvol: input.sessionVolume
        ? {
            ratio: round2(input.sessionVolume.rvol),
            session_date: input.sessionVolume.sessionDate,
            baseline_sessions: input.sessionVolume.baselineSessions,
            note: "cumulative session volume vs average at same time-of-day",
          }
        : null,
      last_bar_zscore: input.volumeSpike ? round2(input.volumeSpike.zScore) : null,
    },
    correlation_with_ihsg_daily:
      input.ihsgCorrelation != null ? round2(input.ihsgCorrelation) : null,
    heuristic_read: {
      stance: input.heuristic.stance,
      reasons: input.heuristic.reasons,
      note: "simple rule-based read; you may confirm or dispute it",
    },
  };

  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify(payload) },
  ];
}

function round2(v: number | null): number | null {
  return v == null ? null : Math.round(v * 100) / 100;
}
function round4(v: number | null): number | null {
  return v == null ? null : Math.round(v * 10000) / 10000;
}

/** Parse the model's reply, tolerating markdown fences and stray prose. */
export function parseAnalysis(raw: string): Omit<AnalysisResult, "generatedAt" | "provider" | "model"> {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("response was not JSON");
  }
  const parsed = JSON.parse(text.slice(start, end + 1)) as {
    stance?: string;
    summary?: string;
    bullets?: unknown;
    risks?: unknown;
  };
  const stance =
    parsed.stance === "bullish" || parsed.stance === "bearish" ? parsed.stance : "neutral";
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return {
    stance,
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    bullets: strings(parsed.bullets),
    risks: strings(parsed.risks),
  };
}

// ── Result cache (localStorage, per symbol+timeframe) ───────────────────────

const CACHE_PREFIX = "lixionary.analysis.";

export function cachedAnalysis(symbol: string, timeframe: string): AnalysisResult | null {
  try {
    const raw = localStorage.getItem(`${CACHE_PREFIX}${symbol}.${timeframe}`);
    return raw ? (JSON.parse(raw) as AnalysisResult) : null;
  } catch {
    return null;
  }
}

export function storeAnalysis(symbol: string, timeframe: string, result: AnalysisResult): void {
  localStorage.setItem(`${CACHE_PREFIX}${symbol}.${timeframe}`, JSON.stringify(result));
}
