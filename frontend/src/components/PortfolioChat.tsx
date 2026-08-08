"use client";

// Conversational portfolio entry. The LLM parses; executeActions applies with
// deterministic math; result lines render inline under each assistant reply.

import { Send, Settings, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { type SymbolOut } from "@/lib/api";
import { useLlmSettings } from "@/lib/llm";
import {
  type ChatTurn,
  type Portfolio,
  executeActions,
  loadChatHistory,
  saveChatHistory,
  sendChatMessage,
} from "@/lib/portfolio";

export function PortfolioChat({
  portfolio,
  symbols,
  onPortfolioChanged,
}: {
  portfolio: Portfolio | null;
  symbols: SymbolOut[];
  onPortfolioChanged: () => void;
}) {
  const { settings, configured } = useLlmSettings();
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTurns(loadChatHistory());
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, busy]);

  async function send() {
    const message = input.trim();
    if (!message || busy) return;
    setInput("");
    setBusy(true);

    const withUser: ChatTurn[] = [...turns, { role: "user", content: message }];
    setTurns(withUser);

    try {
      const response = await sendChatMessage(
        settings,
        turns,
        message,
        portfolio,
        symbols.map((s) => ({ symbol: s.symbol, name: s.name })),
      );
      let results: ChatTurn["results"];
      if (response.actions.length > 0) {
        results = await executeActions(
          response.actions,
          portfolio,
          symbols.map((s) => s.symbol),
        );
        onPortfolioChanged();
      }
      const next: ChatTurn[] = [
        ...withUser,
        { role: "assistant", content: response.reply, results },
      ];
      setTurns(next);
      saveChatHistory(next);
    } catch (err) {
      const next: ChatTurn[] = [
        ...withUser,
        {
          role: "assistant",
          content: "",
          results: [
            { ok: false, text: err instanceof Error ? err.message : String(err) },
          ],
        },
      ];
      setTurns(next);
      saveChatHistory(next);
    } finally {
      setBusy(false);
    }
  }

  if (!configured) {
    return (
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <span className="field-label" style={{ margin: 0 }}>
          Assistant
        </span>
        <div className="well" style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "space-between" }}>
          <span className="body-sm" style={{ color: "var(--color-muted)" }}>
            Chat entry is disabled — missing LLM configuration.
          </span>
          <Link href="/settings" className="btn btn-secondary btn-sm" style={{ textDecoration: "none" }}>
            <Settings size={14} /> Configure
          </Link>
        </div>
        <span className="caption" style={{ color: "var(--color-muted-soft)" }}>
          You can still add positions with the manual form.
        </span>
      </div>
    );
  }

  return (
    <div
      className="card"
      style={{ display: "flex", flexDirection: "column", gap: 12, height: 560 }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span className="field-label" style={{ margin: 0 }}>
          Assistant
        </span>
        {turns.length > 0 && (
          <button
            className="btn-icon"
            style={{ width: 28, height: 28 }}
            title="Clear conversation"
            onClick={() => {
              setTurns([]);
              saveChatHistory([]);
            }}
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>

      <div
        ref={scrollRef}
        style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10 }}
      >
        {turns.length === 0 && (
          <div className="well">
            <p className="body-sm" style={{ margin: 0, color: "var(--color-muted)" }}>
              Tell me about your holdings in plain language, e.g.:
            </p>
            <ul style={{ margin: "6px 0 0 0", paddingLeft: 18 }}>
              <li className="caption">&ldquo;I hold 10 lots of BBCA at average 6300&rdquo;</li>
              <li className="caption">&ldquo;Bought 5 more lots of CUAN at 1200 today&rdquo;</li>
              <li className="caption">&ldquo;Sold 3 lots of BUMI&rdquo;</li>
            </ul>
          </div>
        )}

        {turns.map((t, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {t.content && (
              <div
                style={{
                  alignSelf: t.role === "user" ? "flex-end" : "flex-start",
                  maxWidth: "85%",
                  padding: "8px 12px",
                  borderRadius: 12,
                  fontSize: 13,
                  lineHeight: 1.5,
                  background:
                    t.role === "user"
                      ? "var(--color-surface-cream-strong)"
                      : "var(--color-canvas)",
                  border:
                    t.role === "user" ? "none" : "1px solid var(--color-hairline)",
                  color: "var(--color-body-strong)",
                }}
              >
                {t.content}
              </div>
            )}
            {t.results?.map((r, j) => (
              <span
                key={j}
                className="caption"
                style={{
                  alignSelf: "flex-start",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: r.ok ? "#3f8a4f" : "var(--color-error)",
                }}
              >
                {r.text}
              </span>
            ))}
          </div>
        ))}

        {busy && (
          <span className="caption" style={{ color: "var(--color-muted-soft)" }}>
            thinking…
          </span>
        )}
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <input
          className="input"
          style={{ flex: 1 }}
          placeholder="e.g. I bought 10 lots of BBCA at 6300"
          value={input}
          disabled={busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
          }}
        />
        <button
          className="btn btn-primary"
          style={{ padding: "0 14px" }}
          disabled={busy || !input.trim()}
          onClick={send}
          title="Send"
        >
          <Send size={15} />
        </button>
      </div>
    </div>
  );
}
