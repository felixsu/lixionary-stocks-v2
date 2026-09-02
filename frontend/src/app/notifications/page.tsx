"use client";

import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Bell,
  Check,
  CheckCircle2,
  Edit2,
  ExternalLink,
  Play,
  RefreshCw,
  Send,
  Sliders,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";

import { Badge } from "@/components/Badge";
import { ErrorCard } from "@/components/ErrorCard";
import { Skeleton } from "@/components/Skeleton";
import {
  type AlertTarget,
  type NotificationItem,
  type TelegramConfig,
  api,
  fetcher,
} from "@/lib/api";

const fmtRupiah = (val?: number | null) =>
  val != null ? `Rp ${Math.round(val).toLocaleString("id-ID")}` : "—";

export default function NotificationsPage() {
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<string | null>(null);

  // Modals state
  const [editingTarget, setEditingTarget] = useState<AlertTarget | null>(null);
  const [editEntry, setEditEntry] = useState<string>("");
  const [editStop, setEditStop] = useState<string>("");
  const [editTargetPrice, setEditTargetPrice] = useState<string>("");
  const [editBasis, setEditBasis] = useState<string>("");
  const [savingTarget, setSavingTarget] = useState(false);

  const [simulating, setSimulating] = useState(false);
  const [simSymbol, setSimSymbol] = useState<string>("");
  const [simType, setSimType] = useState<"entry_hit" | "target_hit" | "stop_hit">("entry_hit");
  const [simPrice, setSimPrice] = useState<string>("");
  const [simTargetPrice, setSimTargetPrice] = useState<string>("");
  const [simSendTg, setSimSendTg] = useState(true);
  const [simLoading, setSimLoading] = useState(false);

  // SWR queries
  const targetsSwr = useSWR<{ targets: AlertTarget[] }>("/api/notifications/targets", fetcher, {
    refreshInterval: 10_000,
  });
  const notifsSwr = useSWR<{ items: NotificationItem[]; unread_count: number }>(
    "/api/notifications?limit=100",
    fetcher,
    { refreshInterval: 10_000 },
  );
  const telegramSwr = useSWR<TelegramConfig>("/api/notifications/telegram", fetcher);

  const targets = targetsSwr.data?.targets ?? [];
  const notifications = notifsSwr.data?.items ?? [];
  const unreadCount = notifsSwr.data?.unread_count ?? 0;
  const telegramConfig = telegramSwr.data;

  // Run immediate price check
  async function handleCheckNow() {
    setChecking(true);
    setCheckResult(null);
    try {
      const res = await api.checkAlertsNow();
      targetsSwr.mutate();
      notifsSwr.mutate();
      if (res.triggered_count > 0) {
        setCheckResult(`Check complete: ${res.triggered_count} alert(s) triggered!`);
      } else {
        setCheckResult(`Checked ${res.evaluated_count} watchlist stocks. No price triggers.`);
      }
    } catch (err) {
      setCheckResult(`Check failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setChecking(false);
      setTimeout(() => setCheckResult(null), 5000);
    }
  }

  // Mark all read
  async function handleMarkAllRead() {
    try {
      await api.markNotificationsRead();
      notifsSwr.mutate();
    } catch {
      // ignore
    }
  }

  // Clear all notifications
  async function handleClearHistory() {
    if (!confirm("Clear all notification history?")) return;
    try {
      await api.clearNotifications();
      notifsSwr.mutate();
    } catch {
      // ignore
    }
  }

  // Open Edit Target modal
  function openEditModal(target: AlertTarget) {
    setEditingTarget(target);
    setEditEntry(target.entry != null ? String(target.entry) : "");
    setEditStop(target.stop != null ? String(target.stop) : "");
    setEditTargetPrice(target.target != null ? String(target.target) : "");
    setEditBasis(target.basis || "");
  }

  async function handleSaveCustomTarget() {
    if (!editingTarget) return;
    setSavingTarget(true);
    try {
      const entryNum = editEntry.trim() ? parseFloat(editEntry.trim()) : null;
      const stopNum = editStop.trim() ? parseFloat(editStop.trim()) : null;
      const targetNum = editTargetPrice.trim() ? parseFloat(editTargetPrice.trim()) : null;

      await api.updateAlertTarget(editingTarget.symbol, {
        entry: entryNum,
        stop: stopNum,
        target: targetNum,
        basis: editBasis.trim() || "Manual custom levels",
        enabled: true,
      });
      targetsSwr.mutate();
      setEditingTarget(null);
    } catch (err) {
      alert(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSavingTarget(false);
    }
  }

  async function handleResetToAi() {
    if (!editingTarget) return;
    setSavingTarget(true);
    try {
      await api.resetAlertTarget(editingTarget.symbol);
      targetsSwr.mutate();
      setEditingTarget(null);
    } catch (err) {
      alert(`Reset failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSavingTarget(false);
    }
  }

  // Open Simulation Modal
  function openSimulationModal() {
    const firstSym = targets[0]?.symbol || "BBCA";
    const curPrice = targets[0]?.current_price || 6300;
    setSimSymbol(firstSym);
    setSimType("entry_hit");
    setSimPrice(String(curPrice));
    setSimTargetPrice(String(curPrice));
    setSimSendTg(telegramConfig?.configured ?? false);
    setSimulating(true);
  }

  async function handleExecuteSimulation() {
    if (!simSymbol) return;
    setSimLoading(true);
    try {
      const curPrice = parseFloat(simPrice) || 6000;
      const tgtPrice = parseFloat(simTargetPrice) || curPrice;

      await api.simulateAlert({
        symbol: simSymbol,
        alert_type: simType,
        current_price: curPrice,
        target_price: tgtPrice,
        basis: "Manual trigger simulation test",
        send_telegram: simSendTg,
      });

      notifsSwr.mutate();
      setSimulating(false);
    } catch (err) {
      alert(`Simulation failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSimLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", display: "flex", flexDirection: "column", gap: 24 }}>
      {/* ── Top Header Card ────────────────────────────────────────────── */}
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 10,
                  background: "var(--color-surface-cream-strong)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--color-primary)",
                }}
              >
                <Bell size={20} />
              </div>
              <h3 style={{ margin: 0 }}>Watchlist Price Alerts</h3>
            </div>
            <p className="body-sm" style={{ margin: "6px 0 0 0", color: "var(--color-muted)" }}>
              Continuous monitoring for your watchlist. Triggers alerts when price hits Entry, Target, or Stop Loss levels, with optional Telegram dispatch.
            </p>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <button
              className="btn btn-secondary btn-sm"
              disabled={checking}
              onClick={handleCheckNow}
              title="Evaluate current market prices against targets now"
            >
              <RefreshCw size={14} className={checking ? "spin" : ""} />
              {checking ? "Checking…" : "Check Prices Now"}
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={openSimulationModal}
              title="Simulate an alert to preview in-app and Telegram notifications"
            >
              <Play size={14} /> Simulate Alert
            </button>
            {unreadCount > 0 && (
              <button className="btn btn-secondary btn-sm" onClick={handleMarkAllRead}>
                <Check size={14} /> Mark all read
              </button>
            )}
          </div>
        </div>

        {checkResult && (
          <div
            className="well"
            style={{
              padding: "10px 14px",
              background: "var(--color-surface-cream-strong)",
              color: "var(--color-ink)",
              fontSize: 13,
            }}
          >
            {checkResult}
          </div>
        )}

        {/* Status Indicators */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: 12,
            paddingTop: 8,
            borderTop: "1px solid var(--color-hairline)",
          }}
        >
          <div>
            <span className="caption" style={{ color: "var(--color-muted)" }}>Monitored Stocks</span>
            <div style={{ fontSize: 18, fontWeight: 600, color: "var(--color-ink)", marginTop: 2 }}>
              {targets.length} in watchlist
            </div>
          </div>
          <div>
            <span className="caption" style={{ color: "var(--color-muted)" }}>Triggered Alerts</span>
            <div style={{ fontSize: 18, fontWeight: 600, color: "var(--color-ink)", marginTop: 2 }}>
              {notifications.length} total {unreadCount > 0 && <span style={{ color: "var(--color-primary)", fontSize: 14 }}>({unreadCount} unread)</span>}
            </div>
          </div>
          <div>
            <span className="caption" style={{ color: "var(--color-muted)" }}>Telegram Dispatch</span>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
              {telegramConfig?.configured ? (
                <Badge className="badge-success">
                  <CheckCircle2 size={12} style={{ marginRight: 4 }} /> Connected
                </Badge>
              ) : (
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <Badge className="badge-default">Not configured</Badge>
                  <Link href="/settings" className="caption" style={{ color: "var(--color-primary)", textDecoration: "none" }}>
                    Configure →
                  </Link>
                </div>
              )}
            </div>
          </div>
          <div>
            <span className="caption" style={{ color: "var(--color-muted)" }}>Monitoring Schedule</span>
            <div style={{ fontSize: 13, color: "var(--color-muted-strong)", marginTop: 4 }}>
              Every 5m (09:00–16:30 WIB)
            </div>
          </div>
        </div>
      </div>

      {/* ── Section 1: Monitored Watchlist Stocks ──────────────────────── */}
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h5 style={{ margin: 0 }}>Watchlist Alert Monitors</h5>
            <p className="caption" style={{ margin: "2px 0 0 0", color: "var(--color-muted)" }}>
              Price targets are auto-derived from AI trade plans. Click &ldquo;Edit&rdquo; to set custom levels for any stock.
            </p>
          </div>
        </div>

        {targetsSwr.error ? (
          <ErrorCard message="Could not load watchlist alert targets." onRetry={() => targetsSwr.mutate()} />
        ) : !targetsSwr.data ? (
          <Skeleton height={160} />
        ) : targets.length === 0 ? (
          <div className="well" style={{ textAlign: "center", padding: 24 }}>
            <span className="body-sm" style={{ color: "var(--color-muted)" }}>
              No watchlist favorites yet. Add stocks in <Link href="/settings">Settings</Link> to start monitoring.
            </span>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--color-hairline)", textAlign: "left", color: "var(--color-muted)" }}>
                  <th style={{ padding: "8px 10px", fontWeight: 500 }}>Ticker</th>
                  <th style={{ padding: "8px 10px", fontWeight: 500 }}>Current</th>
                  <th style={{ padding: "8px 10px", fontWeight: 500 }}>Entry Zone</th>
                  <th style={{ padding: "8px 10px", fontWeight: 500 }}>Target</th>
                  <th style={{ padding: "8px 10px", fontWeight: 500 }}>Stop Loss</th>
                  <th style={{ padding: "8px 10px", fontWeight: 500 }}>Source</th>
                  <th style={{ padding: "8px 10px", fontWeight: 500, textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {targets.map((mon) => {
                  const p = mon.current_price;
                  return (
                    <tr
                      key={mon.symbol}
                      style={{
                        borderBottom: "1px solid var(--color-hairline-soft)",
                        transition: "background 0.15s ease",
                      }}
                    >
                      <td style={{ padding: "12px 10px" }}>
                        <Link
                          href={`/stocks/${encodeURIComponent(mon.symbol)}`}
                          style={{ fontWeight: 600, color: "var(--color-ink)", textDecoration: "none" }}
                        >
                          {mon.symbol}
                        </Link>
                        {mon.name && (
                          <div className="caption" style={{ color: "var(--color-muted)", fontSize: 11 }}>
                            {mon.name}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: "12px 10px", fontFamily: "var(--font-mono)", fontWeight: 500 }}>
                        {fmtRupiah(p)}
                      </td>
                      <td style={{ padding: "12px 10px" }}>
                        <div style={{ fontFamily: "var(--font-mono)" }}>
                          {fmtRupiah(mon.entry)}
                        </div>
                        {mon.entry_dist_pct != null && (
                          <span
                            className="caption"
                            style={{
                              color: mon.entry_dist_pct <= 0 ? "var(--color-primary)" : "var(--color-muted)",
                              fontSize: 11,
                            }}
                          >
                            {mon.entry_dist_pct <= 0 ? "In entry zone" : `${mon.entry_dist_pct}% away`}
                          </span>
                        )}
                        {mon.entry_triggered_today && (
                          <div style={{ marginTop: 2 }}>
                            <Badge className="badge-default" style={{ fontSize: 10 }}>Triggered today</Badge>
                          </div>
                        )}
                      </td>
                      <td style={{ padding: "12px 10px" }}>
                        <div style={{ fontFamily: "var(--font-mono)", color: "var(--color-success)" }}>
                          {fmtRupiah(mon.target)}
                        </div>
                        {mon.target_dist_pct != null && (
                          <span
                            className="caption"
                            style={{
                              color: mon.target_dist_pct <= 0 ? "var(--color-success)" : "var(--color-muted)",
                              fontSize: 11,
                            }}
                          >
                            {mon.target_dist_pct <= 0 ? "Target reached" : `+${mon.target_dist_pct}% to target`}
                          </span>
                        )}
                        {mon.target_triggered_today && (
                          <div style={{ marginTop: 2 }}>
                            <Badge className="badge-success" style={{ fontSize: 10 }}>Hit today</Badge>
                          </div>
                        )}
                      </td>
                      <td style={{ padding: "12px 10px" }}>
                        <div style={{ fontFamily: "var(--font-mono)", color: "var(--color-error)" }}>
                          {fmtRupiah(mon.stop)}
                        </div>
                        {mon.stop_dist_pct != null && (
                          <span className="caption" style={{ color: "var(--color-muted)", fontSize: 11 }}>
                            {mon.stop_dist_pct <= 0 ? "Stop breached" : `−${mon.stop_dist_pct}% stop`}
                          </span>
                        )}
                        {mon.stop_triggered_today && (
                          <div style={{ marginTop: 2 }}>
                            <Badge className="badge-error" style={{ fontSize: 10 }}>Hit today</Badge>
                          </div>
                        )}
                      </td>
                      <td style={{ padding: "12px 10px" }}>
                        {mon.source === "manual" ? (
                          <Badge className="badge-default" style={{ fontSize: 10 }}>
                            <Sliders size={10} style={{ marginRight: 3 }} /> Custom
                          </Badge>
                        ) : (
                          <Badge className="badge-default" style={{ fontSize: 10 }}>
                            <Sparkles size={10} style={{ marginRight: 3, color: "var(--color-primary)" }} /> AI Plan
                          </Badge>
                        )}
                      </td>
                      <td style={{ padding: "12px 10px", textAlign: "right" }}>
                        <button
                          className="btn btn-secondary btn-sm"
                          style={{ padding: "4px 8px" }}
                          onClick={() => openEditModal(mon)}
                        >
                          <Edit2 size={13} /> Edit
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Section 2: Triggered Notifications History ─────────────────── */}
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h5 style={{ margin: 0 }}>Notification History</h5>
            <p className="caption" style={{ margin: "2px 0 0 0", color: "var(--color-muted)" }}>
              Chronological log of alerts triggered when prices met entry or target levels.
            </p>
          </div>
          {notifications.length > 0 && (
            <button
              className="btn btn-secondary btn-sm"
              style={{ color: "var(--color-error)" }}
              onClick={handleClearHistory}
            >
              <Trash2 size={14} /> Clear History
            </button>
          )}
        </div>

        {notifsSwr.error ? (
          <ErrorCard message="Could not load notification history." onRetry={() => notifsSwr.mutate()} />
        ) : !notifsSwr.data ? (
          <Skeleton height={120} />
        ) : notifications.length === 0 ? (
          <div className="well" style={{ textAlign: "center", padding: 32 }}>
            <div style={{ color: "var(--color-muted)", marginBottom: 8 }}>
              <Bell size={28} style={{ opacity: 0.5 }} />
            </div>
            <div style={{ fontWeight: 500, color: "var(--color-ink)" }}>No alerts triggered yet</div>
            <p className="caption" style={{ color: "var(--color-muted)", margin: "4px 0 12px 0" }}>
              When prices touch entry or target levels, alerts will appear here and dispatch to Telegram.
            </p>
            <button className="btn btn-secondary btn-sm" onClick={openSimulationModal}>
              <Play size={13} /> Try Simulation Alert
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {notifications.map((item) => {
              const isTarget = item.alert_type === "target_hit";
              const isEntry = item.alert_type === "entry_hit";
              const isStop = item.alert_type === "stop_hit";

              let badgeClass = "badge-default";
              let alertLabel = "Price Alert";
              let AlertIcon = Bell;

              if (isTarget) {
                badgeClass = "badge-success";
                alertLabel = "Target Price Reached";
                AlertIcon = ArrowUpRight;
              } else if (isEntry) {
                badgeClass = "badge-primary";
                alertLabel = "Entry Price Hit";
                AlertIcon = ArrowDownRight;
              } else if (isStop) {
                badgeClass = "badge-error";
                alertLabel = "Stop Loss Hit";
                AlertIcon = AlertTriangle;
              }

              return (
                <div
                  key={item.id}
                  className="well"
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                    gap: 12,
                    padding: "12px 16px",
                    background: item.read ? "transparent" : "var(--color-surface-card)",
                    borderLeft: `3px solid ${
                      isTarget
                        ? "var(--color-success)"
                        : isEntry
                        ? "var(--color-primary)"
                        : isStop
                        ? "var(--color-error)"
                        : "var(--color-hairline)"
                    }`,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                    <div
                      style={{
                        marginTop: 2,
                        color: isTarget
                          ? "var(--color-success)"
                          : isEntry
                          ? "var(--color-primary)"
                          : "var(--color-error)",
                      }}
                    >
                      <AlertIcon size={18} />
                    </div>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <Link
                          href={`/stocks/${encodeURIComponent(item.symbol)}`}
                          style={{ fontWeight: 600, color: "var(--color-ink)", textDecoration: "none" }}
                        >
                          {item.symbol}
                        </Link>
                        {item.name && (
                          <span className="caption" style={{ color: "var(--color-muted)" }}>
                            {item.name}
                          </span>
                        )}
                        <Badge className={badgeClass} style={{ fontSize: 11 }}>
                          {alertLabel}
                        </Badge>
                        {item.simulated && (
                          <span className="role-pill" style={{ fontSize: 10 }}>Simulation</span>
                        )}
                      </div>

                      <div style={{ marginTop: 4, fontSize: 13, color: "var(--color-ink)" }}>
                        Current: <b>{fmtRupiah(item.current_price)}</b> • Target level: {fmtRupiah(item.target_price)}
                      </div>

                      {item.basis && (
                        <div className="caption" style={{ color: "var(--color-muted)", marginTop: 2 }}>
                          {item.basis}
                        </div>
                      )}
                    </div>
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flexShrink: 0 }}>
                    <span className="caption" style={{ color: "var(--color-muted)" }}>
                      {new Date(item.created_at).toLocaleTimeString("id-ID", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}{" "}
                      • {new Date(item.created_at).toLocaleDateString("id-ID", { month: "short", day: "numeric" })}
                    </span>

                    {item.telegram_status === "sent" ? (
                      <span className="caption" style={{ color: "var(--color-success)", display: "flex", alignItems: "center", gap: 4 }}>
                        <Send size={11} /> Telegram Sent
                      </span>
                    ) : item.telegram_status === "error" ? (
                      <span className="caption" style={{ color: "var(--color-error)" }}>
                        Telegram Failed
                      </span>
                    ) : (
                      <span className="caption" style={{ color: "var(--color-muted-soft)" }}>
                        In-app Only
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Modal: Edit Custom Target Levels ──────────────────────────── */}
      {editingTarget && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0, 0, 0, 0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
            padding: 16,
          }}
        >
          <div className="card" style={{ maxWidth: 460, width: "100%", display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <h4 style={{ margin: 0 }}>Edit Alert Levels: {editingTarget.symbol}</h4>
              <button className="btn-icon" onClick={() => setEditingTarget(null)}>
                <X size={16} />
              </button>
            </div>

            <p className="body-sm" style={{ margin: 0, color: "var(--color-muted)" }}>
              Customize threshold prices. Current market price: <b>{fmtRupiah(editingTarget.current_price)}</b>
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <label className="field-label">Entry Price (IDR)</label>
                <input
                  type="number"
                  className="input"
                  style={{ width: "100%" }}
                  placeholder="e.g. 6200"
                  value={editEntry}
                  onChange={(e) => setEditEntry(e.target.value)}
                />
                <span className="caption" style={{ color: "var(--color-muted)" }}>Alerts when price drops to or below this level</span>
              </div>

              <div>
                <label className="field-label">Target Price (IDR)</label>
                <input
                  type="number"
                  className="input"
                  style={{ width: "100%" }}
                  placeholder="e.g. 6800"
                  value={editTargetPrice}
                  onChange={(e) => setEditTargetPrice(e.target.value)}
                />
                <span className="caption" style={{ color: "var(--color-muted)" }}>Alerts when price rises to or exceeds this level</span>
              </div>

              <div>
                <label className="field-label">Stop Loss (IDR)</label>
                <input
                  type="number"
                  className="input"
                  style={{ width: "100%" }}
                  placeholder="e.g. 5900"
                  value={editStop}
                  onChange={(e) => setEditStop(e.target.value)}
                />
                <span className="caption" style={{ color: "var(--color-muted)" }}>Alerts when price breaches below this level</span>
              </div>

              <div>
                <label className="field-label">Notes / Rationale</label>
                <input
                  type="text"
                  className="input"
                  style={{ width: "100%" }}
                  placeholder="e.g. Support at previous swing low"
                  value={editBasis}
                  onChange={(e) => setEditBasis(e.target.value)}
                />
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 8 }}>
              {editingTarget.source === "manual" ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={savingTarget}
                  onClick={handleResetToAi}
                  style={{ color: "var(--color-error)" }}
                >
                  Revert to AI Plan
                </button>
              ) : <div />}

              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setEditingTarget(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={savingTarget}
                  onClick={handleSaveCustomTarget}
                >
                  {savingTarget ? "Saving…" : "Save Levels"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal: Simulate Alert ─────────────────────────────────────── */}
      {simulating && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0, 0, 0, 0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
            padding: 16,
          }}
        >
          <div className="card" style={{ maxWidth: 460, width: "100%", display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <h4 style={{ margin: 0 }}>Simulate Price Alert</h4>
              <button className="btn-icon" onClick={() => setSimulating(false)}>
                <X size={16} />
              </button>
            </div>

            <p className="body-sm" style={{ margin: 0, color: "var(--color-muted)" }}>
              Test notification triggers and Telegram delivery without waiting for live market moves.
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <label className="field-label">Stock Symbol</label>
                <select
                  className="select"
                  value={simSymbol}
                  onChange={(e) => {
                    setSimSymbol(e.target.value);
                    const sel = targets.find((t) => t.symbol === e.target.value);
                    if (sel?.current_price) setSimPrice(String(sel.current_price));
                  }}
                >
                  {targets.map((t) => (
                    <option key={t.symbol} value={t.symbol}>
                      {t.symbol} {t.name ? `— ${t.name}` : ""}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="field-label">Alert Signal</label>
                <select
                  className="select"
                  value={simType}
                  onChange={(e) => setSimType(e.target.value as typeof simType)}
                >
                  <option value="entry_hit">🛒 Entry Setup Hit</option>
                  <option value="target_hit">🎯 Target Price Reached</option>
                  <option value="stop_hit">🛑 Stop Loss Triggered</option>
                </select>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <label className="field-label">Simulated Price (IDR)</label>
                  <input
                    type="number"
                    className="input"
                    value={simPrice}
                    onChange={(e) => setSimPrice(e.target.value)}
                  />
                </div>
                <div>
                  <label className="field-label">Target Level (IDR)</label>
                  <input
                    type="number"
                    className="input"
                    value={simTargetPrice}
                    onChange={(e) => setSimTargetPrice(e.target.value)}
                  />
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                <input
                  type="checkbox"
                  id="simSendTg"
                  checked={simSendTg}
                  onChange={(e) => setSimSendTg(e.target.checked)}
                />
                <label htmlFor="simSendTg" className="body-sm" style={{ cursor: "pointer", color: "var(--color-ink)" }}>
                  Send live notification to Telegram {telegramConfig?.configured ? "(Connected)" : "(Not configured yet)"}
                </label>
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setSimulating(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={simLoading}
                onClick={handleExecuteSimulation}
              >
                {simLoading ? "Triggering…" : "Fire Simulation Alert"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
