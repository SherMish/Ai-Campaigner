// DB + HTTP integration for the customer overview (AIC-22/24). Requires
// DATABASE_URL with migrations applied; self-skips otherwise. Seeds a full
// account→customer→connection→campaign chain and asserts the service output,
// the JWT-scoped /api/app/overview endpoint, and the lead-quality write.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";
import { pool } from "../db/pool.js";
import { createApp } from "../app.js";
import { buildCustomerOverview } from "./customer-overview.js";
import { recordNoRecReason } from "./evaluation-reason.js";
import { signAuthToken } from "../auth/tokens.js";
import { rollingPeriods } from "../meta/scheduled-ingestion.js";
import { PgSnapshotStore } from "../meta/snapshot-store.js";
import type { SnapshotUpsert } from "../meta/insights.js";
import type { RecommendationDraft } from "../recommendations/types.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

const { current, previous } = rollingPeriods();

function snap(campaignId: string, o: Partial<SnapshotUpsert>): SnapshotUpsert {
  return {
    campaignId, grain: "campaign", metaObjectId: "meta_camp_ov", parentMetaId: null,
    creativeName: null, periodStart: current.start, periodEnd: current.end,
    spendAgorot: 0, leads: 0, cplAgorot: null, impressions: 0, linkClicks: 0,
    deliveryStatus: "active", raw: {}, ...o,
  };
}

// Seed a user + linked customer with a managed campaign. Returns ids.
async function seedChain(tag: string, status = "active") {
  const cust = await pool.query<{ id: string }>(
    `INSERT INTO customers (business_name, is_test, onboarding_status, contact_name)
     VALUES ($1, true, 'ready', 'Test Owner') RETURNING id`,
    [`__it_ov_${tag}`],
  );
  const customerId = cust.rows[0].id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO app_users (email, password_hash, name, customer_id)
     VALUES ($1, 'x', 'Owner Name', $2) RETURNING id`,
    [`__it_ov_${tag}@example.com`, customerId],
  );
  const userId = user.rows[0].id;
  const conn = await pool.query<{ id: string }>(
    `INSERT INTO meta_connections (customer_id, system_user_id, access_health, page_id)
     VALUES ($1, '999', 'ok', 'page_it_1') RETURNING id`,
    [customerId],
  );
  const acct = await pool.query<{ id: string }>(
    `INSERT INTO ad_accounts (connection_id, meta_ad_account_id, name)
     VALUES ($1, $2, 'IT Ad Account') RETURNING id`,
    [conn.rows[0].id, `act_ov_${conn.rows[0].id.slice(0, 8)}`],
  );
  const camp = await pool.query<{ id: string }>(
    `INSERT INTO managed_campaigns (customer_id, ad_account_id, name, status, agreed_budget_agorot, budget_period)
     VALUES ($1, $2, 'IT Campaign', $3, 800, 'daily') RETURNING id`,
    [customerId, acct.rows[0].id, status],
  );
  return { customerId, userId, campaignId: camp.rows[0].id };
}

d("customer overview (DB + HTTP)", () => {
  beforeAll(() => {
    process.env.JWT_SECRET ||= "test-secret-overview";
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM app_users WHERE email LIKE '__it_ov_%'`);
    await pool.query(`DELETE FROM customers WHERE business_name LIKE '__it_ov_%'`);
    await pool.end();
  });

  it("assembles the full chain and derives 'ok' when data exists", async () => {
    const { userId, campaignId } = await seedChain("full");
    const store = new PgSnapshotStore(pool);
    await store.upsert([
      snap(campaignId, { spendAgorot: 18000, leads: 6, cplAgorot: 3000 }),
      snap(campaignId, { grain: "creative", metaObjectId: "cr_ov_1", creativeName: "A", spendAgorot: 18000, leads: 6, cplAgorot: 3000 }),
      snap(campaignId, { periodStart: previous.start, periodEnd: previous.end, spendAgorot: 15000, leads: 5, cplAgorot: 3000 }),
    ]);

    const ov = await buildCustomerOverview(pool, userId);
    expect(ov).not.toBeNull();
    expect(ov!.account.email).toBe("__it_ov_full@example.com");
    expect(ov!.customer?.businessName).toBe("__it_ov_full");
    expect(ov!.connection?.adAccount?.name).toBe("IT Ad Account");
    expect(ov!.connection?.accessHealth).toBe("ok");
    expect(ov!.campaign?.agreedBudgetAgorot).toBe(800);
    expect(ov!.readout?.current.leads).toBe(6);
    expect(ov!.readout?.delta.leadsPct).toBe(20);
    expect(ov!.homeState).toBe("ok");

    // Over HTTP, scoped by the caller's JWT.
    const token = signAuthToken(userId);
    const res = await request(createApp())
      .get("/api/app/overview")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.campaign.name).toBe("IT Campaign");
    expect(res.body.homeState).toBe("ok");
  });

  it("derives 'collecting' when the campaign has no snapshots", async () => {
    const { userId } = await seedChain("empty");
    const ov = await buildCustomerOverview(pool, userId);
    expect(ov!.homeState).toBe("collecting");
    expect(ov!.readout?.current.leads).toBe(0);
  });

  it("surfaces a delivery problem as attention (kind = delivery) — AIC-39", async () => {
    const { userId, campaignId } = await seedChain("delivery");
    await pool.query(`UPDATE managed_campaigns SET delivery_ok = false, delivery_reason = 'not delivering' WHERE id = $1`, [campaignId]);
    const ov = await buildCustomerOverview(pool, userId);
    expect(ov!.homeState).toBe("attention");
    expect(ov!.attentionKind).toBe("delivery");
    expect(ov!.campaign?.deliveryOk).toBe(false);
  });

  it("surfaces the engine's no-rec reason (AIC-64)", async () => {
    const { userId, campaignId } = await seedChain("norec");
    const draft: RecommendationDraft = {
      campaignId, type: "no_action", targetMetaId: null,
      evidence: { reason: "budget_below_threshold", detail: { currentBudgetAgorot: 1000, maxWindowSpendAgorot: 7000, requiredSpendAgorot: 15000 } },
      currentBudgetAgorot: null, proposedBudgetAgorot: null, maxSpendImpactAgorot: null, rationale: "test",
    };
    await recordNoRecReason({ pool, campaignId, draft });

    const ov = await buildCustomerOverview(pool, userId);
    expect(ov!.campaign?.noRecReason).toBe("budget_below_threshold");
    expect(ov!.campaign?.noRecDetail).toMatchObject({ maxWindowSpendAgorot: 7000 });

    // An acting draft clears it back to null — nothing to explain once a
    // recommendation exists.
    await recordNoRecReason({
      pool, campaignId,
      draft: { campaignId, type: "decrease_budget", targetMetaId: null, evidence: {}, currentBudgetAgorot: 1000, proposedBudgetAgorot: 800, maxSpendImpactAgorot: -200, rationale: "test" },
    });
    const ov2 = await buildCustomerOverview(pool, userId);
    expect(ov2!.campaign?.noRecReason).toBeNull();
  });

  it("rejects the overview without a token", async () => {
    const res = await request(createApp()).get("/api/app/overview");
    expect(res.status).toBe(401);
  });

  it("saves lead-quality feedback for the caller's campaign", async () => {
    const { userId, campaignId } = await seedChain("lq");
    const token = signAuthToken(userId);
    const ok = await request(createApp())
      .post("/api/app/lead-quality")
      .set("Authorization", `Bearer ${token}`)
      .send({ leadsReported: 10, relevantCount: 4 });
    expect(ok.status).toBe(200);

    const row = await pool.query(
      `SELECT leads_reported, relevant_count FROM lead_quality_feedback WHERE campaign_id = $1`,
      [campaignId],
    );
    expect(row.rows[0]).toMatchObject({ leads_reported: 10, relevant_count: 4 });

    // relevant > reported is nonsense → 400.
    const bad = await request(createApp())
      .post("/api/app/lead-quality")
      .set("Authorization", `Bearer ${token}`)
      .send({ leadsReported: 3, relevantCount: 9 });
    expect(bad.status).toBe(400);
  });
});
