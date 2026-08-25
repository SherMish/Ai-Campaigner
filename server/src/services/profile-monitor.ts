import type pg from "pg";
import type { OpsQueue } from "./ops-queue.js";
import { summarizeProfile, type ProfileSummary } from "./profile-quality.js";

// AIC-132: persist the profile verdict and raise an ops item when a paying
// customer is un-advertisable.
//
// Mirrors recordCampaignCta / recordAccount, with two deliberate differences.
//
// KEYED ON THE CUSTOMER, not the campaign. A business is described once and
// every campaign it runs inherits the same answer; storing it per campaign
// would let the copies disagree, and the fix is the same one regardless of
// which campaign surfaced it.
//
// IT NEVER HALTS ANYTHING. Like over-count detection, it informs and suppresses
// — a campaign with a thin profile keeps running, because pausing a customer's
// advertising over OUR missing paperwork would be an absurd trade.

export async function recordProfileQuality(deps: {
  pool: pg.Pool;
  ops: OpsQueue;
  customerId: string;
  businessName: string;
  summary: ProfileSummary;
}): Promise<{ raisedOps: boolean }> {
  const { pool, ops, customerId, businessName, summary } = deps;

  await pool.query(
    `UPDATE customers
        SET profile_ok = $2, profile_state = $3, profile_reason = $4,
            profile_detail = $5, profile_checked_at = now()
      WHERE id = $1`,
    [
      customerId,
      summary.state === "ok",
      summary.state,
      summary.reason,
      JSON.stringify({ missing: summary.missing, vague: summary.vague }),
    ],
  );

  // Only `broken` is worth an operator's attention. `thin` is a nudge the
  // wizard badge already makes at exactly the moment it can be acted on — with
  // the customer on the phone — and an ops item for every imperfect profile
  // would bury the queue in things nobody is going to do today.
  if (summary.state !== "broken") return { raisedOps: false };

  // Idempotent, not edge-triggered: raise only when there is no open item, so a
  // failure between the flag write and the ops insert self-heals next tick.
  const open = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM ops_queue_items
      WHERE customer_id = $1 AND type = 'business_profile_incomplete' AND status <> 'resolved'`,
    [customerId],
  );
  if (Number(open.rows[0]?.n ?? 0) > 0) return { raisedOps: false };

  await ops.create({
    customerId,
    type: "business_profile_incomplete",
    // medium, not high: nothing is on fire and no money is being wasted right
    // now — but every copy/creative feature is blocked on it, so it must not
    // sit at the bottom of the queue either.
    severity: "medium",
    detail: `${businessName}: חסרים פרטי עסק בסיסיים (${summary.missing.join(", ")}) — אי אפשר לכתוב קופי בלי הצעה ובידול`,
  });
  return { raisedOps: true };
}

/** Judge every customer that has a managed campaign. Runs on the engine tick. */
export async function runProfileQualityTick(pool: pg.Pool, ops: OpsQueue): Promise<{
  checked: number; broken: number; thin: number;
}> {
  const { rows } = await pool.query<{
    id: string; business_name: string; category: string | null; main_service: string | null;
    geo_area: string | null; primary_customer: string | null; offer: string | null;
    differentiators: string | null; objections: string | null; price_range: string | null;
  }>(
    // Only customers we actually advertise for. A lead in the CRM with no
    // campaign has no business profile to be incomplete about yet, and
    // flagging them would make the queue a list of prospects.
    `SELECT DISTINCT c.id, c.business_name, c.category, c.main_service, c.geo_area,
            c.primary_customer, c.offer, c.differentiators, c.objections, c.price_range
       FROM customers c
       JOIN managed_campaigns mc ON mc.customer_id = c.id
      WHERE c.is_active`,
  );

  let broken = 0;
  let thin = 0;
  for (const r of rows) {
    const summary = summarizeProfile({
      category: r.category, mainService: r.main_service, geoArea: r.geo_area,
      primaryCustomer: r.primary_customer, offer: r.offer,
      differentiators: r.differentiators, objections: r.objections, priceRange: r.price_range,
    });
    if (summary.state === "broken") broken++;
    if (summary.state === "thin") thin++;
    await recordProfileQuality({
      pool, ops, customerId: r.id, businessName: r.business_name, summary,
    });
  }
  return { checked: rows.length, broken, thin };
}
