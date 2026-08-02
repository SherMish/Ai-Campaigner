// DB integration for the idempotent write outbox (AIC-13). Requires DATABASE_URL;
// self-skips otherwise. Proves enqueue idempotency, exactly-once drain, and
// backoff-on-failure.
import { describe, it, expect, afterAll } from "vitest";
import { pool } from "../db/pool.js";
import { WriteOutbox, FakeMetaWriter, outboxKey } from "./write-outbox.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

async function makeCampaign(): Promise<{ campaignId: string; customerId: string }> {
  const cust = await pool.query<{ id: string }>(`INSERT INTO customers (business_name) VALUES ('__it_outbox') RETURNING id`);
  const customerId = cust.rows[0].id;
  const conn = await pool.query<{ id: string }>(`INSERT INTO meta_connections (customer_id) VALUES ($1) RETURNING id`, [customerId]);
  const acct = await pool.query<{ id: string }>(`INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`, [conn.rows[0].id, `act_ob_${conn.rows[0].id.slice(0, 8)}`]);
  const camp = await pool.query<{ id: string }>(`INSERT INTO managed_campaigns (customer_id, ad_account_id) VALUES ($1,$2) RETURNING id`, [customerId, acct.rows[0].id]);
  return { campaignId: camp.rows[0].id, customerId };
}

d("WriteOutbox (DB)", () => {
  afterAll(async () => { await pool.end(); });

  it("enqueue is idempotent on the key (a repeat is a no-op)", async () => {
    const { campaignId, customerId } = await makeCampaign();
    const outbox = new WriteOutbox(pool);
    const key = outboxKey("rec-1", "set_daily_budget", campaignId);
    const entry = { idempotencyKey: key, campaignId, recommendationId: null, kind: "set_daily_budget" as const, payload: { agorot: 8000 } };

    expect(await outbox.enqueue(entry)).toBe(true);
    expect(await outbox.enqueue(entry)).toBe(false); // duplicate → no-op

    const { rows } = await pool.query<{ count: string }>(`SELECT count(*) FROM meta_write_outbox WHERE idempotency_key = $1`, [key]);
    expect(Number(rows[0].count)).toBe(1);
    await pool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  });

  it("drains a row exactly once; a second drain does not re-apply", async () => {
    const { campaignId, customerId } = await makeCampaign();
    const outbox = new WriteOutbox(pool);
    await outbox.enqueue({ idempotencyKey: outboxKey("rec-2", "pause_ad", "ad_9"), campaignId, recommendationId: null, kind: "pause_ad", payload: { adId: "ad_9" } });

    const writer = new FakeMetaWriter();
    const first = await outbox.drainOnce(writer);
    const second = await outbox.drainOnce(writer);

    expect(first.succeeded).toBe(1);
    expect(second.drained).toBe(0); // succeeded row is terminal
    expect(writer.applied).toHaveLength(1); // applied exactly once
    await pool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  });

  it("backs off and retries a failed write, then succeeds", async () => {
    const { campaignId, customerId } = await makeCampaign();
    const outbox = new WriteOutbox(pool);
    await outbox.enqueue({ idempotencyKey: outboxKey("rec-3", "pause_ad", "ad_x"), campaignId, recommendationId: null, kind: "pause_ad", payload: { adId: "ad_x" } });

    const writer = new FakeMetaWriter();
    writer.failTimes = 1;
    const first = await outbox.drainOnce(writer);
    expect(first.failed).toBe(1);

    // Move next_attempt_at into the past so the retry is eligible now.
    await pool.query(`UPDATE meta_write_outbox SET next_attempt_at = now() - interval '1 minute' WHERE campaign_id = $1`, [campaignId]);
    const second = await outbox.drainOnce(writer);
    expect(second.succeeded).toBe(1);
    expect(writer.applied).toHaveLength(1);
    await pool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  });
});
