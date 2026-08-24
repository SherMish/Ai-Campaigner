import type pg from "pg";
import type { OpsQueue } from "./ops-queue.js";
import type { AccountSummary } from "../meta/account-health.js";

// Persist an ad account's ability to spend (AIC-72) and raise an ops item when
// it cannot. Mirrors recordCampaignTracking / recordCampaignCta, including both
// corrections that pattern made to the older delivery-monitor:
//
//   1. `unknown` NEVER writes `account_ok` — a failed Meta read is not "fine",
//      and writing ok would silently clear a real alarm. Only the timestamp
//      advances.
//   2. The ops item is idempotent ("broken AND no open item"), not edge-
//      triggered — an edge raise is lost forever if ops.create throws after the
//      flag write lands.
//
// Keyed on the CONNECTION, not the campaign: one ad account can back several
// campaigns, and caching the same fact per-campaign lets the copies disagree.
export async function recordAccountHealth(deps: {
  pool: pg.Pool;
  ops: OpsQueue;
  connectionId: string;
  customerId: string | null;
  summary: AccountSummary;
}): Promise<{ raisedOps: boolean }> {
  const { pool, ops, connectionId, customerId, summary } = deps;

  if (summary.state === "unknown") {
    await pool.query(`UPDATE meta_connections SET account_checked_at = now() WHERE id = $1`, [connectionId]);
    return { raisedOps: false };
  }

  const ok = summary.state === "ok";
  await pool.query(
    `UPDATE meta_connections
     SET account_ok = $2, account_reason = $3, account_detail = $4, account_checked_at = now()
     WHERE id = $1`,
    [connectionId, ok, ok ? null : summary.reason, ok ? null : JSON.stringify(summary.detail)],
  );
  if (ok) return { raisedOps: false };

  const open = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM ops_queue_items
     WHERE customer_id = $1 AND type = 'ad_account_cannot_spend' AND status <> 'resolved'`,
    [customerId],
  );
  if (Number(open.rows[0]?.n ?? 0) > 0) return { raisedOps: false };

  await ops.create({
    customerId,
    // No campaignId: the problem is the ACCOUNT, and attaching it to one
    // campaign would imply the others are fine when every campaign on the
    // account is equally dead.
    campaignId: null,
    type: "ad_account_cannot_spend",
    // high: nothing on this account can deliver, whatever its campaigns say.
    severity: "high",
    detail: summary.reason ?? "the ad account cannot spend",
  });
  return { raisedOps: true };
}
