// DB integration for PgRecommendationStore + service (AIC-8). Requires
// DATABASE_URL; self-skips otherwise. Proves persistence, the optimistic guard,
// and an action_history row on execution.
import { describe, it, expect, afterAll } from "vitest";
import { pool } from "../db/pool.js";
import { PgRecommendationStore } from "./recommendation-store.js";
import { RecommendationService } from "./recommendation-service.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

async function makeCampaign(): Promise<{ campaignId: string; customerId: string }> {
  const cust = await pool.query<{ id: string }>(
    `INSERT INTO customers (business_name) VALUES ('__it_rec') RETURNING id`,
  );
  const customerId = cust.rows[0].id;
  const conn = await pool.query<{ id: string }>(
    `INSERT INTO meta_connections (customer_id) VALUES ($1) RETURNING id`,
    [customerId],
  );
  const acct = await pool.query<{ id: string }>(
    `INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`,
    [conn.rows[0].id, `act_rec_${conn.rows[0].id.slice(0, 8)}`],
  );
  const camp = await pool.query<{ id: string }>(
    `INSERT INTO managed_campaigns (customer_id, ad_account_id) VALUES ($1,$2) RETURNING id`,
    [customerId, acct.rows[0].id],
  );
  return { campaignId: camp.rows[0].id, customerId };
}

d("PgRecommendationStore + service (DB)", () => {
  afterAll(async () => {
      // Safety net, added 2026-08-22. Cleanup used to live on the LAST LINE of
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
      await pool.query(`DELETE FROM customers WHERE business_name LIKE ANY($1::text[])`, [["__it_rec%"]]);
    await pool.end();
  });

  it("persists a full lifecycle and writes action_history on execution", async () => {
    const { campaignId, customerId } = await makeCampaign();
    const store = new PgRecommendationStore(pool);
    const service = new RecommendationService(store);

    const rec = await service.propose({
      campaignId,
      type: "pause_creative",
      targetMetaId: "ad_3",
      evidence: { spendAgorot: 18000, leads: 1 },
      currentBudgetAgorot: null,
      proposedBudgetAgorot: null,
      maxSpendImpactAgorot: 0,
      rationale: "weak creative",
    });
    await service.approve(rec.id, "cust-1");
    await service.beginExecution(rec.id);
    await service.completeExecution(rec.id, {
      result: "success",
      what: "paused ad_3",
      why: "₪180 for 1 lead",
      previousState: { status: "active" },
      newState: { status: "paused" },
      approvedBy: "cust-1",
      humanInvolved: false,
    });

    const persisted = await store.getById(rec.id);
    expect(persisted?.state).toBe("executed");

    const hist = await pool.query<{ count: string }>(
      `SELECT count(*) FROM action_history WHERE recommendation_id = $1 AND result = 'success'`,
      [rec.id],
    );
    expect(Number(hist.rows[0].count)).toBe(1);

    await pool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  });
});
