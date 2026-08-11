import type pg from "pg";
import type { LaunchWriter } from "./types.js";

// The launch gate (AIC-53): the ONLY path a builder-created campaign can go
// from PAUSED to spending. Deliberately separate from AIC-50's create-writes
// (which hardcode PAUSED, no exceptions) and from AIC-12's SafeExecutor
// (recommendation-approval-specific, not applicable — there is no
// recommendation here). Same discipline as both: validate → write → verify
// read-back → log to action_history, never silently succeed.
//
// Gate order: launch_approved_at already set → idempotent no-op (a customer
// double-clicking "approve" never re-activates or double-logs). Not linked to
// Meta → fail. status !== 'active' → the campaign hasn't passed first-campaign
// review (AIC-18/38) yet, or a customer hasn't approved requested changes —
// refuse; this is what makes "no builder path can activate directly" true,
// since buildCampaignOnMeta never touches status and a fresh build always
// starts 'under_review'.

export type ActivateOutcome = "activated" | "already_launched" | "not_approved" | "not_linked" | "failed";

export interface ActivateResult {
  outcome: ActivateOutcome;
  reason?: string; // internal detail; never shown to the customer verbatim
}

export async function activateCampaign(
  pool: pg.Pool,
  writer: LaunchWriter,
  campaignId: string,
  approvedBy = "customer",
): Promise<ActivateResult> {
  const { rows } = await pool.query<{
    status: string;
    meta_campaign_id: string | null;
    launch_approved_at: Date | null;
  }>(
    `SELECT status, meta_campaign_id, launch_approved_at FROM managed_campaigns WHERE id = $1`,
    [campaignId],
  );
  const row = rows[0];
  if (!row) return { outcome: "failed", reason: "campaign not found" };
  if (row.launch_approved_at) return { outcome: "already_launched" };
  if (!row.meta_campaign_id) return { outcome: "not_linked", reason: "no Meta campaign linked yet" };
  if (row.status !== "active") return { outcome: "not_approved", reason: `status is ${row.status}, not active — review/approval not complete` };

  let liveStatus: string;
  try {
    liveStatus = await writer.getCampaignStatus(row.meta_campaign_id);
  } catch (e) {
    return { outcome: "failed", reason: `could not read live status: ${(e as Error).message}` };
  }

  if (liveStatus === "ACTIVE") {
    // Defensive: already active on Meta somehow — mark launched, don't re-write.
    await markLaunched(pool, campaignId, row.meta_campaign_id, "campaign was already active on Meta — marked launched", approvedBy);
    return { outcome: "activated" };
  }
  if (liveStatus !== "PAUSED") {
    return { outcome: "failed", reason: `campaign is ${liveStatus} on Meta, cannot activate` };
  }

  try {
    await writer.activateCampaign(row.meta_campaign_id);
  } catch (e) {
    return { outcome: "failed", reason: `activation write failed: ${(e as Error).message}` };
  }

  const after = await writer.getCampaignStatus(row.meta_campaign_id);
  if (after !== "ACTIVE") {
    return { outcome: "failed", reason: `read-back mismatch: campaign is ${after} after activate, not ACTIVE` };
  }

  await markLaunched(pool, campaignId, row.meta_campaign_id, "campaign activated (PAUSED → ACTIVE)", approvedBy);
  return { outcome: "activated" };
}

async function markLaunched(
  pool: pg.Pool,
  campaignId: string,
  metaCampaignId: string,
  what: string,
  approvedBy: string,
): Promise<void> {
  await pool.query(`UPDATE managed_campaigns SET launch_approved_at = now() WHERE id = $1`, [campaignId]);
  await pool.query(
    `INSERT INTO action_history
       (campaign_id, recommendation_id, what, action_type, target_meta_id,
        previous_state, new_state, why, approved_by, human_involved, result)
     VALUES ($1, NULL, $2, 'activate_campaign', $3, '{"status":"PAUSED"}'::jsonb, '{"status":"ACTIVE"}'::jsonb, $4, $5, true, 'success')`,
    [campaignId, what, metaCampaignId, "customer-approved launch (AIC-53)", approvedBy],
  );
}
