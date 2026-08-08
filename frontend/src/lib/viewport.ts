// Chart viewport math. Pure functions, no canvas, no React — testable in Node.
//
// X viewport is anchored to the RECENT end of the series ({offset, count} =
// "show `count` bars, ending `offset` bars before the newest"), so one shared
// viewport stays time-aligned across charts whose bar counts differ slightly.
//
// Y state is unit-free: `pan` is expressed as a fraction of the auto-fit
// range and `zoom` divides it, so the same state applies regardless of the
// price scale. zoom=1 & pan=0 is exactly the auto-fit view.

export interface XViewport {
  /** Bars hidden after the visible window (0 = latest bar visible). */
  offset: number;
  /** Visible bar count. */
  count: number;
}

export interface YState {
  /** Range divider: 2 = shows half the auto-fit range. */
  zoom: number;
  /** Center shift as a fraction of the auto-fit range. */
  pan: number;
}

export const MIN_VISIBLE_BARS = 10;
export const MAX_Y_ZOOM = 20;
export const MAX_VOL_ZOOM = 50;

export const DEFAULT_Y: YState = { zoom: 1, pan: 0 };

export function clampViewport(v: XViewport, total: number): XViewport {
  if (total <= 0) return { offset: 0, count: v.count };
  const count = Math.min(Math.max(Math.round(v.count), MIN_VISIBLE_BARS), total);
  const offset = Math.min(Math.max(Math.round(v.offset), 0), Math.max(0, total - count));
  return { offset, count };
}

/**
 * Zoom the X viewport by `factor` (>1 zooms out, <1 zooms in), keeping the bar
 * at `anchorFrac` (0 = left edge of the window, 1 = right edge) stationary.
 */
export function zoomX(
  v: XViewport,
  total: number,
  factor: number,
  anchorFrac: number,
): XViewport {
  const clamped = clampViewport(v, total);
  const newCount = clamped.count * factor;
  // Distance of the anchor bar from the series end, in bars.
  const anchorFromEnd = clamped.offset + (1 - anchorFrac) * clamped.count;
  const newOffset = anchorFromEnd - (1 - anchorFrac) * newCount;
  return clampViewport({ offset: newOffset, count: newCount }, total);
}

/** Pan the X viewport by a number of bars (positive = towards history). */
export function panX(v: XViewport, total: number, deltaBars: number): XViewport {
  return clampViewport({ offset: v.offset + deltaBars, count: v.count }, total);
}

/** Slice indices for the visible window of an array of length `total`. */
export function visibleRange(v: XViewport, total: number): { start: number; end: number } {
  const c = clampViewport(v, total);
  const end = total - c.offset;
  return { start: Math.max(0, end - c.count), end };
}

/**
 * Zoom Y by `factor` (>1 zooms in), keeping the price at `yFrac` (0 = top of
 * the plot, 1 = bottom) stationary. Works in normalized units: with the
 * auto-fit range as 1 and its center as 0, the visible window is
 * center=pan, range=1/zoom, and the price at `yFrac` is pan + (0.5 - yFrac)/zoom.
 */
export function zoomY(state: YState, factor: number, yFrac = 0.5): YState {
  const zoom = Math.min(Math.max(state.zoom * factor, 1 / 4), MAX_Y_ZOOM);
  const anchorPrice = state.pan + (0.5 - yFrac) / state.zoom;
  const pan = anchorPrice - (0.5 - yFrac) / zoom;
  return { zoom, pan: clampYPan(pan, zoom) };
}

/** Pan Y by a fraction of the plot height (positive = drag downward). */
export function panY(state: YState, dyFrac: number): YState {
  return { zoom: state.zoom, pan: clampYPan(state.pan + dyFrac / state.zoom, state.zoom) };
}

/** Keep the visible window overlapping the auto-fit range. */
function clampYPan(pan: number, zoom: number): number {
  const limit = 0.5 + 0.5 / zoom;
  return Math.min(Math.max(pan, -limit), limit);
}

/** Resolve a Y state against a concrete auto-fit price range. */
export function resolveYRange(
  baseMin: number,
  baseMax: number,
  state: YState,
): { min: number; max: number } {
  const base = baseMax - baseMin || 1;
  const center = (baseMin + baseMax) / 2 + state.pan * base;
  const half = base / state.zoom / 2;
  return { min: center - half, max: center + half };
}

export function isDefaultY(state: YState): boolean {
  return state.zoom === 1 && state.pan === 0;
}

/**
 * Volume zoom is an amplification factor: bars are scaled up by `zoom` and the
 * tallest ones clip. Zero stays anchored at the bottom, so there is no pan.
 */
export function zoomVol(zoom: number, factor: number): number {
  return Math.min(Math.max(zoom * factor, 1), MAX_VOL_ZOOM);
}
