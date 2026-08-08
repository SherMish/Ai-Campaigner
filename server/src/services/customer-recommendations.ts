import type pg from "pg";
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
): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT mc.id
     FROM app_users u
     JOIN managed_campaigns mc ON mc.customer_id = u.customer_id
     WHERE u.id = $1
     LIMIT 1`,
    [userId],
  );
  return rows[0]?.id ?? null;
}

export async function listCustomerRecommendations(
  pool: pg.Pool,
  userId: string,
): Promise<CustomerRecList> {
  const campaignId = await resolveCampaignId(pool, userId);
  if (!campaignId) return { campaignId: null, pending: [], history: [] };

  const store = new PgRecommendationStore(pool);
  const [proposed, customerId] = await Promise.all([
    store.listProposed(campaignId),
    pool
      .query<{ customer_id: string }>(
        `SELECT customer_id FROM managed_campaigns WHERE id = $1`,
        [campaignId],
      )
      .then((r) => r.rows[0]?.customer_id ?? null),
  ]);
  const history = customerId
    ? condense(await listCustomerActionHistory(pool, customerId)).slice(0, 12)
    : [];

  return { campaignId, pending: proposed.map(toDto), history };
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
  const campaignId = await resolveCampaignId(pool, userId);
  if (!campaignId) return { status: "not_found" };

  const store = new PgRecommendationStore(pool);
  const rec = await store.getById(recId);
  if (!rec || rec.campaignId !== campaignId) return { status: "not_found" };
  if (rec.state !== "proposed") return { status: "not_pending" };

  const executor = buildCustomerExecutor(pool);
  if (!executor) return { status: "unavailable" };

  // proposed → approved, then run the pipeline (approved → executing → …).
  await new RecommendationService(store).approve(recId, "customer");
  const result = await executor.execute(recId, "customer");
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
