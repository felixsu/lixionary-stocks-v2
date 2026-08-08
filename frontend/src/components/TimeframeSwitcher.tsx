"use client";

// Segmented pill group: active = indigo fill + white text, inactive =
// transparent + body text (per design).

import { TIMEFRAMES, type TimeframeId } from "@/lib/timeframes";

interface TimeframeSwitcherProps {
  value: TimeframeId;
  onChange: (tf: TimeframeId) => void;
}

export function TimeframeSwitcher({ value, onChange }: TimeframeSwitcherProps) {
  return (
    <div
      style={{
        display: "flex",
        gap: 6,
        background: "var(--color-surface-card)",
        padding: 4,
        borderRadius: 10,
        width: "fit-content",
      }}
    >
      {TIMEFRAMES.map((tf) => {
        const active = tf.id === value;
        return (
          <button
            key={tf.id}
            onClick={() => onChange(tf.id)}
            style={{
              height: 32,
              padding: "0 14px",
              borderRadius: 8,
              border: "none",
              fontSize: 13,
              fontWeight: 500,
              cursor: "pointer",
              background: active ? "var(--color-primary)" : "transparent",
              color: active ? "#fff" : "var(--color-body)",
              transition: "background 120ms ease",
            }}
          >
            {tf.label}
          </button>
        );
      })}
    </div>
  );
}
