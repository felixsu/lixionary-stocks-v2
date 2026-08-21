// IDX price ticks (fraksi harga), per IDX Regulation II-A.
//
// An order can only be placed on a valid tick, so any price the app *suggests*
// — an entry, a stop, a target — has to be rounded onto one or it isn't
// actionable. An LLM asked for a level will happily answer 771.3; on a stock in
// the 500–2,000 band the only orderable prices near that are 770 and 775.

/** Lower bound of each band, descending, paired with its tick. */
const BANDS: ReadonlyArray<readonly [floor: number, tick: number]> = [
  [5000, 25],
  [2000, 10],
  [500, 5],
  [200, 2],
  [0, 1],
];

/** The tick size applying at `price`. Non-finite or non-positive input → 1. */
export function tickSize(price: number): number {
  if (!Number.isFinite(price) || price <= 0) return 1;
  for (const [floor, tick] of BANDS) {
    if (price >= floor) return tick;
  }
  return 1;
}

export type TickMode = "nearest" | "down" | "up";

/**
 * Snap `price` onto a valid IDX tick.
 *
 * Rounding can push a price across a band boundary (2,001 → down → 2,000 is
 * still valid, but 4,999 → up on a tick of 10 gives 5,000 where the tick
 * becomes 25). Re-snapping once with the destination band's tick settles it;
 * the bands are coarse enough that a second pass never moves it again.
 */
export function roundToTick(price: number, mode: TickMode = "nearest"): number {
  if (!Number.isFinite(price) || price <= 0) return price;
  const snap = (p: number, tick: number) => {
    const n =
      mode === "down"
        ? Math.floor(p / tick)
        : mode === "up"
          ? Math.ceil(p / tick)
          : Math.round(p / tick);
    return Math.max(tick, n * tick);
  };
  const once = snap(price, tickSize(price));
  const settled = snap(once, tickSize(once));
  return settled;
}

/** Whether `price` already sits on a valid tick. */
export function isOnTick(price: number): boolean {
  return Number.isFinite(price) && price > 0 && price % tickSize(price) === 0;
}
