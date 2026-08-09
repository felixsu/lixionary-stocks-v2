// Indonesian/English mixed number parsing for money inputs.
//
// The trap this exists to avoid: treating every dot as a thousands separator
// turns "710.00" into 71000 — a 100× inflated cost basis. Dots are grouping
// ONLY when they form valid 3-digit groups; 1–2 trailing digits after a dot
// or comma are decimals.

/** Plausible IDX per-share price range in IDR (min tick is 1 rupiah). */
export const IDR_PRICE_MIN = 1;
export const IDR_PRICE_MAX = 1_000_000;

/** Parse "710", "710.00", "6.300", "Rp6.300", "1.234,5", "1,234.56" → number.
 *  Returns null for malformed or non-positive input. */
export function parseIdrNumber(input: string): number | null {
  let s = input.trim().replace(/^rp/i, "").replace(/[\s_]/g, "");
  if (!s || /[^0-9.,]/.test(s)) return null;

  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");

  if (lastDot !== -1 && lastComma !== -1) {
    // Both present: whichever occurs last is the decimal point.
    const decimal = lastDot > lastComma ? "." : ",";
    const grouping = decimal === "." ? "," : ".";
    s = s.split(grouping).join("").replace(decimal, ".");
    if (!/^\d+(\.\d+)?$/.test(s)) return null;
  } else if (lastDot !== -1 || lastComma !== -1) {
    const sep = lastDot !== -1 ? "\\." : ",";
    // Decimal first: 1–2 digits after a single separator ("710.00" → 710).
    if (new RegExp(`^\\d+${sep}\\d{1,2}$`).test(s)) {
      s = s.replace(/,/, ".");
    } else if (new RegExp(`^\\d{1,3}(${sep}\\d{3})+$`).test(s)) {
      // Valid 3-digit grouping ("6.300" → 6300, "1.234.567" → 1234567).
      s = s.replace(/[.,]/g, "");
    } else {
      return null; // "7.1.0", "12.34.5", …
    }
  }

  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}
