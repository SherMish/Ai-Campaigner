// DB + HTTP integration for the customer recommendations surface (AIC-23).
// Requires DATABASE_URL; self-skips otherwise. The full approve→execute pipeline
// against live Meta is covered by safe-executor.test.ts (fakes) + the AIC-1
// write-test (live); here we cover the customer wrapper: listing, ownership,
// dismiss transitions, and the no-token "unavailable" branch.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";
import { pool } from "../db/pool.js";
import { createApp } from "../app.js";
import { signAuthToken } from "../auth/tokens.js";
import { PgRecommendationStore } from "../recommendations/recommendation-store.js";
import {
  listCustomerRecommendations,
  getCustomerRecommendation,
  approveCustomerRecommendation,
  dismissCustomerRecommendation,
} from "./customer-recommendations.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

async function seedChain(tag: string) {
  const cust = await pool.query<{ id: string }>(
    `INSERT INTO customers (business_name, is_test, onboarding_status) VALUES ($1, true, 'ready') RETURNING id`,
    [`__it_rec_${tag}`],
  );
  const customerId = cust.rows[0].id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO app_users (email, password_hash, name, customer_id) VALUES ($1,'x','Owner',$2) RETURNING id`,
    [`__it_rec_${tag}@example.com`, customerId],
  );
  const conn = await pool.query<{ id: string }>(
    `INSERT INTO meta_connections (customer_id, system_user_id, access_health) VALUES ($1,'9','ok') RETURNING id`,
    [customerId],
  );
  const acct = await pool.query<{ id: string }>(
    `INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`,
    [conn.rows[0].id, `act_rec_${conn.rows[0].id.slice(0, 8)}`],
  );
  const camp = await pool.query<{ id: string }>(
    `INSERT INTO managed_campaigns (customer_id, ad_account_id, meta_campaign_id, name, status, agreed_budget_agorot)
     VALUES ($1,$2,'meta_rec_1','IT Campaign','active',10000) RETURNING id`,
    [customerId, acct.rows[0].id],
  );
  return { customerId, userId: user.rows[0].id, campaignId: camp.rows[0].id };
}

async function seedRec(campaignId: string) {
  const store = new PgRecommendationStore(pool);
  return store.create(
    {
      campaignId, type: "increase_budget", targetMetaId: "meta_rec_1",
      evidence: { note: "it" }, currentBudgetAgorot: 7000, proposedBudgetAgorot: 8000,
      maxSpendImpactAgorot: 1000, rationale: "cpl below target",
    },
    null,
  );
}

d("customer recommendations (DB + HTTP)", () => {
  beforeAll(() => {
    process.env.JWT_SECRET ||= "test-secret-recs";
    delete process.env.META_SYSTEM_USER_TOKEN; // force the "unavailable" branch
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM app_users WHERE email LIKE '__it_rec_%'`);
    await pool.query(`DELETE FROM customers WHERE business_name LIKE '__it_rec_%'`);
    await pool.end();
  });

  it("lists a pending rec with the deterministic explanation + figures", async () => {
    const { userId, campaignId } = await seedChain("list");
    await seedRec(campaignId);
    const list = await listCustomerRecommendations(pool, userId);
    expect(list.campaignId).toBe(campaignId);
    expect(list.pending).toHaveLength(1);
    expect(list.pending[0].type).toBe("increase_budget");
    expect(list.pending[0].currentBudgetAgorot).toBe(7000);
    expect(list.pending[0].proposedBudgetAgorot).toBe(8000);
    // explanation carries the exact shekel figures (number fidelity).
    expect(list.pending[0].explanation).toContain("₪70");
    expect(list.pending[0].explanation).toContain("₪80");

    const token = signAuthToken(userId);
    const res = await request(createApp()).get("/api/app/recommendations").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.pending).toHaveLength(1);
  });

  it("scopes a rec to its owner (no cross-customer read)", async () => {
    const owner = await seedChain("own");
    const other = await seedChain("other");
    const rec = await seedRec(owner.campaignId);
    expect(await getCustomerRecommendation(pool, owner.userId, rec.id)).not.toBeNull();
    expect(await getCustomerRecommendation(pool, other.userId, rec.id)).toBeNull();

    // approve from a non-owner is a not_found, and leaves the rec proposed.
    const approve = await approveCustomerRecommendation(pool, other.userId, rec.id);
    expect(approve.status).toBe("not_found");
    expect((await new PgRecommendationStore(pool).getById(rec.id))!.state).toBe("proposed");
  });

  it("dismiss moves proposed → dismissed; second dismiss is not_pending", async () => {
    const { userId, campaignId } = await seedChain("dismiss");
    const rec = await seedRec(campaignId);
    expect(await dismissCustomerRecommendation(pool, userId, rec.id)).toBe("done");
    expect((await new PgRecommendationStore(pool).getById(rec.id))!.state).toBe("dismissed");
    expect(await dismissCustomerRecommendation(pool, userId, rec.id)).toBe("not_pending");
  });

  it("approve without a Meta token reports 'unavailable' and does not touch the rec", async () => {
    const { userId, campaignId } = await seedChain("unavail");
    const rec = await seedRec(campaignId);
    const r = await approveCustomerRecommendation(pool, userId, rec.id);
    expect(r.status).toBe("unavailable");
    expect((await new PgRecommendationStore(pool).getById(rec.id))!.state).toBe("proposed");

    const token = signAuthToken(userId);
    const http = await request(createApp())
      .post(`/api/app/recommendations/${rec.id}/approve`)
      .set("Authorization", `Bearer ${token}`);
    expect(http.status).toBe(503);
  });

  it("rejects the list without a token", async () => {
    const res = await request(createApp()).get("/api/app/recommendations");
    expect(res.status).toBe(401);
  });
});
