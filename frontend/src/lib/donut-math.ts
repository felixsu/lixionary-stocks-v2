// Pure donut geometry — no React, no colors.

export interface DonutSlice {
  label: string;
  value: number;
  pct: number;
  /** Radians, clockwise from 12 o'clock. */
  startAngle: number;
  endAngle: number;
}

const TAU = Math.PI * 2;

export function computeSlices(items: { label: string; value: number }[]): DonutSlice[] {
  const positive = items.filter((i) => i.value > 0);
  const total = positive.reduce((sum, i) => sum + i.value, 0);
  if (total <= 0) return [];
  let angle = 0;
  return positive.map((i) => {
    const span = (i.value / total) * TAU;
    const slice = {
      label: i.label,
      value: i.value,
      pct: (i.value / total) * 100,
      startAngle: angle,
      endAngle: angle + span,
    };
    angle += span;
    return slice;
  });
}

function point(cx: number, cy: number, r: number, angle: number): [number, number] {
  // Angle is clockwise from 12 o'clock; SVG y grows downward.
  return [cx + r * Math.sin(angle), cy - r * Math.cos(angle)];
}

/** SVG path for an annulus sector. A full circle is drawn as two half-arcs —
 *  an arc back to its own start point renders nothing. */
export function annulusPath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  startAngle: number,
  endAngle: number,
): string {
  const span = endAngle - startAngle;
  if (span >= TAU - 1e-9) {
    const mid = startAngle + Math.PI;
    return annulusPath(cx, cy, rOuter, rInner, startAngle, mid) +
      " " + annulusPath(cx, cy, rOuter, rInner, mid, endAngle);
  }
  const large = span > Math.PI ? 1 : 0;
  const [ox1, oy1] = point(cx, cy, rOuter, startAngle);
  const [ox2, oy2] = point(cx, cy, rOuter, endAngle);
  const [ix1, iy1] = point(cx, cy, rInner, endAngle);
  const [ix2, iy2] = point(cx, cy, rInner, startAngle);
  return [
    `M ${ox1.toFixed(3)} ${oy1.toFixed(3)}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${ox2.toFixed(3)} ${oy2.toFixed(3)}`,
    `L ${ix1.toFixed(3)} ${iy1.toFixed(3)}`,
    `A ${rInner} ${rInner} 0 ${large} 0 ${ix2.toFixed(3)} ${iy2.toFixed(3)}`,
    "Z",
  ].join(" ");
}
