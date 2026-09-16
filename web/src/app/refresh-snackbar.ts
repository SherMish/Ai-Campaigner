// AIC-193 — what the data snackbar says, if anything.
//
// Pure, so it is tested (web tests run without a DOM) and so the component is
// only timers and markup. It reads the same shared overview state the dashboard
// renders from, which is what keeps it from announcing a refresh the page does
// not reflect.

export type SnackKind = "loading_campaign" | "refreshing" | "refreshed" | "throttled" | "stalled";

export interface SnackInput {
  loading: boolean;
  hasData: boolean;
  dataRefresh?: string;
  /** The store stopped reloading while the server still reported "refreshing". */
  stalled: boolean;
}

/** How long a kind stays up after its condition ends. null = while it holds. */
export const LINGER_MS: Record<SnackKind, number | null> = {
  loading_campaign: null,
  refreshing: null,
  stalled: 8_000,
  refreshed: 2_500,
  throttled: 6_000,
};

export function snackFor(prev: SnackKind | null, s: SnackInput): SnackKind | null {
  // Switching campaigns: the old numbers were cleared on purpose (AIC-186), so
  // the page is empty and should say why.
  if (s.loading && !s.hasData) return "loading_campaign";

  if (s.dataRefresh === "refreshing") return s.stalled ? "stalled" : "refreshing";
  if (s.dataRefresh === "throttled") return "throttled";

  // "Updated" only after a refresh the customer actually watched. A load that
  // was already fresh gets nothing — a success message for work nobody saw
  // happen is noise.
  const watched = prev === "refreshing" || prev === "stalled";
  if (watched && (s.dataRefresh === "refreshed" || s.dataRefresh === "fresh")) return "refreshed";
  return null;
}
