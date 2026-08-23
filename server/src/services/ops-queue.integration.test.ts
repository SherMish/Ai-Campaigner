// DB integration for the needs-attention queue (AIC-17). Requires DATABASE_URL.
import { describe, it, expect, afterAll } from "vitest";
import { pool } from "../db/pool.js";
import { OpsQueue } from "./ops-queue.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

d("OpsQueue (DB)", () => {
  afterAll(async () => {      // Safety net, added 2026-08-22. Cleanup used to live on the LAST LINE of
      // each test body, so any test that threw first leaked its customer row
      // permanently. That is not hypothetical: the failing drain-once test in
      // this suite leaked one row EVERY run, which is how 30 `__it_outbox`
      // customers accumulated in the shared production database — showing up
      // in the ops console as real customers, and feeding the unscoped drain
      // that poisoned a live customer's build.
      //
      // afterAll runs regardless of test outcome, so this cannot leak again.
      // Scoped to THIS file's own prefixes: suites run in parallel, and a
      // broader LIKE would delete a concurrently-running suite's rows.
      await pool.query(`DELETE FROM customers WHERE business_name LIKE ANY($1::text[])`, [["__it_ops%"]]);
 await pool.end(); });

  // AIC-121, reported live: the operator-facing queue showed severity + type +
  // raw detail text, but never WHICH customer or campaign an item is about —
  // unusable when several near-identical items (repeated connection-health
  // transitions on the same account) sit side by side with no way to tell
  // them apart at a glance. list() now joins the human names in, the same
  // shape the notification relay already does for Telegram (AIC-118).
  it("carries the customer's business name and the campaign's name, null when there is none", async () => {
    const cust = await pool.query<{ id: string }>(`INSERT INTO customers (business_name) VALUES ('__it_ops_names') RETURNING id`);
    const customerId = cust.rows[0].id;
    const conn = await pool.query<{ id: string }>(`INSERT INTO meta_connections (customer_id) VALUES ($1) RETURNING id`, [customerId]);
    const acct = await pool.query<{ id: string }>(
      `INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`,
      [conn.rows[0].id, `act_opsq_${conn.rows[0].id.slice(0, 8)}`],
    );
    const camp = await pool.query<{ id: string }>(
      `INSERT INTO managed_campaigns (customer_id, ad_account_id, meta_campaign_id, name, status)
       VALUES ($1,$2,'m_opsq','__it_opsq campaign','active') RETURNING id`,
      [customerId, acct.rows[0].id],
    );
    const q = new OpsQueue(pool);

    const withCampaign = await q.create({
      customerId, campaignId: camp.rows[0].id, type: "campaign_not_delivering", severity: "high", detail: "no ad set delivering",
    });
    const withoutCampaign = await q.create({ customerId, type: "support_request", severity: "low", detail: "question" });

    const list = await q.list();
    const a = list.find((i) => i.id === withCampaign.id)!;
    const b = list.find((i) => i.id === withoutCampaign.id)!;
    expect(a.businessName).toBe("__it_ops_names");
    expect(a.campaignName).toBe("__it_opsq campaign");
    expect(b.businessName).toBe("__it_ops_names");
    expect(b.campaignName).toBeNull();

    await pool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  });

  it("creates from each trigger, sorts high-severity first, and triages", async () => {
    const cust = await pool.query<{ id: string }>(`INSERT INTO customers (business_name) VALUES ('__it_ops') RETURNING id`);
    const customerId = cust.rows[0].id;
    const q = new OpsQueue(pool);

    const low = await q.create({ customerId, type: "support_request", severity: "low", detail: "question" });
    const high = await q.create({ customerId, type: "meta_connection_failure", severity: "high", detail: "access lost" });
    await q.create({ customerId, type: "campaign_rejected", severity: "medium", detail: "rejected" });

    const list = (await q.list()).filter((i) => i.customerId === customerId);
    expect(list[0].severity).toBe("high"); // high first
    expect(list.map((i) => i.severity)).toEqual(["high", "medium", "low"]);

    // Claim → in_progress + claimed_by.
    const claimed = await q.claim(high.id, "liam");
    expect(claimed?.status).toBe("in_progress");
    expect(claimed?.claimedBy).toBe("liam");

    // Resolve → resolved + note, falls out of the default list.
    await q.resolve(low.id, "answered on WhatsApp");
    const afterResolve = (await q.list()).filter((i) => i.customerId === customerId);
    expect(afterResolve.some((i) => i.id === low.id)).toBe(false);
    const withResolved = (await q.list({ includeResolved: true })).filter((i) => i.customerId === customerId);
    expect(withResolved.find((i) => i.id === low.id)?.resolutionNote).toBe("answered on WhatsApp");

    await pool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  });
});
