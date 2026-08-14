// DB integration for tracking-health persistence + ops raising (AIC-88).
// Requires DATABASE_URL; self-skips otherwise. Modeled on
// delivery-monitor.integration.test.ts, plus the two behaviours that
// deliberately DIVERGE from that older pattern (unknown, and idempotent ops).
import { describe, it, expect, afterAll } from "vitest";
import { pool } from "../db/pool.js";
import { OpsQueue } from "./ops-queue.js";
import { recordCampaignTracking } from "./tracking-monitor.js";
import type { TrackingSummary } from "../meta/tracking-health.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

async function seed(tag: string): Promise<{ customerId: string; campaignId: string }> {
  const cust = await pool.query<{ id: string }>(
    `INSERT INTO customers (business_name, is_test) VALUES ($1, true) RETURNING id`,
    [`__it_trk_${tag}`],
  );
  const customerId = cust.rows[0].id;
  const conn = await pool.query<{ id: string }>(
    `INSERT INTO meta_connections (customer_id, system_user_id, access_health) VALUES ($1,'9','ok') RETURNING id`,
    [customerId],
  );
  const acct = await pool.query<{ id: string }>(
    `INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`,
    [conn.rows[0].id, `act_trk_${conn.rows[0].id.slice(0, 8)}`],
  );
  const camp = await pool.query<{ id: string }>(
    `INSERT INTO managed_campaigns (customer_id, ad_account_id, meta_campaign_id, name, status, agreed_budget_agorot)
     VALUES ($1,$2,'m','C','active',1000) RETURNING id`,
    [customerId, acct.rows[0].id],
  );
  return { customerId, campaignId: camp.rows[0].id };
}

const broken = (): TrackingSummary => ({
  state: "broken",
  reason: "ad set(s) optimize for offsite_conversion.fb_pixel_complete_registration, which the campaign's lead definition does not count",
  detail: { declaredLeadEventTypes: ["onsite_conversion.messaging_conversation_started"], mismatchedAdSets: [{ adSetId: "as_1" }] },
});
const ok = (): TrackingSummary => ({ state: "ok", reason: null, detail: {} });
const unknown = (): TrackingSummary => ({ state: "unknown", reason: "no ad sets readable", detail: {} });

async function row(campaignId: string) {
  const r = await pool.query<{ tracking_ok: boolean | null; tracking_reason: string | null; tracking_detail: unknown; tracking_checked_at: Date | null }>(
    `SELECT tracking_ok, tracking_reason, tracking_detail, tracking_checked_at FROM managed_campaigns WHERE id = $1`,
    [campaignId],
  );
  return r.rows[0];
}
async function openItems(campaignId: string): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM ops_queue_items WHERE campaign_id = $1 AND type = 'campaign_tracking_broken' AND status <> 'resolved'`,
    [campaignId],
  );
  return Number(r.rows[0].n);
}

d("recordCampaignTracking (DB)", () => {
  afterAll(async () => {
    await pool.query(`DELETE FROM customers WHERE business_name LIKE '__it_trk_%'`);
    await pool.end();
  });

  it("persists a broken verdict and raises exactly one ops item", async () => {
    const { customerId, campaignId } = await seed("basic");
    const ops = new OpsQueue(pool);
    const res = await recordCampaignTracking({ pool, ops, campaignId, customerId, summary: broken() });

    expect(res.raisedOps).toBe(true);
    const r = await row(campaignId);
    expect(r.tracking_ok).toBe(false);
    expect(r.tracking_reason).toContain("fb_pixel_complete_registration");
    expect(r.tracking_detail).toMatchObject({ mismatchedAdSets: [{ adSetId: "as_1" }] });
    expect(r.tracking_checked_at).not.toBeNull();
    expect(await openItems(campaignId)).toBe(1);
  });

  // The delivery-monitor's edge-based trigger raises on ok→broken only. This
  // one keys off an OPEN item instead, so a still-broken campaign never spams
  // the queue AND an alert is never permanently lost if a previous create threw.
  it("stays at one open ops item across repeated broken ticks", async () => {
    const { customerId, campaignId } = await seed("repeat");
    const ops = new OpsQueue(pool);
    await recordCampaignTracking({ pool, ops, campaignId, customerId, summary: broken() });
    const second = await recordCampaignTracking({ pool, ops, campaignId, customerId, summary: broken() });
    const third = await recordCampaignTracking({ pool, ops, campaignId, customerId, summary: broken() });

    expect(second.raisedOps).toBe(false);
    expect(third.raisedOps).toBe(false);
    expect(await openItems(campaignId)).toBe(1);
  });

  // The failure the edge-based pattern cannot recover from: the flag is
  // already false, so "did it just flip" is false forever after. Keying off an
  // open item means a resolved-but-still-broken campaign re-alerts correctly.
  it("re-raises after an operator resolves the item while the problem persists", async () => {
    const { customerId, campaignId } = await seed("reraise");
    const ops = new OpsQueue(pool);
    await recordCampaignTracking({ pool, ops, campaignId, customerId, summary: broken() });
    await pool.query(`UPDATE ops_queue_items SET status = 'resolved' WHERE campaign_id = $1`, [campaignId]);

    const again = await recordCampaignTracking({ pool, ops, campaignId, customerId, summary: broken() });
    expect(again.raisedOps).toBe(true);
    expect(await openItems(campaignId)).toBe(1);
  });

  it("recovers to ok and clears the reason", async () => {
    const { customerId, campaignId } = await seed("recover");
    const ops = new OpsQueue(pool);
    await recordCampaignTracking({ pool, ops, campaignId, customerId, summary: broken() });
    const res = await recordCampaignTracking({ pool, ops, campaignId, customerId, summary: ok() });

    expect(res.raisedOps).toBe(false);
    const r = await row(campaignId);
    expect(r.tracking_ok).toBe(true);
    expect(r.tracking_reason).toBeNull();
    expect(r.tracking_detail).toBeNull();
  });

  // THE KEY DIVERGENCE: `unknown` must never overwrite a real verdict. The
  // delivery-monitor writes its flag unconditionally, so a failed read there
  // silently clears a live alarm. This one only advances checked_at.
  it("an unknown verdict NEVER clears a real prior 'broken'", async () => {
    const { customerId, campaignId } = await seed("unknown");
    const ops = new OpsQueue(pool);
    await recordCampaignTracking({ pool, ops, campaignId, customerId, summary: broken() });
    const before = await row(campaignId);

    const res = await recordCampaignTracking({ pool, ops, campaignId, customerId, summary: unknown() });

    expect(res.raisedOps).toBe(false);
    const after = await row(campaignId);
    expect(after.tracking_ok).toBe(false); // still broken, NOT silently "fine"
    expect(after.tracking_reason).toBe(before.tracking_reason);
    expect(after.tracking_checked_at!.getTime()).toBeGreaterThanOrEqual(before.tracking_checked_at!.getTime());
  });

  it("an unknown verdict on a never-checked campaign leaves the default alone", async () => {
    const { customerId, campaignId } = await seed("unknownfresh");
    const ops = new OpsQueue(pool);
    await recordCampaignTracking({ pool, ops, campaignId, customerId, summary: unknown() });

    const r = await row(campaignId);
    expect(r.tracking_ok).toBe(true); // the column default — never flagged on a failed read
    expect(r.tracking_checked_at).not.toBeNull(); // but we DID look
    expect(await openItems(campaignId)).toBe(0);
  });
});
