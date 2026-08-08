"use client";

// Interactive canvas chart host: wheel = X zoom (shared via props), shift+wheel
// = Y zoom (this chart only), drag = pan, double-click = reset, hover =
// crosshair. Cursor and Y state live in refs and redraw imperatively through
// requestAnimationFrame so hover never re-renders React.

import { Minus, Plus, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { CHART_PADDING, type Cursor } from "@/lib/chart-draw";
import {
  DEFAULT_Y,
  type XViewport,
  type YState,
  isDefaultY,
  panX,
  panY,
  zoomVol,
  zoomX,
  zoomY,
} from "@/lib/viewport";

export interface ChartView {
  viewport: XViewport;
  yState: YState;
  cursor: Cursor | null;
  /** Volume-strip amplification factor (1 = fit tallest bar). */
  volZoom: number;
}

interface InteractiveChartProps {
  height: number;
  draw: (canvas: HTMLCanvasElement, view: ChartView) => void;
  /** Total loaded bars, used for viewport clamping. */
  barCount: number;
  /** Shared X viewport (same object across all charts on the screen). */
  viewport: XViewport;
  onViewportChange: (v: XViewport) => void;
  /** Chart renders a volume strip: enables the V zoom controls and routes
   *  shift+wheel over the strip to the volume scale. */
  hasVolume?: boolean;
}

export function InteractiveChart({
  height,
  draw,
  barCount,
  viewport,
  onViewportChange,
  hasVolume = false,
}: InteractiveChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const yRef = useRef<YState>(DEFAULT_Y);
  const volZoomRef = useRef(1);
  const cursorRef = useRef<Cursor | null>(null);
  const rafRef = useRef<number>(0);
  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const [hovered, setHovered] = useState(false);

  const propsRef = useRef({ draw, barCount, viewport, onViewportChange, hasVolume });
  propsRef.current = { draw, barCount, viewport, onViewportChange, hasVolume };

  const render = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      propsRef.current.draw(canvas, {
        viewport: propsRef.current.viewport,
        yState: yRef.current,
        cursor: cursorRef.current,
        volZoom: volZoomRef.current,
      });
    });
  }, []);

  // Redraw on prop changes (new data, viewport moved by a sibling chart, …).
  useEffect(() => {
    render();
  }, [draw, viewport, barCount, render]);

  // Redraw on resize.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(render);
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(rafRef.current);
    };
  }, [render]);

  // Wheel needs passive:false to keep the page from scrolling under the chart.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const plotW = rect.width - CHART_PADDING.left - CHART_PADDING.right;
      const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
      const factor = Math.exp(delta * 0.002);
      if (e.shiftKey) {
        // Volume strip = bottom 18% (+4px pad) of the canvas, when present.
        const volTop = rect.height - Math.round(rect.height * 0.18) - 4;
        if (propsRef.current.hasVolume && py >= volTop) {
          volZoomRef.current = zoomVol(volZoomRef.current, 1 / factor);
        } else {
          const yFrac = Math.min(1, Math.max(0, (py - CHART_PADDING.top) / (rect.height - CHART_PADDING.top)));
          yRef.current = zoomY(yRef.current, 1 / factor, yFrac);
        }
        render();
      } else {
        const anchorFrac = Math.min(1, Math.max(0, (px - CHART_PADDING.left) / plotW));
        propsRef.current.onViewportChange(
          zoomX(propsRef.current.viewport, propsRef.current.barCount, factor, anchorFrac),
        );
      }
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [render]);

  const barWidth = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return 8;
    const plotW = canvas.clientWidth - CHART_PADDING.left - CHART_PADDING.right;
    const count = Math.min(propsRef.current.viewport.count, propsRef.current.barCount || 1);
    return Math.max(1, plotW / count);
  }, []);

  return (
    <div
      style={{ position: "relative" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <canvas
        ref={canvasRef}
        style={{ width: "100%", height, display: "block", cursor: "crosshair", touchAction: "none" }}
        onPointerDown={(e) => {
          dragRef.current = { x: e.clientX, y: e.clientY, moved: false };
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const canvas = canvasRef.current;
          if (!canvas) return;
          const rect = canvas.getBoundingClientRect();
          const drag = dragRef.current;
          if (drag) {
            const dx = e.clientX - drag.x;
            const dy = e.clientY - drag.y;
            if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
            drag.x = e.clientX;
            drag.y = e.clientY;
            if (dx !== 0) {
              // Dragging right reveals older bars.
              propsRef.current.onViewportChange(
                panX(propsRef.current.viewport, propsRef.current.barCount, dx / barWidth()),
              );
            }
            if (dy !== 0 && !isDefaultY(yRef.current)) {
              yRef.current = panY(yRef.current, dy / (rect.height - CHART_PADDING.top));
            }
            cursorRef.current = null;
            render();
          } else {
            cursorRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
            render();
          }
        }}
        onPointerUp={() => {
          dragRef.current = null;
        }}
        onPointerLeave={() => {
          dragRef.current = null;
          cursorRef.current = null;
          render();
        }}
        onDoubleClick={() => {
          yRef.current = DEFAULT_Y;
          volZoomRef.current = 1;
          propsRef.current.onViewportChange({ offset: 0, count: propsRef.current.barCount });
          render();
        }}
      />

      {/* Control cluster — discoverable equivalents of the gestures. */}
      <div
        style={{
          position: "absolute",
          top: 6,
          right: 62,
          display: "flex",
          gap: 4,
          opacity: hovered ? 1 : 0,
          transition: "opacity 120ms ease",
          pointerEvents: hovered ? "auto" : "none",
        }}
      >
        <ChartButton
          label="X−"
          title="Zoom out (scroll)"
          onClick={() =>
            propsRef.current.onViewportChange(
              zoomX(propsRef.current.viewport, propsRef.current.barCount, 1.5, 1),
            )
          }
          icon={<Minus size={11} />}
        />
        <ChartButton
          label="X+"
          title="Zoom in (scroll)"
          onClick={() =>
            propsRef.current.onViewportChange(
              zoomX(propsRef.current.viewport, propsRef.current.barCount, 1 / 1.5, 1),
            )
          }
          icon={<Plus size={11} />}
        />
        <ChartButton
          label="Y−"
          title="Y zoom out (shift+scroll)"
          onClick={() => {
            yRef.current = zoomY(yRef.current, 1 / 1.4);
            render();
          }}
          icon={<Minus size={11} />}
        />
        <ChartButton
          label="Y+"
          title="Y zoom in (shift+scroll)"
          onClick={() => {
            yRef.current = zoomY(yRef.current, 1.4);
            render();
          }}
          icon={<Plus size={11} />}
        />
        {hasVolume && (
          <>
            <ChartButton
              label="V−"
              title="Shrink volume bars (shift+scroll over the volume strip)"
              onClick={() => {
                volZoomRef.current = zoomVol(volZoomRef.current, 1 / 1.5);
                render();
              }}
              icon={<Minus size={11} />}
            />
            <ChartButton
              label="V+"
              title="Amplify volume bars (shift+scroll over the volume strip)"
              onClick={() => {
                volZoomRef.current = zoomVol(volZoomRef.current, 1.5);
                render();
              }}
              icon={<Plus size={11} />}
            />
          </>
        )}
        <ChartButton
          label=""
          title="Reset view (double-click)"
          onClick={() => {
            yRef.current = DEFAULT_Y;
            volZoomRef.current = 1;
            propsRef.current.onViewportChange({
              offset: 0,
              count: propsRef.current.barCount,
            });
            render();
          }}
          icon={<RotateCcw size={11} />}
        />
      </div>
    </div>
  );
}

function ChartButton({
  label,
  title,
  onClick,
  icon,
}: {
  label: string;
  title: string;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        height: 24,
        padding: "0 7px",
        display: "inline-flex",
        alignItems: "center",
        gap: 2,
        borderRadius: 6,
        border: "1px solid var(--color-hairline)",
        background: "var(--color-canvas)",
        color: "var(--color-muted)",
        fontSize: 10,
        fontWeight: 600,
        fontFamily: "var(--font-sans)",
        cursor: "pointer",
      }}
    >
      {label}
      {icon}
    </button>
  );
}
