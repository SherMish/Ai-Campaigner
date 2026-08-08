import type pg from "pg";
import type { AccessHealth } from "@aic/shared";
import { ConnectionService } from "../meta/connection-service.js";
import { PgConnectionStore } from "../meta/connection-store.js";
import { GraphMetaClient } from "../meta/client.js";
import { OpsQueue } from "./ops-queue.js";

// The caller's connection id (P0 = one per customer), or null.
async function resolveConnectionId(pool: pg.Pool, userId: string): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT conn.id
     FROM app_users u
     JOIN meta_connections conn ON conn.customer_id = u.customer_id
     WHERE u.id = $1
     LIMIT 1`,
    [userId],
  );
  return rows[0]?.id ?? null;
}

// Re-verify the caller's Meta connection (AIC-21 "check connection"). With a
// System-User token it does a live per-asset check via ConnectionService.verify
// (persisting health + raising an ops item on loss); without a token it honestly
// returns the currently-stored health rather than pretending to re-check.
// Returns null when the caller has no connection.
export async function recheckCustomerConnection(
  pool: pg.Pool,
  userId: string,
): Promise<AccessHealth | null> {
  const connId = await resolveConnectionId(pool, userId);
  if (!connId) return null;

  const token = process.env.META_SYSTEM_USER_TOKEN;
  if (!token) {
    const { rows } = await pool.query<{ access_health: AccessHealth }>(
      `SELECT access_health FROM meta_connections WHERE id = $1`,
      [connId],
    );
    return rows[0]?.access_health ?? null;
  }

  const service = new ConnectionService(new PgConnectionStore(pool), new GraphMetaClient(token));
  return service.verify(connId);
}

// A customer's budget-change request (AIC-24). P0 budget changes are a REQUEST a
// human acts on, never a silent edit — so this raises an ops-queue item for the
// operator to follow up, scoped to the caller's own customer/campaign.
export async function requestBudgetChange(
  pool: pg.Pool,
  userId: string,
  requestedAgorot: number | null,
): Promise<boolean> {
  const { rows } = await pool.query<{
    customer_id: string | null;
    campaign_id: string | null;
    agreed_budget_agorot: number | null;
  }>(
    `SELECT u.customer_id,
            mc.id AS campaign_id,
            mc.agreed_budget_agorot
     FROM app_users u
     LEFT JOIN managed_campaigns mc ON mc.customer_id = u.customer_id
     WHERE u.id = $1`,
    [userId],
  );
  const r = rows[0];
  if (!r?.customer_id) return false;

  const detail =
    requestedAgorot != null
      ? `Customer requested a daily budget change to ${requestedAgorot} agorot (current agreed: ${r.agreed_budget_agorot ?? "?"}).`
      : `Customer requested a budget change (amount to be discussed).`;

  await new OpsQueue(pool).create({
    customerId: r.customer_id,
    campaignId: r.campaign_id ?? null,
    type: "support_request",
    severity: "medium",
    detail,
  });
  return true;
}
