import type pg from "pg";
import type { RecommendationType, RecommendationState } from "@aic/shared";
import { logAdminAction, type Actor } from "./admin-audit.js";

// Recommendations oversight (AIC-46): the operator's cross-account window into
// what the engine is proposing, on what evidence, and whether executions are
// landing — PRD §23. This is READ + FLAG only; there is deliberately no
// operator-initiated approve/execute here. The product's whole trust model is
// "every spend/delivery change requires customer approval" — a side-channel
// execute button for operators would undercut that for a P0 feature the
// ticket itself marks optional ("decide in build"). If a real support case
// ever needs an operator to act on a customer's behalf, that should be its
// own explicit, audited flow through AIC-12 — not bolted onto this oversight
// list.

export interface AdminRecRow {
  id: string;
  customerId: string;
  businessName: string;
  campaignId: string;
  campaignName: string;
  type: RecommendationType;
  state: RecommendationState;
  evidence: Record<string, unknown>;
  currentBudgetAgorot: number | null;
  proposedBudgetAgorot: number | null;
  maxSpendImpactAgorot: number | null;
  rationale: string;
  createdAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  executedAt: string | null;
  flaggedForReview: boolean;
  flagNote: string | null;
  flaggedAt: string | null;
  actionHistoryId: string | null; // latest action_history row for this rec, if executed
  executionResult: "success" | "failed" | null;
}

export interface RecFilter {
  state?: RecommendationState;
  type?: RecommendationType;
  customerId?: string;
}

// Ordered newest-first, capped — this is a triage/audit view, not a report;
// an operator scanning "what has the engine done lately" wants the recent
// tail, not an unbounded table. Filters narrow it further.
const LIST_LIMIT = 300;

export async function listRecommendationsForAdmin(pool: pg.Pool, filter: RecFilter = {}): Promise<AdminRecRow[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.state) { params.push(filter.state); clauses.push(`r.state = $${params.length}`); }
  if (filter.type) { params.push(filter.type); clauses.push(`r.type = $${params.length}`); }
  if (filter.customerId) { params.push(filter.customerId); clauses.push(`c.id = $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const { rows } = await pool.query(
    `SELECT r.*, mc.name AS campaign_name, c.id AS customer_id, c.business_name,
            ah.id AS action_history_id, ah.result AS execution_result
     FROM recommendations r
     JOIN managed_campaigns mc ON mc.id = r.campaign_id
     JOIN customers c ON c.id = mc.customer_id
     LEFT JOIN LATERAL (
       SELECT id, result FROM action_history
       WHERE recommendation_id = r.id
       ORDER BY occurred_at DESC LIMIT 1
     ) ah ON true
     ${where}
     ORDER BY r.created_at DESC
     LIMIT ${LIST_LIMIT}`,
    params,
  );

  return rows.map((r) => ({
    id: r.id,
    customerId: r.customer_id,
    businessName: r.business_name,
    campaignId: r.campaign_id,
    campaignName: r.campaign_name,
    type: r.type,
    state: r.state,
    evidence: r.evidence ?? {},
    currentBudgetAgorot: r.current_budget_agorot,
    proposedBudgetAgorot: r.proposed_budget_agorot,
    maxSpendImpactAgorot: r.max_spend_impact_agorot,
    rationale: r.rationale ?? "",
    createdAt: new Date(r.created_at).toISOString(),
    approvedBy: r.approved_by,
    approvedAt: r.approved_at ? new Date(r.approved_at).toISOString() : null,
    executedAt: r.executed_at ? new Date(r.executed_at).toISOString() : null,
    flaggedForReview: r.flagged_for_review,
    flagNote: r.flag_note,
    flaggedAt: r.flagged_at ? new Date(r.flagged_at).toISOString() : null,
    actionHistoryId: r.action_history_id ?? null,
    executionResult: r.execution_result ?? null,
  }));
}

type FlagResult = { ok: true } | { ok: false; error: string };

export async function flagRecommendation(pool: pg.Pool, actor: Actor, id: string, note: string): Promise<FlagResult> {
  const { rows } = await pool.query<{ type: string; business_name: string }>(
    `SELECT r.type, c.business_name FROM recommendations r
     JOIN managed_campaigns mc ON mc.id = r.campaign_id
     JOIN customers c ON c.id = mc.customer_id
     WHERE r.id = $1`,
    [id],
  );
  const rec = rows[0];
  if (!rec) return { ok: false, error: "recommendation not found" };

  await pool.query(
    `UPDATE recommendations SET flagged_for_review = true, flag_note = $2, flagged_by = $3, flagged_at = now() WHERE id = $1`,
    [id, note || null, actor.userId],
  );
  await logAdminAction(pool, {
    actorUserId: actor.userId, actorLabel: actor.label,
    action: "recommendation.flag", entityType: "recommendation", entityId: id,
    entityLabel: `${rec.business_name} — ${rec.type}`,
    detail: note ? `Flagged for review: ${note}` : "Flagged for review",
  });
  return { ok: true };
}

export async function unflagRecommendation(pool: pg.Pool, actor: Actor, id: string): Promise<FlagResult> {
  const { rows } = await pool.query<{ type: string; business_name: string }>(
    `SELECT r.type, c.business_name FROM recommendations r
     JOIN managed_campaigns mc ON mc.id = r.campaign_id
     JOIN customers c ON c.id = mc.customer_id
     WHERE r.id = $1`,
    [id],
  );
  const rec = rows[0];
  if (!rec) return { ok: false, error: "recommendation not found" };

  await pool.query(
    `UPDATE recommendations SET flagged_for_review = false, flag_note = NULL, flagged_by = NULL, flagged_at = NULL WHERE id = $1`,
    [id],
  );
  await logAdminAction(pool, {
    actorUserId: actor.userId, actorLabel: actor.label,
    action: "recommendation.unflag", entityType: "recommendation", entityId: id,
    entityLabel: `${rec.business_name} — ${rec.type}`,
    detail: "Cleared the review flag",
  });
  return { ok: true };
}
