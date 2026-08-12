import type pg from "pg";
import type { ControlWriter, ControlObjectKind, ManualObjectStatus } from "./types.js";

// Manual pause / resume / archive / delete of a single ad or ad set (AIC-66).
//
// Same discipline as AIC-53's launch gate and AIC-63's approveAddition —
// validate → write → read-back verify → log to action_history, never silently
// succeed — applied per object. What's different here is the AUTHORIZATION
// model: there is no recommendation and no approval step, because the human
// performing the action is the authorization. Callers must therefore prove
// ownership BEFORE calling (see assertOwnedByCampaign) — this module never
// trusts a Meta id on its own.

export type ControlOutcome = "changed" | "already" | "not_found" | "failed";

export interface ControlResult {
  outcome: ControlOutcome;
  previousStatus?: string;
  newStatus?: ManualObjectStatus;
  detail?: string;
}

// Who initiated — recorded on the action_history row so the customer-facing
// history can honestly say "you did this" vs "your operator did this".
export type ControlActor = { kind: "customer" | "operator"; label: string };

const ACTION_TYPE: Record<ManualObjectStatus, Record<ControlObjectKind, string>> = {
  PAUSED: { ad: "pause_ad", ad_set: "pause_ad_set" },
  ACTIVE: { ad: "resume_ad", ad_set: "resume_ad_set" },
  ARCHIVED: { ad: "archive_ad", ad_set: "archive_ad_set" },
  DELETED: { ad: "delete_ad", ad_set: "delete_ad_set" },
};

// Meta reports a still-live object as ACTIVE/PAUSED; an archived or deleted one
// keeps reporting ARCHIVED/DELETED. Treating "already at target" as a no-op is
// what makes a retry after a partial failure safe (same reasoning as
// approveAddition: an absolute-set status write is naturally idempotent).
function alreadyAtTarget(current: string, target: ManualObjectStatus): boolean {
  return current.toUpperCase() === target;
}

/**
 * Prove a Meta object id really belongs to the caller's own campaign, by listing
 * the campaign's live children and membership-testing. The established pattern
 * from AIC-63's POST /additions/ad — a client-supplied id is never trusted.
 */
export async function assertOwnedByCampaign(
  writer: ControlWriter,
  metaCampaignId: string,
  kind: ControlObjectKind,
  metaObjectId: string,
): Promise<boolean> {
  const state = await writer.getCampaignState(metaCampaignId);
  const owned = kind === "ad" ? state.adStatuses : state.adSetStatuses;
  return Object.prototype.hasOwnProperty.call(owned, metaObjectId);
}

/**
 * Apply a manual status change to one ad or ad set.
 *
 * Ownership must already be established by the caller (routes do this against
 * the JWT-resolved campaign). Returns an outcome rather than throwing, so a
 * route can answer honestly without leaking Meta internals to the customer.
 */
export async function setObjectStatus(deps: {
  pool: pg.Pool;
  writer: ControlWriter;
  campaignId: string; // our local managed_campaigns.id, for action_history
  kind: ControlObjectKind;
  metaObjectId: string;
  status: ManualObjectStatus;
  actor: ControlActor;
}): Promise<ControlResult> {
  const { pool, writer, campaignId, kind, metaObjectId, status, actor } = deps;

  const read = () => (kind === "ad" ? writer.getAdStatus(metaObjectId) : writer.getAdSetStatus(metaObjectId));
  const write = () =>
    kind === "ad" ? writer.setAdStatus(metaObjectId, status) : writer.setAdSetStatus(metaObjectId, status);

  let previous: string;
  try {
    previous = await read();
  } catch (e) {
    return { outcome: "not_found", detail: (e as Error).message };
  }

  if (alreadyAtTarget(previous, status)) {
    return { outcome: "already", previousStatus: previous, newStatus: status };
  }

  try {
    await write();
  } catch (e) {
    await logControl({ pool, campaignId, kind, metaObjectId, status, actor, previous, result: "failed" });
    return { outcome: "failed", previousStatus: previous, detail: (e as Error).message };
  }

  // Read-back verify — a write Meta accepted but didn't apply must not be
  // reported as success. DELETED objects can stop being readable at all, which
  // is itself confirmation, so a read failure there is treated as applied.
  let after: string;
  try {
    after = await read();
  } catch {
    after = status === "DELETED" ? "DELETED" : "";
  }
  if (!alreadyAtTarget(after, status)) {
    await logControl({ pool, campaignId, kind, metaObjectId, status, actor, previous, result: "failed" });
    return {
      outcome: "failed",
      previousStatus: previous,
      detail: `Meta accepted the change but ${metaObjectId} still reads ${after || "unknown"}`,
    };
  }

  await logControl({ pool, campaignId, kind, metaObjectId, status, actor, previous, result: "success" });
  return { outcome: "changed", previousStatus: previous, newStatus: status };
}

// Every manual control writes an action_history row (human_involved = true,
// recommendation_id NULL — there is no recommendation behind it). Operator
// actions ALSO write an admin_audit_log row at the route layer; this is the
// campaign-scoped, customer-visible half.
async function logControl(deps: {
  pool: pg.Pool;
  campaignId: string;
  kind: ControlObjectKind;
  metaObjectId: string;
  status: ManualObjectStatus;
  actor: ControlActor;
  previous: string;
  result: "success" | "failed";
}): Promise<void> {
  const { pool, campaignId, kind, metaObjectId, status, actor, previous, result } = deps;
  const label = kind === "ad" ? "מודעה" : "קבוצת מודעות";
  await pool.query(
    `INSERT INTO action_history
       (campaign_id, recommendation_id, what, action_type, target_meta_id,
        previous_state, new_state, why, approved_by, human_involved, result)
     VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, true, $9)`,
    [
      campaignId,
      `${label} ${metaObjectId}`,
      ACTION_TYPE[status][kind],
      metaObjectId,
      JSON.stringify({ status: previous }),
      JSON.stringify({ status }),
      actor.kind === "customer" ? "שינוי ידני על ידי הלקוח" : "שינוי ידני על ידי צוות התפעול",
      actor.label,
      result,
    ],
  );
}
