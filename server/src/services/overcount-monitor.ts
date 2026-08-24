import type pg from "pg";
import type { OpsQueue } from "./ops-queue.js";
import type { OvercountSummary } from "../meta/overcount.js";

// Persist a suspected over-count (AIC-92) and raise an ops item.
//
// OPERATOR-FIRST BY DESIGN. This check implicitly tells a customer "your numbers
// are too good to be true", which needs verification before it is said out loud
// — a false accusation here is worse than a day's delay. So it raises an ops
// item and blocks budget increases, and deliberately does NOT drive a
// customer-facing hero or a no_rec_reason. The customer sees nothing until an
// operator has looked.
export async function recordOvercount(deps: {
  pool: pg.Pool;
  ops: OpsQueue;
  campaignId: string;
  customerId: string | null;
  summary: OvercountSummary;
}): Promise<{ raisedOps: boolean }> {
  const { pool, ops, campaignId, customerId, summary } = deps;

  if (summary.state === "unknown") {
    await pool.query(`UPDATE managed_campaigns SET overcount_checked_at = now() WHERE id = $1`, [campaignId]);
    return { raisedOps: false };
  }

  const suspected = summary.state === "suspected";
  await pool.query(
    `UPDATE managed_campaigns
     SET overcount_suspected = $2, overcount_reason = $3, overcount_detail = $4, overcount_checked_at = now()
     WHERE id = $1`,
    [campaignId, suspected, suspected ? summary.reason : null, suspected ? JSON.stringify(summary.detail) : null],
  );
  if (!suspected) return { raisedOps: false };

  const open = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM ops_queue_items
     WHERE campaign_id = $1 AND type = 'leads_possibly_overcounted' AND status <> 'resolved'`,
    [campaignId],
  );
  if (Number(open.rows[0]?.n ?? 0) > 0) return { raisedOps: false };

  await ops.create({
    customerId,
    campaignId,
    type: "leads_possibly_overcounted",
    // high: while this is true the engine's own numbers argue for spending more
    // on a campaign that may be producing nothing.
    severity: "high",
    detail: `${summary.reason ?? "leads look inflated"} — ${String((summary.detail as Record<string, unknown>).likelyCause ?? "cause unclear")}`,
  });
  return { raisedOps: true };
}
