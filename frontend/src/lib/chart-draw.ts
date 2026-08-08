// Canvas chart drawing — candlesticks, volume, Ichimoku cloud, MACD, RSI,
// plus interaction layers: viewport (X zoom/pan), Y zoom/pan, crosshair with
// value readout, and RSI/MACD superposition.
//
// Ported from the design handoff's chart-draw.js; the original visual
// constants are unchanged (this file IS the approved reference rendering).
// Interaction math lives in viewport.ts; this file only renders.

import type { Bar } from "./api";
import type { IchimokuResult } from "./indicators";
import {
  DEFAULT_Y,
  type XViewport,
  type YState,
  resolveYRange,
  visibleRange,
} from "./viewport";

const COLORS = {
  up: "#5db872",
  down: "#c64545",
  grid: "#e6dfd8",
  text: "#8e8b82",
  tenkan: "#5db8a6",
  kijun: "#e8a55a",
  support: "#5b8fbf",
  resistance: "#c64545",
  primary: "#4f46e5",
  cloudBull: "rgba(93,184,114,0.16)",
  cloudBear: "rgba(198,69,69,0.13)",
  compare: "#e8a55a",
  macdOverlay: "#d4a017",
  crosshair: "#8e8b82",
  readoutBg: "rgba(250,249,245,0.94)",
  readoutBorder: "#e6dfd8",
  ink: "#141413",
  muted: "#6c6a64",
};

export const CHART_COLORS = COLORS;

/** Horizontal geometry shared with the interaction layer for hit-testing. */
export const CHART_PADDING = { left: 8, right: 56, top: 10 } as const;

export interface Cursor {
  x: number;
  y: number;
}

interface CanvasSetup {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
}

function setupCanvas(canvas: HTMLCanvasElement): CanvasSetup | null {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return null;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function niceFont(ctx: CanvasRenderingContext2D, size: number): void {
  ctx.font = `${size}px "JetBrains Mono", monospace`;
  ctx.fillStyle = COLORS.text;
}

function fmtAxis(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toFixed(0);
  if (abs >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

function fmtVol(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return `${Math.round(v)}`;
}

const WIB_DATE = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Jakarta",
  weekday: "short",
  day: "2-digit",
  month: "short",
  year: "numeric",
});
const WIB_DATETIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Jakarta",
  weekday: "short",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function fmtBarTime(ts: string, intraday: boolean): string {
  const d = new Date(ts);
  return intraday ? WIB_DATETIME.format(d) : WIB_DATE.format(d);
}

// ── Crosshair + readout ─────────────────────────────────────────────────────

interface ReadoutLine {
  text: string;
  color?: string;
}

function drawCrosshair(
  ctx: CanvasRenderingContext2D,
  w: number,
  plotTop: number,
  plotBottom: number,
  barX: number,
  cursorY: number | null,
  priceAtCursor: string | null,
): void {
  ctx.save();
  ctx.strokeStyle = COLORS.crosshair;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(barX, plotTop);
  ctx.lineTo(barX, plotBottom);
  ctx.stroke();
  if (cursorY != null && cursorY >= plotTop && cursorY <= plotBottom) {
    ctx.beginPath();
    ctx.moveTo(CHART_PADDING.left, cursorY);
    ctx.lineTo(w - CHART_PADDING.right, cursorY);
    ctx.stroke();
    if (priceAtCursor != null) {
      ctx.setLineDash([]);
      niceFont(ctx, 11);
      const label = priceAtCursor;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = COLORS.readoutBg;
      ctx.fillRect(w - CHART_PADDING.right + 2, cursorY - 8, tw + 8, 16);
      ctx.strokeStyle = COLORS.readoutBorder;
      ctx.strokeRect(w - CHART_PADDING.right + 2, cursorY - 8, tw + 8, 16);
      ctx.fillStyle = COLORS.ink;
      ctx.textAlign = "left";
      ctx.fillText(label, w - CHART_PADDING.right + 6, cursorY + 4);
    }
  }
  ctx.restore();
}

function drawReadout(
  ctx: CanvasRenderingContext2D,
  w: number,
  lines: ReadoutLine[],
  nearX: number,
): void {
  if (!lines.length) return;
  ctx.save();
  ctx.font = `11px "JetBrains Mono", monospace`;
  const lineH = 16;
  const padX = 10;
  const padY = 8;
  const boxW = Math.max(...lines.map((l) => ctx.measureText(l.text).width)) + padX * 2;
  const boxH = lines.length * lineH + padY * 2 - 4;
  // Flip sides so the box never sits under the cursor.
  const x =
    nearX + 14 + boxW > w - CHART_PADDING.right ? nearX - 14 - boxW : nearX + 14;
  const y = CHART_PADDING.top + 4;

  ctx.fillStyle = COLORS.readoutBg;
  ctx.strokeStyle = COLORS.readoutBorder;
  ctx.beginPath();
  ctx.roundRect(x, y, boxW, boxH, 8);
  ctx.fill();
  ctx.stroke();

  ctx.textAlign = "left";
  lines.forEach((line, i) => {
    ctx.fillStyle = line.color ?? COLORS.muted;
    ctx.fillText(line.text, x + padX, y + padY + 8 + i * lineH);
  });
  ctx.restore();
}

// ── Price chart ─────────────────────────────────────────────────────────────

export interface HLine {
  value: number;
  color: string;
  label: string;
}

export interface PriceOverlays {
  rsi?: (number | null)[];
  macdLine?: (number | null)[];
  macdSignal?: (number | null)[];
}

export interface PriceVolumeOptions {
  showVolume?: boolean;
  cloud?: IchimokuResult;
  hlines?: HLine[];
  compareSeries?: number[];
  /** Visible window; omitted = all bars (legacy behavior). */
  viewport?: XViewport;
  /** Per-chart Y zoom/pan; omitted = auto-fit. */
  yState?: YState;
  /** Cursor position in CSS pixels for crosshair + readout. */
  cursor?: Cursor | null;
  /** True when bars are intraday (readout shows time of day). */
  intraday?: boolean;
  /** Indicator series superposed on their own hidden scales. */
  overlays?: PriceOverlays;
  /** Volume bar amplification (1 = fit tallest bar); tall bars clip. */
  volZoom?: number;
}

export function drawPriceVolume(
  canvas: HTMLCanvasElement,
  bars: Bar[],
  opts: PriceVolumeOptions = {},
): void {
  if (!canvas || !bars || !bars.length) return;
  const setup = setupCanvas(canvas);
  if (!setup) return;
  const { ctx, w, h } = setup;

  const total = bars.length;
  const vp = opts.viewport ?? { offset: 0, count: total };
  const { start, end } = visibleRange(vp, total);
  const view = bars.slice(start, end);
  const n = view.length;
  if (!n) return;

  const sliceSeries = <T,>(arr: T[] | undefined): T[] | undefined =>
    arr ? arr.slice(start, end) : undefined;

  const cloud = opts.cloud
    ? {
        tenkan: opts.cloud.tenkan.slice(start, end),
        kijun: opts.cloud.kijun.slice(start, end),
        senkouA: opts.cloud.senkouA.slice(start, end),
        senkouB: opts.cloud.senkouB.slice(start, end),
      }
    : undefined;
  const compare = sliceSeries(opts.compareSeries);

  const showVolume = Boolean(opts.showVolume) && view.some((b) => b.v != null);
  const padL = CHART_PADDING.left;
  const padR = CHART_PADDING.right;
  const padTop = CHART_PADDING.top;
  const volH = showVolume ? Math.round(h * 0.18) : 0;
  const priceH = h - volH - padTop - 4;
  const cw = (w - padL - padR) / n;

  // Auto-fit range over the visible window, then apply Y zoom/pan.
  let fitMax = Math.max(...view.map((b) => b.h));
  let fitMin = Math.min(...view.map((b) => b.l));
  if (cloud) {
    fitMax = Math.max(fitMax, ...cloud.senkouA.filter(Boolean), ...cloud.senkouB.filter(Boolean));
    fitMin = Math.min(fitMin, ...cloud.senkouA.filter(Boolean), ...cloud.senkouB.filter(Boolean));
  }
  if (opts.hlines) {
    for (const l of opts.hlines) {
      fitMax = Math.max(fitMax, l.value);
      fitMin = Math.min(fitMin, l.value);
    }
  }
  const fitPad = (fitMax - fitMin || 1) * 0.08;
  const { min: minV, max: maxV } = resolveYRange(
    fitMin - fitPad,
    fitMax + fitPad,
    opts.yState ?? DEFAULT_Y,
  );

  const y = (v: number) => padTop + priceH * (1 - (v - minV) / (maxV - minV));
  const x = (i: number) => padL + i * cw + cw / 2;

  // Clip price-layer drawing so Y-zoomed content can't bleed over the volume strip.
  const clipPrice = (fn: () => void) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, padTop + priceH + 1);
    ctx.clip();
    fn();
    ctx.restore();
  };

  // grid + axis labels
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const v = minV + (maxV - minV) * (i / 4);
    const yy = y(v);
    ctx.beginPath();
    ctx.moveTo(padL, yy);
    ctx.lineTo(w - padR, yy);
    ctx.stroke();
    niceFont(ctx, 11);
    ctx.textAlign = "left";
    ctx.fillText(fmtAxis(v), w - padR + 6, yy + 4);
  }

  // ichimoku cloud
  if (cloud) {
    clipPrice(() => {
      for (let i = 1; i < n; i++) {
        const a0 = cloud.senkouA[i - 1];
        const a1 = cloud.senkouA[i];
        const b0 = cloud.senkouB[i - 1];
        const b1 = cloud.senkouB[i];
        if (a0 == null || a1 == null || b0 == null || b1 == null) continue;
        ctx.beginPath();
        ctx.moveTo(x(i - 1), y(a0));
        ctx.lineTo(x(i), y(a1));
        ctx.lineTo(x(i), y(b1));
        ctx.lineTo(x(i - 1), y(b0));
        ctx.closePath();
        ctx.fillStyle = a1 >= b1 ? COLORS.cloudBull : COLORS.cloudBear;
        ctx.fill();
      }
      const drawLine = (arr: number[], color: string) => {
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.4;
        let started = false;
        arr.forEach((v, i) => {
          if (v == null) return;
          if (!started) {
            ctx.moveTo(x(i), y(v));
            started = true;
          } else ctx.lineTo(x(i), y(v));
        });
        ctx.stroke();
      };
      drawLine(cloud.tenkan, COLORS.tenkan);
      drawLine(cloud.kijun, COLORS.kijun);
    });
  }

  // support / resistance
  if (opts.hlines) {
    for (const l of opts.hlines) {
      const yy = y(l.value);
      if (yy < padTop || yy > padTop + priceH) continue;
      ctx.save();
      ctx.strokeStyle = l.color;
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(padL, yy);
      ctx.lineTo(w - padR, yy);
      ctx.stroke();
      ctx.restore();
      niceFont(ctx, 11);
      ctx.fillStyle = l.color;
      ctx.textAlign = "left";
      ctx.fillText(l.label, padL + 4, yy - 4);
    }
  }

  // candles
  const bodyW = Math.max(1, Math.min(cw * 0.6, 24));
  clipPrice(() => {
    view.forEach((b, i) => {
      const up = b.c >= b.o;
      ctx.strokeStyle = ctx.fillStyle = up ? COLORS.up : COLORS.down;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x(i), y(b.h));
      ctx.lineTo(x(i), y(b.l));
      ctx.stroke();
      const oy = y(b.o);
      const cy = y(b.c);
      const top = Math.min(oy, cy);
      const hgt = Math.max(1, Math.abs(cy - oy));
      ctx.fillRect(x(i) - bodyW / 2, top, bodyW, hgt);
    });
  });

  // compare overlay (normalized % change line of another series)
  if (compare && compare.length === n) {
    const base = compare[0];
    const norm = compare.map((v) => view[0].c * (v / base));
    const cMin = Math.min(...norm);
    const cMax = Math.max(...norm);
    const cy2 = (v: number) => padTop + priceH * (1 - (v - cMin) / (cMax - cMin || 1));
    ctx.beginPath();
    ctx.strokeStyle = COLORS.compare;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([2, 2]);
    norm.forEach((v, i) => {
      const px = x(i);
      const py = cy2(v);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // superposed indicators, each on its own full-height hidden scale
  const overlayRsi = sliceSeries(opts.overlays?.rsi);
  if (overlayRsi) {
    const ry = (v: number) => padTop + priceH * (1 - v / 100);
    // faint 30/70 reference bands
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 0.8;
    for (const band of [70, 30]) {
      ctx.strokeStyle = band === 70 ? COLORS.resistance : COLORS.up;
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.moveTo(padL, ry(band));
      ctx.lineTo(w - padR, ry(band));
      ctx.stroke();
    }
    ctx.restore();
    ctx.beginPath();
    ctx.strokeStyle = COLORS.primary;
    ctx.lineWidth = 1.3;
    ctx.globalAlpha = 0.85;
    let started = false;
    overlayRsi.forEach((v, i) => {
      if (v == null) return;
      if (!started) {
        ctx.moveTo(x(i), ry(v));
        started = true;
      } else ctx.lineTo(x(i), ry(v));
    });
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  const overlayMacdLine = sliceSeries(opts.overlays?.macdLine);
  const overlayMacdSignal = sliceSeries(opts.overlays?.macdSignal);
  if (overlayMacdLine || overlayMacdSignal) {
    const vals: number[] = [];
    for (const arr of [overlayMacdLine, overlayMacdSignal]) {
      if (arr) for (const v of arr) if (v != null) vals.push(v);
    }
    const mAbs = Math.max(...vals.map(Math.abs), 1e-9);
    const my = (v: number) => padTop + priceH * (1 - (v + mAbs) / (2 * mAbs));
    const drawOver = (arr: (number | null)[] | undefined, color: string, dashed: boolean) => {
      if (!arr) return;
      ctx.save();
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.3;
      ctx.globalAlpha = 0.85;
      if (dashed) ctx.setLineDash([4, 3]);
      let started = false;
      arr.forEach((v, i) => {
        if (v == null) return;
        if (!started) {
          ctx.moveTo(x(i), my(v));
          started = true;
        } else ctx.lineTo(x(i), my(v));
      });
      ctx.stroke();
      ctx.restore();
    };
    drawOver(overlayMacdLine, COLORS.macdOverlay, false);
    drawOver(overlayMacdSignal, COLORS.macdOverlay, true);
  }

  // volume — its own zero-anchored scale with axis labels; volZoom amplifies
  // bar heights (small volumes become readable, the tallest bars clip).
  if (showVolume) {
    const vTop = padTop + priceH + 8;
    const vPlotH = volH - 8;
    const maxVol = Math.max(...view.map((b) => b.v || 0), 1);
    const effMax = maxVol / (opts.volZoom ?? 1);

    // separator + axis labels for the volume scale
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, vTop);
    ctx.lineTo(w - padR, vTop);
    ctx.stroke();
    niceFont(ctx, 10);
    ctx.textAlign = "left";
    ctx.fillText(fmtVol(effMax), w - padR + 6, vTop + 9);
    ctx.fillText("0", w - padR + 6, vTop + vPlotH);

    view.forEach((b, i) => {
      const vh = Math.min(((b.v || 0) / effMax) * vPlotH, vPlotH);
      ctx.fillStyle = b.c >= b.o ? "rgba(93,184,114,0.55)" : "rgba(198,69,69,0.5)";
      ctx.fillRect(x(i) - bodyW / 2, vTop + vPlotH - vh, bodyW, vh);
    });
  }

  // crosshair + readout
  if (opts.cursor) {
    const { x: cx, y: cyPix } = opts.cursor;
    if (cx >= padL && cx <= w - padR) {
      const i = Math.min(n - 1, Math.max(0, Math.round((cx - padL - cw / 2) / cw)));
      const bar = view[i];
      const globalIdx = start + i;
      const prev = globalIdx > 0 ? bars[globalIdx - 1] : null;
      const pct = prev && prev.c ? ((bar.c - prev.c) / prev.c) * 100 : null;
      const inPrice = cyPix >= padTop && cyPix <= padTop + priceH;
      const priceAtCursor = inPrice
        ? fmtAxis(minV + (1 - (cyPix - padTop) / priceH) * (maxV - minV))
        : null;

      drawCrosshair(ctx, w, padTop, padTop + priceH + volH, x(i), cyPix, priceAtCursor);

      const upDown = bar.c >= bar.o ? COLORS.up : COLORS.down;
      const lines: ReadoutLine[] = [
        { text: fmtBarTime(bar.ts, Boolean(opts.intraday)), color: COLORS.ink },
        {
          text: `O ${fmtAxis(bar.o)}  H ${fmtAxis(bar.h)}  L ${fmtAxis(bar.l)}  C ${fmtAxis(bar.c)}`,
          color: upDown,
        },
      ];
      if (pct != null) {
        lines.push({
          text: `Δ ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% vs prev close`,
          color: pct >= 0 ? COLORS.up : COLORS.down,
        });
      }
      if (bar.v != null) lines.push({ text: `V ${fmtVol(bar.v)}` });
      if (overlayRsi?.[i] != null) {
        lines.push({ text: `RSI ${overlayRsi[i]!.toFixed(1)}`, color: COLORS.primary });
      }
      if (overlayMacdLine?.[i] != null || overlayMacdSignal?.[i] != null) {
        lines.push({
          text: `MACD ${overlayMacdLine?.[i] != null ? overlayMacdLine[i]!.toFixed(2) : "—"}  sig ${overlayMacdSignal?.[i] != null ? overlayMacdSignal[i]!.toFixed(2) : "—"}`,
          color: COLORS.macdOverlay,
        });
      }
      drawReadout(ctx, w, lines, x(i));
    }
  }
}

// ── Indicator panel ─────────────────────────────────────────────────────────

export interface IndicatorSeries {
  data: (number | null)[];
  color: string;
  /** Name shown in the crosshair readout. */
  label?: string;
}

export interface IndicatorBand {
  value: number;
  color: string;
  label: string;
}

export interface IndicatorPanelOptions {
  length: number;
  series?: IndicatorSeries[];
  histogram?: (number | null)[];
  bands?: IndicatorBand[];
  viewport?: XViewport;
  yState?: YState;
  cursor?: Cursor | null;
}

export function drawIndicatorPanel(
  canvas: HTMLCanvasElement,
  opts: IndicatorPanelOptions,
): void {
  if (!canvas) return;
  const setup = setupCanvas(canvas);
  if (!setup) return;
  const { ctx, w, h } = setup;

  const total = opts.length;
  const vp = opts.viewport ?? { offset: 0, count: total };
  const { start, end } = visibleRange(vp, total);
  const n = end - start;
  if (n <= 0) return;

  const series = (opts.series || []).map((s) => ({ ...s, data: s.data.slice(start, end) }));
  const histogram = opts.histogram ? opts.histogram.slice(start, end) : undefined;

  const padL = CHART_PADDING.left;
  const padR = CHART_PADDING.right;
  const padTop = 8;
  const padBottom = 8;
  const plotH = h - padTop - padBottom;
  const cw = (w - padL - padR) / n;
  const x = (i: number) => padL + i * cw + cw / 2;

  const vals: number[] = [];
  series.forEach((s) => s.data.forEach((v) => v != null && vals.push(v)));
  if (histogram) histogram.forEach((v) => v != null && vals.push(v));
  (opts.bands || []).forEach((b) => vals.push(b.value));
  let fitMax = Math.max(...vals, 0);
  let fitMin = Math.min(...vals, 0);
  if (fitMax === fitMin) {
    fitMax += 1;
    fitMin -= 1;
  }
  const fitPad = (fitMax - fitMin) * 0.1;
  const { min: minV, max: maxV } = resolveYRange(
    fitMin - fitPad,
    fitMax + fitPad,
    opts.yState ?? DEFAULT_Y,
  );
  const y = (v: number) => padTop + plotH * (1 - (v - minV) / (maxV - minV));

  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  const zeroY = y(0);
  if (zeroY >= padTop && zeroY <= padTop + plotH) {
    ctx.beginPath();
    ctx.moveTo(padL, zeroY);
    ctx.lineTo(w - padR, zeroY);
    ctx.stroke();
  }

  for (const b of opts.bands || []) {
    const yy = y(b.value);
    if (yy < padTop || yy > padTop + plotH) continue;
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = b.color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, yy);
    ctx.lineTo(w - padR, yy);
    ctx.stroke();
    ctx.restore();
    niceFont(ctx, 10);
    ctx.fillStyle = b.color;
    ctx.fillText(b.label, w - padR + 6, yy + 3);
  }

  if (histogram) {
    const bw = Math.max(1, Math.min(cw * 0.6, 24));
    histogram.forEach((v, i) => {
      if (v == null) return;
      ctx.fillStyle = v >= 0 ? "rgba(93,184,114,0.6)" : "rgba(198,69,69,0.55)";
      const yy0 = y(0);
      const yy1 = y(v);
      ctx.fillRect(x(i) - bw / 2, Math.min(yy0, yy1), bw, Math.max(1, Math.abs(yy1 - yy0)));
    });
  }

  for (const s of series) {
    ctx.beginPath();
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.5;
    let started = false;
    s.data.forEach((v, i) => {
      if (v == null) return;
      const px = x(i);
      const py = y(v);
      if (!started) {
        ctx.moveTo(px, py);
        started = true;
      } else ctx.lineTo(px, py);
    });
    ctx.stroke();
  }

  niceFont(ctx, 11);
  ctx.textAlign = "left";
  ctx.fillText(fmtAxis(maxV), w - padR + 6, padTop + 10);
  ctx.fillText(fmtAxis(minV), w - padR + 6, h - padBottom);

  if (opts.cursor) {
    const { x: cx, y: cyPix } = opts.cursor;
    if (cx >= padL && cx <= w - padR) {
      const i = Math.min(n - 1, Math.max(0, Math.round((cx - padL - cw / 2) / cw)));
      const inPlot = cyPix >= padTop && cyPix <= padTop + plotH;
      const valAtCursor = inPlot
        ? fmtAxis(minV + (1 - (cyPix - padTop) / plotH) * (maxV - minV))
        : null;
      drawCrosshair(ctx, w, padTop, padTop + plotH, x(i), cyPix, valAtCursor);

      const lines: ReadoutLine[] = [];
      for (const s of series) {
        const v = s.data[i];
        if (v != null) {
          lines.push({ text: `${s.label ?? "value"} ${fmtAxis(v)}`, color: s.color });
        }
      }
      if (histogram && histogram[i] != null) {
        lines.push({
          text: `hist ${fmtAxis(histogram[i]!)}`,
          color: histogram[i]! >= 0 ? COLORS.up : COLORS.down,
        });
      }
      drawReadout(ctx, w, lines, x(i));
    }
  }
}

// ── Volume panel (detached) ─────────────────────────────────────────────────

export interface VolumePanelOptions {
  viewport?: XViewport;
  yState?: YState;
  cursor?: Cursor | null;
  intraday?: boolean;
}

/**
 * Standalone volume chart: zero-anchored auto-fit, but a full YState so the
 * user can zoom AND pan vertically, unlike the embedded strip. X stays in
 * sync by passing the same shared viewport as the price chart.
 */
export function drawVolumePanel(
  canvas: HTMLCanvasElement,
  bars: Bar[],
  opts: VolumePanelOptions = {},
): void {
  if (!canvas || !bars.length) return;
  const setup = setupCanvas(canvas);
  if (!setup) return;
  const { ctx, w, h } = setup;

  const total = bars.length;
  const vp = opts.viewport ?? { offset: 0, count: total };
  const { start, end } = visibleRange(vp, total);
  const view = bars.slice(start, end);
  const n = view.length;
  if (!n) return;

  const padL = CHART_PADDING.left;
  const padR = CHART_PADDING.right;
  const padTop = 8;
  const padBottom = 8;
  const plotH = h - padTop - padBottom;
  const cw = (w - padL - padR) / n;
  const x = (i: number) => padL + i * cw + cw / 2;

  const maxVol = Math.max(...view.map((b) => b.v ?? 0), 1);
  const { min: minV, max: maxV } = resolveYRange(0, maxVol * 1.08, opts.yState ?? DEFAULT_Y);
  const y = (v: number) => padTop + plotH * (1 - (v - minV) / (maxV - minV));

  // grid + axis labels
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const v = minV + (maxV - minV) * (i / 3);
    const yy = y(v);
    ctx.beginPath();
    ctx.moveTo(padL, yy);
    ctx.lineTo(w - padR, yy);
    ctx.stroke();
    niceFont(ctx, 10);
    ctx.textAlign = "left";
    ctx.fillText(fmtVol(Math.max(0, v)), w - padR + 6, yy + 3);
  }

  // bars, clipped to the plot so zoom/pan can't bleed into the margins
  const bodyW = Math.max(1, Math.min(cw * 0.6, 24));
  ctx.save();
  ctx.beginPath();
  ctx.rect(padL, padTop, w - padL - padR, plotH);
  ctx.clip();
  const zeroY = Math.min(y(Math.max(0, minV)), padTop + plotH);
  view.forEach((b, i) => {
    if (b.v == null) return;
    const topY = y(b.v);
    ctx.fillStyle = b.c >= b.o ? "rgba(93,184,114,0.55)" : "rgba(198,69,69,0.5)";
    ctx.fillRect(x(i) - bodyW / 2, Math.min(topY, zeroY), bodyW, Math.abs(zeroY - topY));
  });
  ctx.restore();

  // crosshair + readout
  if (opts.cursor) {
    const { x: cx, y: cyPix } = opts.cursor;
    if (cx >= padL && cx <= w - padR) {
      const i = Math.min(n - 1, Math.max(0, Math.round((cx - padL - cw / 2) / cw)));
      const bar = view[i];
      const inPlot = cyPix >= padTop && cyPix <= padTop + plotH;
      const volAtCursor = inPlot
        ? fmtVol(Math.max(0, minV + (1 - (cyPix - padTop) / plotH) * (maxV - minV)))
        : null;
      drawCrosshair(ctx, w, padTop, padTop + plotH, x(i), cyPix, volAtCursor);
      if (bar.v != null) {
        drawReadout(
          ctx,
          w,
          [
            { text: fmtBarTime(bar.ts, Boolean(opts.intraday)), color: COLORS.ink },
            { text: `V ${fmtVol(bar.v)}`, color: bar.c >= bar.o ? COLORS.up : COLORS.down },
          ],
          x(i),
        );
      }
    }
  }
}
