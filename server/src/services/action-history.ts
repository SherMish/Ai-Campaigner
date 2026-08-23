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

// Who actually performed an action. Three actors, because there ARE three
// (the AIC-66 model): the engine acting on its own, the customer acting in
// their own dashboard, and us acting on their behalf.
//
// Found live 2026-08-22: the customer's feed labelled EVERY entry "בוצע על
// ידינו" ("done by us") — including ad sets the customer had paused
// themselves. The data was never wrong (`human_involved = true`,
// `approved_by = 'customer'`); this projection collapsed three actors into
// one boolean, and the UI read `automated: false` as "us". Taking credit for
// the customer's own actions is a trust failure, not a copy nit.
export type ActionActor = "automated" | "customer" | "us";

// Condensed, jargon-free projection for later reuse on the customer side.
export interface CondensedEntry {
  when: string; // ISO
  summary: string; // plain Hebrew, no Ads Manager terms
  // Kept for backwards compatibility with existing consumers/tests; `actor`
  // is the field that can actually tell the truth.
  automated: boolean;
  actor: ActionActor;
  result: "success" | "failed";
}

// `approved_by` is the actor of record. Values seen in practice:
//   'customer'  — the customer's own dashboard (manual controls, launch
//                 approval, recommendation approval)
//   'operator'  — us, acting on their behalf
//   NULL        — no human approver. With human_involved = true this is a
//                 human-initiated write that predates or sidesteps the actor
//                 field (e.g. builder create_ad). Attributed to "us" because
//                 that is the honest reading — a human did it and it was not
//                 the customer's dashboard — never to the customer.
export function actorOf(humanInvolved: boolean, approvedBy: string | null): ActionActor {
  if (!humanInvolved) return "automated";
  return approvedBy === "customer" ? "customer" : "us";
}

// Exported for the ops notification relay (AIC-118), which labels the same
// action types for the Telegram channel. Deliberately shared rather than
// mirrored: a parallel copy is exactly the artifact that goes stale the first
// time someone adds an action type and updates only one of them.
//
// The relay reuses this map ONLY. It must not reuse condense() below, which
// hides rows the CUSTOMER shouldn't see (internal rollbacks, defunct
// campaigns) — those are precisely the rows the ops channel most needs.
export const SUMMARY_HE: Record<string, string> = {
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

// AIC-77b: one row per recommendation type — the most recent SUCCESSFUL
// ENGINE-AUTHORED execution of it for this campaign, regardless of how old.
// `recommendation_id IS NOT NULL` is the verified discriminator: every other
// action_history writer (manual AIC-66 controls, builder, launch) hardcodes
// the literal NULL in its SQL, so no non-engine row can ever match this.
// `result = 'success'` excludes a failed Meta write, which must never start
// a cooldown. Bounded to ≤ the number of RecommendationTypes (currently 5)
// per campaign via DISTINCT ON — the caller (rules.ts's resolveCooldownClasses)
// compares each timestamp against its own resolved COOLDOWN_DAYS and `now`,
// so this reader doesn't need to know the cutoff at all.
export async function getLatestEngineActionByType(
  pool: pg.Pool,
  campaignId: string,
): Promise<Record<string, Date>> {
  const { rows } = await pool.query<{ action_type: string; occurred_at: Date }>(
    `SELECT DISTINCT ON (action_type) action_type, occurred_at
     FROM action_history
     WHERE campaign_id = $1 AND recommendation_id IS NOT NULL AND result = 'success'
     ORDER BY action_type, occurred_at DESC`,
    [campaignId],
  );
  return Object.fromEntries(rows.map((r) => [r.action_type, r.occurred_at]));
}

// Internal bookkeeping the customer must never be shown. `rollback_build` is
// our cleanup of a build that failed — it has no SUMMARY_HE entry, so it used
// to render through the generic fallback as "שינוי בקמפיין · בוצע אוטומטית":
// telling a customer we automatically changed their campaign, when what
// happened was that something which never became real got removed.
const INTERNAL_ACTION_TYPES = new Set(["rollback_build"]);

// Jargon-free projection for the customer surface (P0.5 reuse).
//
// Found live 2026-08-23: after three failed builds, a real customer's feed
// showed "יצירת הקמפיין" FOUR times while only one campaign existed — the
// other three were created and deleted seconds later. The feed is a record of
// what happened to THEIR campaign, not of our retries, so a creation that was
// rolled back is not history: it is churn from an attempt that left no trace
// on Meta.
//
// Both filters are precise rather than blanket: only rows a rollback
// explicitly names as deleted are dropped, so a genuine creation always
// survives.
export function condense(
  entries: ActionHistoryEntry[],
  // The campaign's CURRENT Meta id, when the caller knows it. One managed
  // campaign per customer, so a create_campaign row naming a different id
  // describes a campaign that no longer exists — a failed build that was
  // rolled back, or cleaned up by hand before rollback existed (which is
  // exactly the case that survived the filters below on a real customer:
  // three defunct "campaign created" entries for one live campaign).
  //
  // Optional so callers that do not know it behave exactly as before.
  currentMetaCampaignId?: string | null,
): CondensedEntry[] {
  const rolledBackIds = new Set<string>();
  for (const e of entries) {
    if (e.actionType !== "rollback_build") continue;
    const deleted = (e.newState as { deleted?: unknown }).deleted;
    if (Array.isArray(deleted)) for (const id of deleted) rolledBackIds.add(String(id));
  }

  return entries
    .filter((e) => !INTERNAL_ACTION_TYPES.has(e.actionType))
    .filter((e) => !(e.targetMetaId && rolledBackIds.has(e.targetMetaId)))
    .filter(
      (e) =>
        !(
          currentMetaCampaignId &&
          e.actionType === "create_campaign" &&
          e.targetMetaId &&
          e.targetMetaId !== currentMetaCampaignId
        ),
    )
    .map((e) => ({
    when: e.occurredAt.toISOString(),
    summary: SUMMARY_HE[e.actionType] ?? "שינוי בקמפיין",
    automated: !e.humanInvolved,
    actor: actorOf(e.humanInvolved, e.approvedBy ?? null),
    result: e.result,
  }));
}
