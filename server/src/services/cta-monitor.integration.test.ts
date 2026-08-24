// AIC-128: persistence + ops escalation for the CTA check. Mirrors
// tracking-monitor.integration.test.ts, including the two corrections that
// pattern made to delivery-monitor — `unknown` must not overwrite a verdict,
// and the ops item must be idempotent rather than edge-triggered.
import { describe, it, expect, afterAll } from "vitest";
import { pool } from "../db/pool.js";
import { OpsQueue } from "./ops-queue.js";
import { recordCampaignCta } from "./cta-monitor.js";
import type { CtaSummary } from "../meta/cta-health.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;
const PREFIX = "__it_ctamon_";

async function seed(tag: string) {
  const cust = await pool.query<{ id: string }>(
    `INSERT INTO customers (business_name, is_test) VALUES ($1, true) RETURNING id`, [`${PREFIX}${tag}`],
  );
  const customerId = cust.rows[0].id;
  const conn = await pool.query<{ id: string }>(
    `INSERT INTO meta_connections (customer_id, access_health) VALUES ($1,'ok') RETURNING id`, [customerId],
  );
  const acct = await pool.query<{ id: string }>(
    `INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`,
    [conn.rows[0].id, `act_ctam_${conn.rows[0].id.slice(0, 8)}`],
  );
  const camp = await pool.query<{ id: string }>(
    `INSERT INTO managed_campaigns (customer_id, ad_account_id, meta_campaign_id, name, status)
     VALUES ($1,$2,'m_ctam','C','active') RETURNING id`, [customerId, acct.rows[0].id],
  );
  return { customerId, campaignId: camp.rows[0].id };
}

const broken: CtaSummary = {
  state: "broken", reason: "1 of 2 ad(s) have a WHATSAPP destination with no working button (missing_whatsapp_number)",
  brokenAdIds: ["ad_1"], detail: { adsChecked: 2 },
};
const ok: CtaSummary = { state: "ok", reason: null, brokenAdIds: [], detail: {} };

const flags = async (id: string) =>
  (await pool.query(`SELECT cta_ok, cta_reason, cta_checked_at FROM managed_campaigns WHERE id = $1`, [id])).rows[0];
const openItems = async (id: string) =>
  Number((await pool.query(
    `SELECT count(*)::int n FROM ops_queue_items WHERE campaign_id = $1 AND type = 'campaign_cta_broken' AND status <> 'resolved'`,
    [id],
  )).rows[0].n);

d("recordCampaignCta (DB)", () => {
  afterAll(async () => {
    await pool.query(`DELETE FROM customers WHERE business_name LIKE '${PREFIX}%'`);
    await pool.end();
  });

  it("flags the campaign and raises a high-severity ops item", async () => {
    const { customerId, campaignId } = await seed("broken");
    const ops = new OpsQueue(pool);
    const r = await recordCampaignCta({ pool, ops, campaignId, customerId, summary: broken });

    expect(r.raisedOps).toBe(true);
    const f = await flags(campaignId);
    expect(f.cta_ok).toBe(false);
    expect(f.cta_reason).toMatch(/missing_whatsapp_number/);
    expect(f.cta_checked_at).not.toBeNull();
    expect(await openItems(campaignId)).toBe(1);
  });

  // Idempotent, not edge-triggered: an hourly tick must not create an item per
  // hour, and an edge-based raise loses the alert forever if ops.create throws
  // after the flag write lands.
  it("does not pile up ops items while it stays broken", async () => {
    const { customerId, campaignId } = await seed("repeat");
    const ops = new OpsQueue(pool);
    for (let i = 0; i < 3; i++) await recordCampaignCta({ pool, ops, campaignId, customerId, summary: broken });
    expect(await openItems(campaignId)).toBe(1);
  });

  it("clears the flag when the CTA is fixed", async () => {
    const { customerId, campaignId } = await seed("recover");
    const ops = new OpsQueue(pool);
    await recordCampaignCta({ pool, ops, campaignId, customerId, summary: broken });
    await recordCampaignCta({ pool, ops, campaignId, customerId, summary: ok });
    const f = await flags(campaignId);
    expect(f.cta_ok).toBe(true);
    expect(f.cta_reason).toBeNull();
  });

  // The delivery-monitor bug this pattern exists to avoid: a failed read must
  // never silently clear a real alarm.
  it("unknown records only that we looked — it never overwrites a broken verdict", async () => {
    const { customerId, campaignId } = await seed("unknown");
    const ops = new OpsQueue(pool);
    await recordCampaignCta({ pool, ops, campaignId, customerId, summary: broken });
    const before = await flags(campaignId);

    await recordCampaignCta({
      pool, ops, campaignId, customerId,
      summary: { state: "unknown", reason: "no ads to check", brokenAdIds: [], detail: {} },
    });

    const after = await flags(campaignId);
    expect(after.cta_ok).toBe(false); // still broken
    expect(after.cta_reason).toBe(before.cta_reason);
    expect(new Date(after.cta_checked_at).getTime()).toBeGreaterThanOrEqual(new Date(before.cta_checked_at).getTime());
  });

  // not_applicable IS a settled verdict (an engagement campaign has no
  // destination by design), so unlike unknown it clears a stale broken flag.
  it("not_applicable clears a stale broken flag and records why", async () => {
    const { customerId, campaignId } = await seed("na");
    const ops = new OpsQueue(pool);
    await recordCampaignCta({ pool, ops, campaignId, customerId, summary: broken });
    await recordCampaignCta({
      pool, ops, campaignId, customerId,
      summary: { state: "not_applicable", reason: "no ad set has a click-through destination (engagement or on-platform)", brokenAdIds: [], detail: {} },
    });
    const f = await flags(campaignId);
    expect(f.cta_ok).toBe(true);
    expect(f.cta_reason).toMatch(/engagement/);
  });
});
