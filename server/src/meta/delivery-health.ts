// Ad-set delivery health (AIC-39). Meta Insights only carry *performance*
// (spend/leads) — a not-delivering ad set looks like "no data yet." The *reason*
// (ad error, disapproval) lives in `effective_status` + `issues_info`, a separate
// read. This normalizes those into a delivery state so the customer sees "needs
// attention," the operator gets an ops item, and the engine never treats an
// errored audience as a "weak" one to pause (AIC-36).

export type DeliveryState = "delivering" | "not_delivering" | "disapproved" | "paused";

export interface AdSetHealth {
  adSetId: string;
  name: string | null;
  state: DeliveryState;
  reason: string | null; // plain issue summary from Meta, when not delivering
  // AIC-71: how many ads under this ad set are themselves currently delivering
  // (not paused, not errored)? An ad-set-level ACTIVE status with every
  // individual ad paused (AIC-66's manual pause) shows nothing — the ad-set
  // state alone isn't enough to know "is anyone seeing this."
  deliveringAdCount: number;
}

// A raw ad-set row from Meta (effective_status + issues_info).
export interface RawAdSetDelivery {
  id: string;
  name?: string | null;
  effective_status?: string | null;
  issues_info?: Array<{ error_summary?: string; error_message?: string }> | null;
}

export interface DeliveryReader {
  getDeliveryHealth(metaCampaignId: string): Promise<AdSetHealth[]>;
}

// Normalize one ad set. A DISAPPROVED status is disapproved; any `issues_info`
// (delivery-blocking issue, even while effective_status says ACTIVE — the exact
// GelNails case) is not_delivering; PAUSED/ARCHIVED/DELETED is an intentional
// pause (not a problem); otherwise it's delivering.
export function normalizeAdSet(row: RawAdSetDelivery): AdSetHealth {
  const status = (row.effective_status ?? "").toUpperCase();
  const issues = row.issues_info ?? [];
  const reason = issues[0]?.error_summary || issues[0]?.error_message || null;

  let state: DeliveryState;
  // AIC-65: deleted/archived checked FIRST, before issues_info — a leftover
  // issue from before the ad set was deleted must never override "gone is
  // gone." A deleted ad set not delivering is expected, never a problem.
  if (status === "ARCHIVED" || status === "DELETED") state = "paused";
  else if (status === "DISAPPROVED" || status === "WITH_ISSUES") state = "disapproved";
  else if (issues.length > 0) state = "not_delivering";
  else if (status === "PAUSED" || status === "ADSET_PAUSED" || status === "CAMPAIGN_PAUSED") state = "paused";
  else state = "delivering";

  // deliveringAdCount is filled in by the ad-level rollup below (campaign-adapter.ts) —
  // this function normalizes a single row and has no ad-level knowledge.
  return { adSetId: row.id, name: row.name ?? null, state, reason: state === "delivering" || state === "paused" ? null : reason, deliveringAdCount: 0 };
}

// A problem ad set is one actively broken (not merely paused on purpose).
export function isProblem(h: AdSetHealth): boolean {
  return h.state === "not_delivering" || h.state === "disapproved";
}

export interface DeliverySummary {
  ok: boolean;
  reason: string | null; // first problem's reason
  problemAdSetIds: string[];
  // AIC-71: is anything actually showing right now? False when every ad set
  // is paused/errored/empty — distinct from `ok`, which only means "nothing is
  // BROKEN" (an intentionally all-paused campaign is `ok: true, delivering:
  // false`). Drives the customer-facing "stopped" home state.
  delivering: boolean;
  // Count of currently-delivering ads across delivering ad sets — the honest
  // "מודעות פעילות" number, as opposed to ads with historical spend.
  deliveringAdCount: number;
}

export function summarize(health: AdSetHealth[]): DeliverySummary {
  const problems = health.filter(isProblem);
  // Only an ad set that is itself state=delivering counts its ads — an ad set
  // leaked a paused/errored state (e.g. CAMPAIGN_PAUSED) shouldn't have its
  // ads counted even if some individual ad row still reads ACTIVE.
  const deliveringAdCount = health
    .filter((h) => h.state === "delivering")
    .reduce((sum, h) => sum + h.deliveringAdCount, 0);
  return {
    ok: problems.length === 0,
    reason: problems[0]?.reason ?? (problems[0] ? "not delivering" : null),
    problemAdSetIds: problems.map((h) => h.adSetId),
    delivering: deliveringAdCount > 0,
    deliveringAdCount,
  };
}
