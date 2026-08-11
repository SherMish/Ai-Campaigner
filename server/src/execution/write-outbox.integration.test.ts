// DB integration for the idempotent write outbox (AIC-13). Requires DATABASE_URL;
// self-skips otherwise. Proves enqueue idempotency, exactly-once drain, and
// backoff-on-failure.
import { describe, it, expect, afterAll } from "vitest";
import { pool } from "../db/pool.js";
import { WriteOutbox, FakeMetaWriter, outboxKey, builderKey, type CreatingWriter, type WriteKind } from "./write-outbox.js";

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

  // applyIdempotent (AIC-50): the builder's synchronous create-write path.
  class CountingCreatingWriter implements CreatingWriter {
    public calls = 0;
    public failNext = 0;
    async create(_kind: WriteKind, _payload: Record<string, unknown>): Promise<{ metaId: string }> {
      this.calls++;
      if (this.failNext > 0) { this.failNext--; throw new Error("simulated create failure"); }
      return { metaId: `meta_${this.calls}` };
    }
  }

  it("applyIdempotent creates once, then resumes from the remembered result on a repeat call (no second Meta call)", async () => {
    const { campaignId, customerId } = await makeCampaign();
    const outbox = new WriteOutbox(pool);
    const writer = new CountingCreatingWriter();
    const entry = { idempotencyKey: builderKey(campaignId, "create_campaign", "campaign"), campaignId, recommendationId: null, kind: "create_campaign" as const, payload: { name: "x" } };

    const first = await outbox.applyIdempotent(entry, writer);
    const second = await outbox.applyIdempotent(entry, writer); // simulates a retry/resume

    expect(second).toBe(first); // same real Meta id both times
    expect(writer.calls).toBe(1); // Meta was only ever called once — no duplicate object
    await pool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  });

  it("applyIdempotent surfaces a failure and a retry (after the failure) succeeds and is remembered", async () => {
    const { campaignId, customerId } = await makeCampaign();
    const outbox = new WriteOutbox(pool);
    const writer = new CountingCreatingWriter();
    writer.failNext = 1;
    const entry = { idempotencyKey: builderKey(campaignId, "create_ad_set", "adset-1"), campaignId, recommendationId: null, kind: "create_ad_set" as const, payload: {} };

    await expect(outbox.applyIdempotent(entry, writer)).rejects.toThrow("simulated create failure");
    const resumed = await outbox.applyIdempotent(entry, writer); // the customer/builder resubmits
    expect(resumed).toBe("meta_2"); // second attempt succeeded
    expect(writer.calls).toBe(2); // one failed + one succeeded — never more
    await pool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  });

  it("a concurrent double-submit never calls Meta twice — the loser backs off instead of racing", async () => {
    const { campaignId, customerId } = await makeCampaign();
    const outbox = new WriteOutbox(pool);
    const writer = new CountingCreatingWriter();
    const entry = { idempotencyKey: builderKey(campaignId, "create_ad", "adset-1-ad-1"), campaignId, recommendationId: null, kind: "create_ad" as const, payload: {} };

    // Enqueue first (simulating the first request having already claimed the
    // row), then a "concurrent" second attempt must see it as in-flight.
    await outbox.enqueue(entry);
    await pool.query(`UPDATE meta_write_outbox SET status = 'in_progress' WHERE idempotency_key = $1`, [entry.idempotencyKey]);

    await expect(outbox.applyIdempotent(entry, writer)).rejects.toThrow(/already in progress/);
    expect(writer.calls).toBe(0); // never called Meta while another attempt owns the row
    await pool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  });
});
