// The four timeframes the design exposes (the backend also serves 15m/30m/4h).

export type TimeframeId = "5m" | "1h" | "2h" | "1d";

export interface Timeframe {
  id: TimeframeId;
  label: string;
}

export const TIMEFRAMES: Timeframe[] = [
  { id: "5m", label: "5 minutes" },
  { id: "1h", label: "1 hour" },
  { id: "2h", label: "2 hours" },
  { id: "1d", label: "Daily" },
];

export const DEFAULT_TIMEFRAME: TimeframeId = "1d";

export function timeframeLabel(id: TimeframeId): string {
  return TIMEFRAMES.find((t) => t.id === id)?.label ?? id;
}

export function isTimeframeId(v: string | null | undefined): v is TimeframeId {
  return TIMEFRAMES.some((t) => t.id === v);
}
