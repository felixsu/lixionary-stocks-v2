"use client";

// Conversational portfolio entry. The LLM parses; executeActions applies with
// deterministic math; result lines render inline under each assistant reply.

import { Send, Settings, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { type SymbolOut } from "@/lib/api";
import { useLlmSettings } from "@/lib/llm";
import {
  type ChatAction,
  type ChatTurn,
  type Portfolio,
  executeActions,
  loadChatHistory,
  saveChatHistory,
  sendChatMessage,
} from "@/lib/portfolio";
import { analyzePositions } from "@/lib/position-analysis";

/** Cap on symbols fetched per analyze round (each costs candles + news). */
const MAX_ANALYZE_TARGETS = 6;

/** Minimal chat text renderer: "- " bullets and **bold**, nothing else. */
function ChatText({ text }: { text: string }) {
  return (
    <>
      {text.split("\n").map((line, i) => {
        const bullet = /^\s*[-•]\s+/.test(line);
        const parts = line.replace(/^\s*[-•]\s+/, "").split(/\*\*(.+?)\*\*/g);
        const spans = parts.map((p, j) => (j % 2 ? <strong key={j}>{p}</strong> : p));
        return bullet ? (
          <div key={i} style={{ display: "flex", gap: 6 }}>
            <span>•</span>
            <span>{spans}</span>
          </div>
        ) : (
          <div key={i}>{spans}</div>
        );
      })}
    </>
  );
}

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
  const [busyNote, setBusyNote] = useState<string | null>(null);
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
      const tracked = symbols.map((s) => ({ symbol: s.symbol, name: s.name }));
      let response = await sendChatMessage(settings, turns, message, portfolio, tracked);

      let results: ChatTurn["results"];
      const mutating = response.actions.filter((a) => a.type !== "analyze");
      if (mutating.length > 0) {
        results = await executeActions(
          mutating,
          portfolio,
          symbols.map((s) => s.symbol),
        );
        onPortfolioChanged();
      }

      // Advisory two-pass: the model may request scorecard/volume/news for
      // held symbols. Exactly one round — round-2 actions are dropped, so a
      // misbehaving model can neither loop nor mutate on the follow-up.
      const analyzeSyms = [
        ...new Set(
          response.actions
            .filter((a): a is Extract<ChatAction, { type: "analyze" }> => a.type === "analyze")
            .flatMap((a) => (Array.isArray(a.symbols) ? a.symbols : []))
            .map((s) => String(s).trim().toUpperCase()),
        ),
      ];
      if (analyzeSyms.length > 0 && portfolio) {
        const targets = portfolio.positions
          .filter((p) => analyzeSyms.includes(p.symbol))
          .slice(0, MAX_ANALYZE_TARGETS);
        if (targets.length > 0) {
          setBusyNote(`analysing ${targets.map((t) => t.symbol).join(", ")}…`);
          const analysisData = await analyzePositions(targets);
          response = await sendChatMessage(
            settings,
            [...turns, { role: "user", content: message }, { role: "assistant", content: response.reply }],
            message,
            portfolio,
            tracked,
            analysisData,
          );
        }
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
      setBusyNote(null);
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
              Tell me about your holdings, or ask for advice, e.g.:
            </p>
            <ul style={{ margin: "6px 0 0 0", paddingLeft: 18 }}>
              <li className="caption">&ldquo;I hold 10 lots of BBCA at average 6300&rdquo;</li>
              <li className="caption">&ldquo;Bought 5 more lots of CUAN at 1200 today&rdquo;</li>
              <li className="caption">&ldquo;What should I do with my BBCA position?&rdquo;</li>
              <li className="caption">&ldquo;Should I average down on my losers?&rdquo;</li>
            </ul>
          </div>
        )}

        {turns.map((t, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {t.content && (
              <div
                style={{
                  alignSelf: t.role === "user" ? "flex-end" : "flex-start",
                  maxWidth: t.role === "user" ? "85%" : "95%",
                  padding: "8px 12px",
                  borderRadius: 12,
                  fontSize: 13,
                  lineHeight: 1.5,
                  whiteSpace: "pre-wrap",
                  background:
                    t.role === "user"
                      ? "var(--color-surface-cream-strong)"
                      : "var(--color-canvas)",
                  border:
                    t.role === "user" ? "none" : "1px solid var(--color-hairline)",
                  color: "var(--color-body-strong)",
                }}
              >
                <ChatText text={t.content} />
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
            {busyNote ?? "thinking…"}
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
