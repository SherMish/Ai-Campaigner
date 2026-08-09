// DB + HTTP integration for recommendations oversight (AIC-46). Requires
// DATABASE_URL; self-skips otherwise.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";
import { pool } from "../db/pool.js";
import { createApp } from "../app.js";
import { signAuthToken } from "../auth/tokens.js";
import { listRecommendationsForAdmin, flagRecommendation, unflagRecommendation } from "./recommendation-oversight.js";
import { listAuditLog } from "./admin-audit.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;
const ACTOR = { userId: null, label: "__it_operator" };

async function seedCampaign(tag: string): Promise<{ customerId: string; campaignId: string }> {
  const cust = await pool.query<{ id: string }>(`INSERT INTO customers (business_name) VALUES ($1) RETURNING id`, [`__it_oversight_${tag}`]);
  const customerId = cust.rows[0].id;
  const conn = await pool.query<{ id: string }>(`INSERT INTO meta_connections (customer_id, access_health) VALUES ($1,'ok') RETURNING id`, [customerId]);
  const acct = await pool.query<{ id: string }>(`INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`, [conn.rows[0].id, `act_ov_${conn.rows[0].id.slice(0, 8)}`]);
  const camp = await pool.query<{ id: string }>(
    `INSERT INTO managed_campaigns (customer_id, ad_account_id, name, status) VALUES ($1,$2,$3,'active') RETURNING id`,
    [customerId, acct.rows[0].id, `camp_${tag}`],
  );
  return { customerId, campaignId: camp.rows[0].id };
}

async function seedRec(campaignId: string, opts: { type?: string; state?: string; evidence?: object } = {}): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO recommendations (campaign_id, type, state, evidence, rationale, max_spend_impact_agorot)
     VALUES ($1,$2,$3,$4,'because the numbers say so',500) RETURNING id`,
    [campaignId, opts.type ?? "decrease_budget", opts.state ?? "proposed", JSON.stringify(opts.evidence ?? { spendAgorot: 5000, leads: 1 })],
  );
  return r.rows[0].id;
}

d("recommendations oversight (DB + HTTP)", () => {
  beforeAll(() => { process.env.JWT_SECRET ||= "test-secret-oversight"; delete process.env.ADMIN_TOKEN; });
  afterAll(async () => {
    await pool.query(`DELETE FROM customers WHERE business_name LIKE '__it_oversight_%'`);
    await pool.query(`DELETE FROM admin_audit_log WHERE entity_label LIKE '__it_oversight_%'`);
    await pool.end();
  });

  it("lists recommendations across customers with the joined customer/campaign context", async () => {
    const { customerId, campaignId } = await seedCampaign("list");
    const recId = await seedRec(campaignId, { type: "increase_budget", state: "proposed" });

    const rows = await listRecommendationsForAdmin(pool);
    const row = rows.find((r) => r.id === recId)!;
    expect(row.customerId).toBe(customerId);
    expect(row.businessName).toBe("__it_oversight_list");
    expect(row.type).toBe("increase_budget");
    expect(row.state).toBe("proposed");
    expect(row.evidence).toEqual({ spendAgorot: 5000, leads: 1 });
    expect(row.flaggedForReview).toBe(false);
  });

  it("filters by state, type, and customer", async () => {
    const a = await seedCampaign("filterA");
    const b = await seedCampaign("filterB");
    const proposedRec = await seedRec(a.campaignId, { type: "pause_creative", state: "proposed" });
    await seedRec(a.campaignId, { type: "increase_budget", state: "executed" });
    await seedRec(b.campaignId, { type: "pause_creative", state: "proposed" });

    const byState = await listRecommendationsForAdmin(pool, { state: "executed" });
    expect(byState.some((r) => r.state !== "executed")).toBe(false);

    const byCustomer = await listRecommendationsForAdmin(pool, { customerId: a.customerId });
    expect(byCustomer.every((r) => r.customerId === a.customerId)).toBe(true);
    expect(byCustomer.some((r) => r.id === proposedRec)).toBe(true);

    const byType = await listRecommendationsForAdmin(pool, { type: "pause_creative", customerId: a.customerId });
    expect(byType).toHaveLength(1);
    expect(byType[0].id).toBe(proposedRec);
  });

  it("surfaces the linked action-history row and outcome for an executed rec", async () => {
    const { campaignId } = await seedCampaign("history");
    const recId = await seedRec(campaignId, { type: "decrease_budget", state: "executed" });
    const ah = await pool.query<{ id: string }>(
      `INSERT INTO action_history (campaign_id, recommendation_id, what, action_type, result)
       VALUES ($1,$2,'lowered the budget','decrease_budget','success') RETURNING id`,
      [campaignId, recId],
    );

    const rows = await listRecommendationsForAdmin(pool);
    const row = rows.find((r) => r.id === recId)!;
    expect(row.actionHistoryId).toBe(ah.rows[0].id);
    expect(row.executionResult).toBe("success");
  });

  it("surfaces a failed rec (consistent with the needs-attention queue)", async () => {
    const { campaignId } = await seedCampaign("failed");
    const recId = await seedRec(campaignId, { type: "pause_adset", state: "failed" });
    const rows = await listRecommendationsForAdmin(pool, { state: "failed" });
    expect(rows.some((r) => r.id === recId)).toBe(true);
  });

  it("flags a recommendation for review, logs it, and unflag reverses it", async () => {
    const { campaignId } = await seedCampaign("flag");
    const recId = await seedRec(campaignId);

    const flagged = await flagRecommendation(pool, ACTOR, recId, "looks off — thin data");
    expect(flagged.ok).toBe(true);
    let rows = await listRecommendationsForAdmin(pool);
    let row = rows.find((r) => r.id === recId)!;
    expect(row.flaggedForReview).toBe(true);
    expect(row.flagNote).toBe("looks off — thin data");

    const audit = await listAuditLog(pool, { entityId: recId });
    expect(audit[0].action).toBe("recommendation.flag");

    const unflagged = await unflagRecommendation(pool, ACTOR, recId);
    expect(unflagged.ok).toBe(true);
    rows = await listRecommendationsForAdmin(pool);
    row = rows.find((r) => r.id === recId)!;
    expect(row.flaggedForReview).toBe(false);
    expect(row.flagNote).toBeNull();
  });

  it("404s flagging a recommendation that doesn't exist", async () => {
    const r = await flagRecommendation(pool, ACTOR, "00000000-0000-0000-0000-000000000000", "");
    expect(r.ok).toBe(false);
  });

  it("full HTTP round trip: list, filter, flag, unflag, attributed to a real admin actor", async () => {
    const admin = await pool.query<{ id: string }>(
      `INSERT INTO app_users (email, password_hash, name, is_admin) VALUES ('__it_oversight_admin@example.com','x','Op',true) RETURNING id`,
    );
    const auth = `Bearer ${signAuthToken(admin.rows[0].id)}`;
    const app = createApp();
    const { campaignId } = await seedCampaign("http");
    const recId = await seedRec(campaignId, { type: "replace_creative" });

    const list = await request(app).get("/api/admin/recommendations?type=replace_creative").set("Authorization", auth);
    expect(list.status).toBe(200);
    expect(list.body.recommendations.some((r: { id: string }) => r.id === recId)).toBe(true);

    const flag = await request(app).post(`/api/admin/recommendations/${recId}/flag`).set("Authorization", auth).send({ note: "double check" });
    expect(flag.status).toBe(200);

    const unflag = await request(app).post(`/api/admin/recommendations/${recId}/unflag`).set("Authorization", auth).send({});
    expect(unflag.status).toBe(200);

    await pool.query(`DELETE FROM app_users WHERE email = '__it_oversight_admin@example.com'`);
  });

  it("rejects the routes without an admin credential", async () => {
    const res = await request(createApp()).get("/api/admin/recommendations");
    expect(res.status).toBe(401);
  });
});
