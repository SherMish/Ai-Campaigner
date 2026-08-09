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
  if (status === "DISAPPROVED" || status === "WITH_ISSUES") state = "disapproved";
  else if (issues.length > 0) state = "not_delivering";
  else if (status === "PAUSED" || status === "ADSET_PAUSED" || status === "CAMPAIGN_PAUSED" || status === "ARCHIVED" || status === "DELETED")
    state = "paused";
  else state = "delivering";

  return { adSetId: row.id, name: row.name ?? null, state, reason: state === "delivering" || state === "paused" ? null : reason };
}

// A problem ad set is one actively broken (not merely paused on purpose).
export function isProblem(h: AdSetHealth): boolean {
  return h.state === "not_delivering" || h.state === "disapproved";
}

export interface DeliverySummary {
  ok: boolean;
  reason: string | null; // first problem's reason
  problemAdSetIds: string[];
}

export function summarize(health: AdSetHealth[]): DeliverySummary {
  const problems = health.filter(isProblem);
  return {
    ok: problems.length === 0,
    reason: problems[0]?.reason ?? (problems[0] ? "not delivering" : null),
    problemAdSetIds: problems.map((h) => h.adSetId),
  };
}
