// Money is always stored and passed around as integer **agorot** (1 shekel =
// 100 agorot) — never floats. See CLAUDE.md. These helpers are the only
// sanctioned way to cross between stored agorot and the human-facing shekel
// display, so rounding happens in exactly one place.

export type Agorot = number;

/** Convert a shekel amount (possibly fractional) to integer agorot. */
export function shekelToAgorot(shekel: number): Agorot {
  return Math.round(shekel * 100);
}

/** Convert stored agorot back to a shekel number. */
export function agorotToShekel(agorot: Agorot): number {
  return agorot / 100;
}

/**
 * Format agorot as a Hebrew shekel string.
 * Whole shekels render without decimals (₪73); fractional keep two (₪73.40).
 */
export function formatShekel(agorot: Agorot): string {
  const shekel = agorotToShekel(agorot);
  return `₪${Number.isInteger(shekel) ? shekel.toFixed(0) : shekel.toFixed(2)}`;
}
