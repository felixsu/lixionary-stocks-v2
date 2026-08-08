"use client";

// Dashboard favorites + default-timeframe preference, persisted in localStorage.
// Favorites are a client-side subset of the backend's subscribed symbols —
// unfavoriting never touches the backend, so polling and 5m history
// accumulation continue regardless of what's shown on the dashboard.

import { useCallback, useSyncExternalStore } from "react";

import { DEFAULT_TIMEFRAME, type TimeframeId, isTimeframeId } from "./timeframes";

export const MAX_FAVORITES = 10;

const FAVORITES_KEY = "lixionary.favorites";
const TIMEFRAME_KEY = "lixionary.defaultTimeframe";

const listeners = new Set<() => void>();

function emit(): void {
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

// useSyncExternalStore requires a referentially-stable snapshot, so cache the
// parsed array against its raw string.
let cachedRaw: string | null = null;
let cachedList: string[] = [];

function readFavorites(): string[] {
  const raw = localStorage.getItem(FAVORITES_KEY);
  if (raw === cachedRaw) return cachedList;
  cachedRaw = raw;
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    cachedList = Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string").slice(0, MAX_FAVORITES)
      : [];
  } catch {
    cachedList = [];
  }
  return cachedList;
}

const EMPTY: string[] = [];

export function useFavorites() {
  const favorites = useSyncExternalStore(subscribe, readFavorites, () => EMPTY);

  const add = useCallback((code: string) => {
    const current = readFavorites();
    if (current.includes(code) || current.length >= MAX_FAVORITES) return;
    localStorage.setItem(FAVORITES_KEY, JSON.stringify([...current, code]));
    emit();
  }, []);

  const remove = useCallback((code: string) => {
    const current = readFavorites();
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(current.filter((c) => c !== code)));
    emit();
  }, []);

  return { favorites, add, remove };
}

function readTimeframe(): TimeframeId {
  const raw = localStorage.getItem(TIMEFRAME_KEY);
  return isTimeframeId(raw) ? raw : DEFAULT_TIMEFRAME;
}

export function useDefaultTimeframe() {
  const defaultTimeframe = useSyncExternalStore(subscribe, readTimeframe, () => DEFAULT_TIMEFRAME);

  const setDefaultTimeframe = useCallback((tf: TimeframeId) => {
    localStorage.setItem(TIMEFRAME_KEY, tf);
    emit();
  }, []);

  return { defaultTimeframe, setDefaultTimeframe };
}
