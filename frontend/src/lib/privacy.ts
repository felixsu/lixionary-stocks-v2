"use client";

// Hide-amounts preference: mask personal money amounts (screen-share privacy).
// Same subscribe/emit + useSyncExternalStore pattern as favorites.ts — that
// module keeps its listeners private, so the block is replicated here.

import { useCallback, useSyncExternalStore } from "react";

const KEY = "lixionary.hideAmounts";

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

function readHidden(): boolean {
  return localStorage.getItem(KEY) === "1";
}

export function useHideAmounts(): { hidden: boolean; toggle: () => void } {
  const hidden = useSyncExternalStore(subscribe, readHidden, () => false);

  const toggle = useCallback(() => {
    localStorage.setItem(KEY, readHidden() ? "0" : "1");
    emit();
  }, []);

  return { hidden, toggle };
}

/** Mask a formatted rupiah amount. Mono-font dots keep column widths stable. */
export function masked(hidden: boolean, formatted: string): string {
  return hidden ? "Rp ••• •••" : formatted;
}

/** Mask a bare number (lots) — no currency prefix. */
export function maskedPlain(hidden: boolean, formatted: string): string {
  return hidden ? "•••" : formatted;
}
