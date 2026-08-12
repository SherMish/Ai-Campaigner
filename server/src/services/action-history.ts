import type pg from "pg";

// Full audit entry (PRD §23). Reads only from action_history — no reconstruction.
export interface ActionHistoryEntry {
  id: string;
  occurredAt: Date;
  campaignId: string;
  recommendationId: string | null;
  what: string;
  actionType: string;
  targetMetaId: string | null;
  previousState: Record<string, unknown>;
  newState: Record<string, unknown>;
  why: string;
  approvedBy: string | null;
  humanInvolved: boolean;
  result: "success" | "failed";
}

// Condensed, jargon-free projection for later reuse on the customer side.
export interface CondensedEntry {
  when: string; // ISO
  summary: string; // plain Hebrew, no Ads Manager terms
  automated: boolean;
  result: "success" | "failed";
}

const SUMMARY_HE: Record<string, string> = {
  pause_creative: "עצירת מודעה",
  increase_budget: "העלאת תקציב",
  decrease_budget: "הורדת תקציב",
  replace_creative: "החלפת קריאייטיב",
  no_action: "לא בוצע שינוי",
  activate_campaign: "הפעלת הקמפיין", // AIC-53 launch gate
  create_campaign: "יצירת הקמפיין", // AIC-50 builder — was missing, filled in while touching this map for AIC-63
  create_ad_set: "הוספת קבוצת מודעות", // AIC-63 add-to-existing-campaign (also used by AIC-50's first build)
  create_ad: "הוספת מודעה",
  activate_ad_set: "הפעלת קבוצת מודעות",
  activate_ad: "הפעלת מודעה",
  // AIC-66 manual controls. Deliberately distinct from `pause_creative` (which
  // is the ENGINE's recommendation vocabulary) even though both end in a
  // paused ad — the condensed history reads better when "you paused this" and
  // "we recommended pausing this" don't share a label. `human_involved` already
  // separates automated from human, but the wording should agree with it.
  pause_ad: "השהיית מודעה",
  pause_ad_set: "השהיית קהל",
  resume_ad: "הפעלת מודעה מחדש",
  resume_ad_set: "הפעלת קהל מחדש",
  archive_ad: "העברת מודעה לארכיון",
  archive_ad_set: "העברת קהל לארכיון",
  delete_ad: "מחיקת מודעה",
  delete_ad_set: "מחיקת קהל",
};

function rowToEntry(r: Record<string, unknown>): ActionHistoryEntry {
  return {
    id: r.id as string,
    occurredAt: r.occurred_at as Date,
    campaignId: r.campaign_id as string,
    recommendationId: (r.recommendation_id as string) ?? null,
    what: r.what as string,
    actionType: r.action_type as string,
    targetMetaId: (r.target_meta_id as string) ?? null,
    previousState: (r.previous_state as Record<string, unknown>) ?? {},
    newState: (r.new_state as Record<string, unknown>) ?? {},
    why: (r.why as string) ?? "",
    approvedBy: (r.approved_by as string) ?? null,
    humanInvolved: r.human_involved as boolean,
    result: r.result as "success" | "failed",
  };
}

// Full per-campaign history, newest-first.
export async function listCampaignActionHistory(
  pool: pg.Pool,
  campaignId: string,
): Promise<ActionHistoryEntry[]> {
  const { rows } = await pool.query(
    `SELECT * FROM action_history WHERE campaign_id = $1 ORDER BY occurred_at DESC`,
    [campaignId],
  );
  return rows.map(rowToEntry);
}

// Full history across a customer's campaigns, newest-first.
export async function listCustomerActionHistory(
  pool: pg.Pool,
  customerId: string,
): Promise<ActionHistoryEntry[]> {
  const { rows } = await pool.query(
    `SELECT ah.* FROM action_history ah
     JOIN managed_campaigns mc ON mc.id = ah.campaign_id
     WHERE mc.customer_id = $1
     ORDER BY ah.occurred_at DESC`,
    [customerId],
  );
  return rows.map(rowToEntry);
}

// Jargon-free projection for the customer surface (P0.5 reuse).
export function condense(entries: ActionHistoryEntry[]): CondensedEntry[] {
  return entries.map((e) => ({
    when: e.occurredAt.toISOString(),
    summary: SUMMARY_HE[e.actionType] ?? "שינוי בקמפיין",
    automated: !e.humanInvolved,
    result: e.result,
  }));
}
