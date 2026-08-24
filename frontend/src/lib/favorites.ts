"use client";

// Dashboard favorites + default-timeframe preference, persisted in localStorage
// and synchronized to the backend for scheduled AI analytics.

import { useCallback, useEffect, useSyncExternalStore } from "react";

import { api } from "./api";
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

let hasInitializedBackendSync = false;

function syncToBackend(symbols: string[]) {
  api.putFavorites(symbols).catch(() => {
    /* silent background sync */
  });
}

const EMPTY: string[] = [];

export function useFavorites() {
  const favorites = useSyncExternalStore(subscribe, readFavorites, () => EMPTY);

  useEffect(() => {
    if (typeof window === "undefined" || hasInitializedBackendSync) return;
    hasInitializedBackendSync = true;
    const current = readFavorites();
    if (current.length > 0) {
      syncToBackend(current);
    } else {
      api
        .getFavorites()
        .then((res) => {
          if (res.symbols && res.symbols.length > 0 && readFavorites().length === 0) {
            localStorage.setItem(FAVORITES_KEY, JSON.stringify(res.symbols));
            emit();
          }
        })
        .catch(() => {});
    }
  }, []);

  const add = useCallback((code: string) => {
    const current = readFavorites();
    const clean = code.trim().toUpperCase();
    if (current.includes(clean) || current.length >= MAX_FAVORITES) return;
    const next = [...current, clean];
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
    emit();
    syncToBackend(next);
  }, []);

  const remove = useCallback((code: string) => {
    const current = readFavorites();
    const clean = code.trim().toUpperCase();
    const next = current.filter((c) => c !== clean);
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
    emit();
    syncToBackend(next);
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
