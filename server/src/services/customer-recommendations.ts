import { resolveOwnedCampaign } from "./campaign-selection.js";
import type pg from "pg";
import { track } from "../analytics/mixpanel.js";
import type { RecommendationType } from "@aic/shared";
import { PgRecommendationStore } from "../recommendations/recommendation-store.js";
import { RecommendationService } from "../recommendations/recommendation-service.js";
import type { RecommendationRecord } from "../recommendations/types.js";
import { explain } from "../recommendations/explainer.js";
import {
  SafeExecutor,
  type AccessGuard,
  type CampaignLoader,
  type ExecResult,
  type OpsRaiser,
} from "../execution/safe-executor.js";
import { ControlService, PgControlStore } from "../execution/control-service.js";
import { GraphCampaignAdapter } from "../meta/campaign-adapter.js";
import { OpsQueue } from "./ops-queue.js";
import {
  listCustomerActionHistory,
  condense,
  type CondensedEntry,
} from "./action-history.js";
import type { NoActionReason } from "../recommendations/rules.js";

// The customer-facing shape of one recommendation (AIC-23). Deterministic
// plain-Hebrew explanation is built server-side by `explain()` from the
// structured record — the number fidelity guarantee. No Ads Manager jargon.
export interface CustomerRec {
  id: string;
  type: RecommendationType;
  explanation: string;
  currentBudgetAgorot: number | null;
  proposedBudgetAgorot: number | null;
  maxSpendImpactAgorot: number | null;
  targetMetaId: string | null;
}

export interface CustomerRecList {
  campaignId: string | null;
  pending: CustomerRec[];
  history: CondensedEntry[];
  // AIC-98 gap, found 2026-08-22: when `pending` is empty this screen said
  // only "אין עדיין המלצות" — strictly LESS than the dashboard the customer
  // just clicked through from, which names the reason. A customer who opens
  // המלצות is ASKING why there is nothing; a drill-down that answers less
  // than its own summary is backwards. The reason is already computed and
  // already has copy — it was simply never sent to this endpoint.
  noRecReason: NoActionReason | null;
  noRecDetail: Record<string, unknown> | null;
}

function toDto(rec: RecommendationRecord): CustomerRec {
  return {
    id: rec.id,
    type: rec.type,
    explanation: explain(rec),
    currentBudgetAgorot: rec.currentBudgetAgorot,
    proposedBudgetAgorot: rec.proposedBudgetAgorot,
    maxSpendImpactAgorot: rec.maxSpendImpactAgorot,
    targetMetaId: rec.targetMetaId,
  };
}

// The caller's single managed campaign id (P0 = one per customer), or null.
export async function resolveCampaignId(
  pool: pg.Pool,
  userId: string,
  // AIC-186: which campaign, when the customer has more than one. Optional so
  // every existing caller keeps the single-campaign behaviour unchanged.
  campaignId?: string | null,
): Promise<string | null> {
  return (await resolveCampaignOwner(pool, userId, campaignId))?.campaignId ?? null;
}

/**
 * The caller's campaign together with WHOSE it is — AIC-28 needs the customer
 * id (the analytics subject: one profile per business, not per login) and the
 * `is_test` flag, so our own rows never enter the activation funnel.
 */
export async function resolveCampaignOwner(
  pool: pg.Pool,
  userId: string,
  campaignId?: string | null,
): Promise<{ campaignId: string; customerId: string; isTest: boolean } | null> {
  // AIC-186 — the requested campaign, RE-CHECKED against the caller's own
  // customer in the same query that fetches it, so an unvalidated id is never
  // in play. No id means the customer's oldest campaign, which is exactly what
  // the old LIMIT 1 returned.
  const owned = await resolveOwnedCampaign(pool, userId, campaignId);
  return owned
    ? { campaignId: owned.campaignId, customerId: owned.customerId, isTest: owned.isTest }
    : null;
}

export async function listCustomerRecommendations(
  pool: pg.Pool,
  userId: string,
  // AIC-192 — which campaign. Without this the switcher moved the dashboard
  // while the recommendations under it stayed on the default campaign.
  selected?: string | null,
): Promise<CustomerRecList> {
  const campaignId = await resolveCampaignId(pool, userId, selected);
  if (!campaignId) return { campaignId: null, pending: [], history: [], noRecReason: null, noRecDetail: null };

  const store = new PgRecommendationStore(pool);
  const [proposed, campaignRow] = await Promise.all([
    store.listProposed(campaignId),
    pool
      .query<{ customer_id: string; meta_campaign_id: string | null; no_rec_reason: string | null; no_rec_detail: Record<string, unknown> | null }>(
        `SELECT customer_id, meta_campaign_id, no_rec_reason, no_rec_detail FROM managed_campaigns WHERE id = $1`,
        [campaignId],
      )
      .then((r) => r.rows[0] ?? null),
  ]);
  const customerId = campaignRow?.customer_id ?? null;
  const history = customerId
    ? condense(await listCustomerActionHistory(pool, customerId), campaignRow?.meta_campaign_id ?? null).slice(0, 12)
    : [];

  return {
    campaignId,
    pending: proposed.map(toDto),
    history,
    noRecReason: (campaignRow?.no_rec_reason as NoActionReason | null) ?? null,
    noRecDetail: campaignRow?.no_rec_detail ?? null,
  };
}

// A single recommendation, ownership-checked against the caller's campaign.
export async function getCustomerRecommendation(
  pool: pg.Pool,
  userId: string,
  recId: string,
): Promise<CustomerRec | null> {
  const campaignId = await resolveCampaignId(pool, userId);
  if (!campaignId) return null;
  const rec = await new PgRecommendationStore(pool).getById(recId);
  if (!rec || rec.campaignId !== campaignId) return null;
  return toDto(rec);
}

// Build the production safe-execute pipeline for a customer approval. Returns
// null when no Meta token is configured (execution unavailable) — the caller
// then reports an honest "temporarily unavailable" instead of pretending.
export function buildCustomerExecutor(pool: pg.Pool): SafeExecutor | null {
  const token = process.env.META_SYSTEM_USER_TOKEN;
  if (!token) return null;
  const ver = process.env.META_GRAPH_VERSION || "v21.0";

  const store = new PgRecommendationStore(pool);
  const service = new RecommendationService(store);
  const adapter = new GraphCampaignAdapter(token, ver);

  const campaigns: CampaignLoader = {
    load: async (campaignId: string) => {
      const { rows } = await pool.query<{
        id: string;
        meta_campaign_id: string | null;
        customer_id: string;
        agreed_budget_agorot: number;
        connection_id: string | null;
      }>(
        `SELECT mc.id, mc.meta_campaign_id, mc.customer_id, mc.agreed_budget_agorot,
                conn.id AS connection_id
         FROM managed_campaigns mc
         LEFT JOIN meta_connections conn ON conn.customer_id = mc.customer_id
         WHERE mc.id = $1`,
        [campaignId],
      );
      const r = rows[0];
      if (!r) return null;
      return {
        id: r.id,
        metaCampaignId: r.meta_campaign_id,
        connectionId: r.connection_id,
        customerId: r.customer_id,
        agreedBudgetAgorot: Number(r.agreed_budget_agorot),
      };
    },
  };

  // Access-health gate (AIC-5): reads persisted health, throws unless 'ok'.
  const connectionGuard: AccessGuard = {
    assertExecutable: async (connectionId: string) => {
      const { rows } = await pool.query<{ access_health: string }>(
        `SELECT access_health FROM meta_connections WHERE id = $1`,
        [connectionId],
      );
      if (!rows[0] || rows[0].access_health !== "ok") {
        throw new Error(`connection ${connectionId} not ok`);
      }
    },
  };

  const controlGate = new ControlService(new PgControlStore(pool));
  const opsQueue = new OpsQueue(pool);
  const ops: OpsRaiser = { raise: (item) => opsQueue.create(item).then(() => undefined) };

  return new SafeExecutor({
    store,
    service,
    campaigns,
    reader: adapter,
    writer: adapter,
    connectionGuard,
    controlGate,
    ops,
  });
}

export type ApproveStatus = "not_found" | "not_pending" | "unavailable" | "done";
export interface ApproveResult {
  status: ApproveStatus;
  result?: ExecResult;
}

// Approve → run the safe-execute pipeline (AIC-12). Ownership-checked; only a
// 'proposed' rec can be approved. When no executor is available (no Meta token),
// the rec is left untouched and 'unavailable' is returned.
export async function approveCustomerRecommendation(
  pool: pg.Pool,
  userId: string,
  recId: string,
): Promise<ApproveResult> {
  const owner = await resolveCampaignOwner(pool, userId);
  if (!owner) return { status: "not_found" };

  const store = new PgRecommendationStore(pool);
  const rec = await store.getById(recId);
  if (!rec || rec.campaignId !== owner.campaignId) return { status: "not_found" };
  if (rec.state !== "proposed") return { status: "not_pending" };

  const executor = buildCustomerExecutor(pool);
  if (!executor) return { status: "unavailable" };

  // proposed → approved, then run the pipeline (approved → executing → …).
  await new RecommendationService(store).approve(recId, "customer");
  const result = await executor.execute(recId, "customer");

  // AIC-28's VALUE MOMENT: the engine's judgement became a real change to a
  // real campaign, with the customer's consent. Everything upstream in the
  // funnel exists to reach this event.
  //
  // Fired after execute() so the property records what actually happened —
  // an approval whose Meta write failed is not the same outcome as one that
  // landed, and collapsing them would overstate the product working.
  track({
    event: "recommendation_approved",
    customerId: owner.customerId,
    isTest: owner.isTest,
    props: {
      recommendation_type: rec.type,
      execution_outcome: result.outcome,
      campaign_id: owner.campaignId,
    },
  });
  return { status: "done", result };
}

// Dismiss ("not now") → proposed → dismissed. Ownership-checked; idempotent-ish:
// only a proposed rec can be dismissed.
export async function dismissCustomerRecommendation(
  pool: pg.Pool,
  userId: string,
  recId: string,
): Promise<"not_found" | "not_pending" | "done"> {
  const campaignId = await resolveCampaignId(pool, userId);
  if (!campaignId) return "not_found";
  const store = new PgRecommendationStore(pool);
  const rec = await store.getById(recId);
  if (!rec || rec.campaignId !== campaignId) return "not_found";
  if (rec.state !== "proposed") return "not_pending";
  await new RecommendationService(store).dismiss(recId);
  return "done";
}
