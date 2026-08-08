"use client";

import { ExternalLink, Newspaper } from "lucide-react";
import Link from "next/link";
import useSWR from "swr";

import { Badge } from "@/components/Badge";
import { type NewsList, fetcher, newsKey } from "@/lib/api";

const SENTIMENT_BADGE = {
  bullish: "badge-success",
  bearish: "badge-error",
  neutral: "badge-default",
} as const;

const WIB_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Jakarta",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function RelatedNewsCard({ symbol }: { symbol: string }) {
  const { data } = useSWR<NewsList>(newsKey({ symbol, limit: 5 }), fetcher, {
    refreshInterval: 300_000,
  });

  // Nothing tagged yet (or analysis disabled): stay out of the way entirely.
  if (!data || data.items.length === 0) return null;

  return (
    <div className="card-canvas" style={{ padding: "18px 22px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Newspaper size={15} style={{ color: "var(--color-muted)" }} />
          <span className="caption">Related news</span>
        </div>
        <Link href="/news" className="caption" style={{ textDecoration: "none" }}>
          All news
        </Link>
      </div>
      <div style={{ display: "flex", flexDirection: "column", marginTop: 4 }}>
        {data.items.map((item) => {
          const tag = item.analysis?.symbols.find((s) => s.symbol === symbol);
          return (
            <div
              key={item.url}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 0",
                borderBottom: "1px solid var(--color-hairline-soft)",
              }}
            >
              {item.analysis && (
                <Badge className={SENTIMENT_BADGE[item.analysis.sentiment]} small>
                  {tag ? (tag.direction === "positive" ? "▲" : "▼") : item.analysis.sentiment}
                </Badge>
              )}
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                title={tag?.reason ?? item.analysis?.note ?? ""}
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 13,
                  color: "var(--color-body-strong)",
                  textDecoration: "none",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {item.title}
              </a>
              <span className="caption" style={{ color: "var(--color-muted-soft)", flexShrink: 0 }}>
                {WIB_TIME.format(new Date(item.published_at))}
              </span>
              <ExternalLink size={11} style={{ color: "var(--color-muted-soft)", flexShrink: 0 }} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
