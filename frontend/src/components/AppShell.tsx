"use client";

// App frame from the design: fixed 240px sidebar + 64px topbar + scrollable
// content column.

import { LayoutDashboard, LineChart, Newspaper, Settings, Wallet } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, match: (p: string) => p === "/" },
  {
    href: "/portfolio",
    label: "Portfolio",
    icon: Wallet,
    match: (p: string) => p.startsWith("/portfolio"),
  },
  {
    href: "/stocks",
    label: "Stock analysis",
    icon: LineChart,
    match: (p: string) => p.startsWith("/stocks"),
  },
  {
    href: "/news",
    label: "News",
    icon: Newspaper,
    match: (p: string) => p.startsWith("/news"),
  },
  {
    href: "/settings",
    label: "Settings",
    icon: Settings,
    match: (p: string) => p.startsWith("/settings"),
  },
];

function pageTitle(pathname: string): string {
  if (pathname.startsWith("/portfolio")) return "Portfolio";
  if (pathname.startsWith("/stocks")) return "Stock analysis";
  if (pathname.startsWith("/news")) return "News";
  if (pathname.startsWith("/settings")) return "Settings";
  return "Dashboard";
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div
      style={{
        display: "flex",
        minHeight: "100vh",
        fontFamily: "var(--font-sans)",
        background: "var(--color-canvas)",
      }}
    >
      <div
        style={{
          width: 240,
          flexShrink: 0,
          borderRight: "1px solid var(--color-hairline)",
          display: "flex",
          flexDirection: "column",
          padding: "24px 16px",
          gap: 4,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "0 8px",
            marginBottom: 28,
          }}
        >
          <span style={{ fontFamily: "var(--font-serif)", fontSize: 22, color: "var(--color-ink)" }}>
            Lixionary
          </span>
          <span
            style={{
              width: 5,
              height: 5,
              borderRadius: 9999,
              background: "var(--color-primary)",
              display: "inline-block",
            }}
          />
        </div>

        {NAV.map(({ href, label, icon: Icon, match }) => {
          const active = match(pathname);
          return (
            <Link
              key={href}
              href={href}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                height: 40,
                padding: "0 12px",
                borderRadius: 8,
                background: active ? "var(--color-surface-cream-strong)" : "transparent",
                color: "var(--color-ink)",
                fontSize: 14,
                fontWeight: active ? 500 : 400,
                textDecoration: "none",
              }}
            >
              <Icon
                size={18}
                style={{ color: active ? "var(--color-primary)" : "var(--color-muted)" }}
              />
              <span>{label}</span>
            </Link>
          );
        })}

        <div style={{ flex: 1 }} />
        <div
          style={{
            padding: 12,
            borderRadius: 10,
            background: "var(--color-surface-card)",
            fontSize: 12,
            color: "var(--color-muted)",
            lineHeight: 1.5,
          }}
        >
          IDX data delayed ~10 minutes (Yahoo Finance). Not investment advice.
        </div>
      </div>

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div
          style={{
            height: 64,
            flexShrink: 0,
            borderBottom: "1px solid var(--color-hairline)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 32px",
          }}
        >
          <h4 style={{ margin: 0 }}>{pageTitle(pathname)}</h4>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span className="caption" style={{ color: "var(--color-muted)" }}>
              Delayed ~10 min
            </span>
            <div
              className="avatar"
              style={{ width: 32, height: 32, fontSize: 13 }}
            >
              F
            </div>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto" }}>{children}</div>
      </div>
    </div>
  );
}
