// Canvas chart drawing — candlesticks, volume, Ichimoku cloud, MACD, RSI.
// Ported from the design handoff's chart-draw.js; visual constants unchanged
// (this file IS the approved reference rendering).

import type { Bar } from "./api";
import type { IchimokuResult } from "./indicators";

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
};

export const CHART_COLORS = COLORS;

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

export interface HLine {
  value: number;
  color: string;
  label: string;
}

export interface PriceVolumeOptions {
  showVolume?: boolean;
  cloud?: IchimokuResult;
  hlines?: HLine[];
  compareSeries?: number[];
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

  const showVolume = Boolean(opts.showVolume) && bars.some((b) => b.v != null);
  const padL = 8;
  const padR = 56;
  const padTop = 10;
  const volH = showVolume ? Math.round(h * 0.18) : 0;
  const priceH = h - volH - padTop - 4;
  const n = bars.length;
  const cw = (w - padL - padR) / n;

  const cloud = opts.cloud;
  let maxV = Math.max(...bars.map((b) => b.h));
  let minV = Math.min(...bars.map((b) => b.l));
  if (cloud) {
    maxV = Math.max(maxV, ...cloud.senkouA.filter(Boolean), ...cloud.senkouB.filter(Boolean));
    minV = Math.min(minV, ...cloud.senkouA.filter(Boolean), ...cloud.senkouB.filter(Boolean));
  }
  if (opts.hlines) {
    for (const l of opts.hlines) {
      maxV = Math.max(maxV, l.value);
      minV = Math.min(minV, l.value);
    }
  }
  const range = maxV - minV || 1;
  const pad = range * 0.08;
  maxV += pad;
  minV -= pad;
  const y = (v: number) => padTop + priceH * (1 - (v - minV) / (maxV - minV));
  const x = (i: number) => padL + i * cw + cw / 2;

  // grid + axis labels
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const v = minV + (range + pad * 2) * (i / 4);
    const yy = y(v);
    ctx.beginPath();
    ctx.moveTo(padL, yy);
    ctx.lineTo(w - padR, yy);
    ctx.stroke();
    niceFont(ctx, 11);
    ctx.textAlign = "left";
    ctx.fillText(v.toFixed(0), w - padR + 6, yy + 4);
  }

  // ichimoku cloud
  if (cloud) {
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
  }

  // support / resistance
  if (opts.hlines) {
    for (const l of opts.hlines) {
      const yy = y(l.value);
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
  const bodyW = Math.max(1, cw * 0.6);
  bars.forEach((b, i) => {
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

  // compare overlay (normalized % change line of another series)
  if (opts.compareSeries && opts.compareSeries.length === n) {
    const base = opts.compareSeries[0];
    const norm = opts.compareSeries.map((v) => bars[0].c * (v / base));
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

  // volume
  if (showVolume) {
    const vTop = padTop + priceH + 8;
    const maxVol = Math.max(...bars.map((b) => b.v || 0), 1);
    bars.forEach((b, i) => {
      const vh = ((b.v || 0) / maxVol) * (volH - 8);
      ctx.fillStyle = b.c >= b.o ? "rgba(93,184,114,0.55)" : "rgba(198,69,69,0.5)";
      ctx.fillRect(x(i) - bodyW / 2, vTop + (volH - 8) - vh, bodyW, vh);
    });
  }
}

export interface IndicatorSeries {
  data: (number | null)[];
  color: string;
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
}

export function drawIndicatorPanel(
  canvas: HTMLCanvasElement,
  opts: IndicatorPanelOptions,
): void {
  if (!canvas) return;
  const setup = setupCanvas(canvas);
  if (!setup) return;
  const { ctx, w, h } = setup;

  const padL = 8;
  const padR = 56;
  const padTop = 8;
  const padBottom = 8;
  const plotH = h - padTop - padBottom;
  const series = opts.series || [];
  const n = opts.length;
  const cw = (w - padL - padR) / n;
  const x = (i: number) => padL + i * cw + cw / 2;

  const vals: number[] = [];
  for (const s of series) for (const v of s.data) if (v != null) vals.push(v);
  if (opts.histogram) for (const v of opts.histogram) if (v != null) vals.push(v);
  for (const b of opts.bands || []) vals.push(b.value);
  let maxV = Math.max(...vals, 0);
  let minV = Math.min(...vals, 0);
  if (maxV === minV) {
    maxV += 1;
    minV -= 1;
  }
  const pad = (maxV - minV) * 0.1;
  maxV += pad;
  minV -= pad;
  const y = (v: number) => padTop + plotH * (1 - (v - minV) / (maxV - minV));

  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, y(0));
  ctx.lineTo(w - padR, y(0));
  ctx.stroke();

  for (const b of opts.bands || []) {
    const yy = y(b.value);
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

  if (opts.histogram) {
    const bw = Math.max(1, cw * 0.6);
    opts.histogram.forEach((v, i) => {
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
  ctx.fillText(maxV.toFixed(0), w - padR + 6, padTop + 10);
  ctx.fillText(minV.toFixed(0), w - padR + 6, h - padBottom);
}
