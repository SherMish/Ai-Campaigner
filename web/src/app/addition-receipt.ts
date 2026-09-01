// AIC-175 — proof that the addition worked, that survives leaving the screen.
//
// Reported: an ad set and its three ads were created on Meta at 19:46:57, and
// the customer's next question was "was it successful?". The success panel had
// rendered into React state, the page then loaded fresh, and the only record
// that anything happened was in our logs.
//
// A confirmation that exists solely as component state is a confirmation the
// customer keeps only if nothing interrupts them — a reload, a tab restore, a
// deploy swapping the JS bundle, or simply navigating away and back. This is
// the one moment in the product where a customer has just spent real money on
// their own account and cannot verify it themselves, so it is the worst place
// for the record to be that fragile.
//
// The receipt is written on success and read anywhere the customer might look
// for reassurance (the add-content screen and the dashboard). It expires on
// its own: it answers "did the thing I just did work", not "what happened this
// month", and a stale banner claiming a fresh success is its own kind of lie.

export interface AdditionReceipt {
  kind: "ad" | "ad_set";
  /** How many ads were created. The number the customer counted out. */
  ads: number;
  /** False when at least one ad is still awaiting Meta's review. */
  live: boolean;
  /** Epoch ms. */
  at: number;
}

export const RECEIPT_KEY = "aic_last_addition";

/** Long enough to survive a reload and a coffee, short enough to never mislead. */
export const RECEIPT_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Parses a stored receipt, or null if there is nothing trustworthy to show.
 *
 * Every field is checked rather than cast. This value comes from localStorage,
 * which means it can be from an older build of the app, hand-edited, or
 * truncated — and the failure mode of trusting it is a confident banner
 * rendering `undefined מודעות`.
 */
export function decodeReceipt(raw: string | null, nowMs: number): AdditionReceipt | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const r = v as Partial<AdditionReceipt>;
  if (r.kind !== "ad" && r.kind !== "ad_set") return null;
  if (typeof r.ads !== "number" || !Number.isFinite(r.ads) || r.ads < 1) return null;
  if (typeof r.live !== "boolean") return null;
  if (typeof r.at !== "number" || !Number.isFinite(r.at)) return null;
  // A receipt from the future is a clock change, not a success worth showing.
  if (r.at > nowMs || nowMs - r.at > RECEIPT_TTL_MS) return null;
  return { kind: r.kind, ads: r.ads, live: r.live, at: r.at };
}

// localStorage is wrapped everywhere it is touched: Safari's private mode
// throws on access, and a confirmation banner must never be the thing that
// takes down the screen it is confirming.
export function saveReceipt(r: AdditionReceipt): void {
  try { localStorage.setItem(RECEIPT_KEY, JSON.stringify(r)); } catch { /* ignore */ }
}

export function loadReceipt(nowMs: number = Date.now()): AdditionReceipt | null {
  try { return decodeReceipt(localStorage.getItem(RECEIPT_KEY), nowMs); } catch { return null; }
}

export function clearReceipt(): void {
  try { localStorage.removeItem(RECEIPT_KEY); } catch { /* ignore */ }
}
