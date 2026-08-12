import type pg from "pg";
import type { AdditionWriter } from "./types.js";

// Approving an addition (AIC-63) — the same validate → write → read-back-
// verify → log discipline as the launch gate (AIC-53's activateCampaign),
// generalized below campaign level: activating a campaign doesn't activate
// the ad sets/ads under it, and this is the ONLY path that can.
//
// Unlike the CREATE side, activation writes are naturally idempotent (Meta
// setting an already-ACTIVE object to ACTIVE is a harmless no-op) — checking
// current status before writing means a retry after a partial failure never
// re-activates or double-logs an object that already landed.

export type ApproveOutcome = "approved" | "already_approved" | "not_found" | "failed";

export interface ApproveResult {
  outcome: ApproveOutcome;
  reason?: string;
}

interface PendingRow {
  id: string;
  campaign_id: string;
  kind: "ad" | "ad_set";
  name: string;
  meta_ad_set_id: string;
  meta_ad_ids: string[];
  approved_at: Date | null;
}

export interface PendingAddition {
  id: string;
  kind: "ad" | "ad_set";
  name: string;
  createdAt: string;
}

// Awaiting the customer's approval — the reason this exists at all instead of
// activating on create: nothing new spends without an explicit "yes".
export async function listPendingAdditions(pool: pg.Pool, campaignId: string): Promise<PendingAddition[]> {
  const { rows } = await pool.query<{ id: string; kind: "ad" | "ad_set"; name: string; created_at: Date }>(
    `SELECT id, kind, name, created_at FROM pending_additions WHERE campaign_id = $1 AND approved_at IS NULL ORDER BY created_at DESC`,
    [campaignId],
  );
  return rows.map((r) => ({ id: r.id, kind: r.kind, name: r.name, createdAt: r.created_at.toISOString() }));
}

export async function approveAddition(
  pool: pg.Pool,
  writer: AdditionWriter,
  additionId: string,
  callerCampaignId: string,
): Promise<ApproveResult> {
  const { rows } = await pool.query<PendingRow>(
    `SELECT id, campaign_id, kind, name, meta_ad_set_id, meta_ad_ids, approved_at FROM pending_additions WHERE id = $1`,
    [additionId],
  );
  const row = rows[0];
  if (!row || row.campaign_id !== callerCampaignId) return { outcome: "not_found" };
  if (row.approved_at) return { outcome: "already_approved" };

  try {
    if (row.kind === "ad_set") {
      await activateOne(writer, "ad_set", row.meta_ad_set_id, pool, row.campaign_id, row.name);
    }
    for (const adId of row.meta_ad_ids) {
      await activateOne(writer, "ad", adId, pool, row.campaign_id, row.name);
    }
  } catch (e) {
    return { outcome: "failed", reason: (e as Error).message };
  }

  await pool.query(`UPDATE pending_additions SET approved_at = now() WHERE id = $1`, [additionId]);
  return { outcome: "approved" };
}

async function activateOne(
  writer: AdditionWriter,
  kind: "ad" | "ad_set",
  metaId: string,
  pool: pg.Pool,
  campaignId: string,
  additionName: string,
): Promise<void> {
  const current = kind === "ad_set" ? await writer.getAdSetStatus(metaId) : await writer.getAdStatus(metaId);
  if (current === "ACTIVE") return; // already landed (a retry after partial failure) — no-op, no duplicate log

  if (kind === "ad_set") await writer.activateAdSet(metaId);
  else await writer.activateAd(metaId);

  const after = kind === "ad_set" ? await writer.getAdSetStatus(metaId) : await writer.getAdStatus(metaId);
  if (after !== "ACTIVE") throw new Error(`read-back mismatch: ${kind} ${metaId} is ${after} after activate, not ACTIVE`);

  await pool.query(
    `INSERT INTO action_history
       (campaign_id, recommendation_id, what, action_type, target_meta_id,
        previous_state, new_state, why, approved_by, human_involved, result)
     VALUES ($1, NULL, $2, $3, $4, '{"status":"PAUSED"}'::jsonb, '{"status":"ACTIVE"}'::jsonb, $5, 'customer', true, 'success')`,
    [
      campaignId,
      `activated ${kind === "ad_set" ? "ad set" : "ad"} "${additionName}"`,
      kind === "ad_set" ? "activate_ad_set" : "activate_ad",
      metaId,
      "customer-approved addition (AIC-63)",
    ],
  );
}
