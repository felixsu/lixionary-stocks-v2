"use client";

// Canvas wrapper: hands the element to an imperative draw function and redraws
// on resize (ResizeObserver) so devicePixelRatio scaling stays crisp.

import { useEffect, useRef } from "react";

interface CanvasChartProps {
  draw: (canvas: HTMLCanvasElement) => void;
  height: number;
}

export function CanvasChart({ draw, height }: CanvasChartProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef(draw);
  drawRef.current = draw;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    drawRef.current(canvas);
    const observer = new ResizeObserver(() => drawRef.current(canvas));
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [draw]);

  return <canvas ref={ref} style={{ width: "100%", height, display: "block" }} />;
}
