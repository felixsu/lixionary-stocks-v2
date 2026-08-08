"use client";

import { RefreshCw } from "lucide-react";

interface ErrorCardProps {
  message: string;
  onRetry?: () => void;
}

export function ErrorCard({ message, onRetry }: ErrorCardProps) {
  return (
    <div
      className="card-canvas"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 12,
        padding: "32px 24px",
        textAlign: "center",
      }}
    >
      <span className="body-sm" style={{ color: "var(--color-error)" }}>
        {message}
      </span>
      {onRetry && (
        <button className="btn btn-secondary btn-sm" onClick={onRetry}>
          <RefreshCw size={14} /> Retry
        </button>
      )}
    </div>
  );
}
