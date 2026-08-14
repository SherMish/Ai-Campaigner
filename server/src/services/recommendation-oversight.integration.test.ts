// DB + HTTP integration for recommendations oversight (AIC-46). Requires
// DATABASE_URL; self-skips otherwise.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";
import { pool } from "../db/pool.js";
import { createApp } from "../app.js";
import { signAuthToken } from "../auth/tokens.js";
import { listRecommendationsForAdmin, flagRecommendation, unflagRecommendation, getOutcomeAggregate } from "./recommendation-oversight.js";
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

// AIC-76: seed a minimal outcome row directly (bypassing measureOne — that
// path is exercised end-to-end by outcome-measurement.integration.test.ts;
// here we only need a row to exist so the oversight JOIN has something real
// to read back).
async function seedOutcome(
  recId: string,
  campaignId: string,
  opts: { verdict?: string; beforeStart?: string; afterEnd?: string; confoundDetail?: object } = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO recommendation_outcomes
       (recommendation_id, campaign_id, before_start, before_end, after_start, after_end,
        before_features, after_features, delta, verdict, confound_detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      recId,
      campaignId,
      opts.beforeStart ?? "2026-08-03",
      "2026-08-09",
      "2026-08-11",
      opts.afterEnd ?? "2026-08-17",
      JSON.stringify({ spendAgorot: 28000, leads: 7, cplAgorot: 4000, daysActive: 7 }),
      JSON.stringify({ spendAgorot: 21000, leads: 7, cplAgorot: 3000, daysActive: 7 }),
      JSON.stringify({ cplPct: -25, leadsPct: 0, spendPct: -25 }),
      opts.verdict ?? "improved",
      opts.confoundDetail ? JSON.stringify(opts.confoundDetail) : null,
    ],
  );
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
    // Not yet measured — no recommendation_outcomes row exists for it.
    expect(row.outcome).toBeNull();
  });

  it("surfaces a measured outcome once one exists, with exact window dates", async () => {
    const { campaignId } = await seedCampaign("outcome");
    const recId = await seedRec(campaignId, { type: "pause_creative", state: "executed" });
    await seedOutcome(recId, campaignId, { verdict: "improved" });

    const rows = await listRecommendationsForAdmin(pool);
    const row = rows.find((r) => r.id === recId)!;
    expect(row.outcome).not.toBeNull();
    const out = row.outcome!;
    expect(out.verdict).toBe("improved");
    expect(out.beforeFeatures.cplAgorot).toBe(4000);
    expect(out.afterFeatures.cplAgorot).toBe(3000);
    expect(out.delta.cplPct).toBe(-25);
    expect(out.confoundDetail).toBeNull();
    // The exact DATE round trip (pg parses DATE as local-midnight; reading it
    // via to_char in the query avoids the UTC .toISOString() day-shift that
    // bit the outcome-measurement integration tests — see that file's fix).
    expect(out.beforeStart).toBe("2026-08-03");
    expect(out.afterEnd).toBe("2026-08-17");
  });

  it("carries the confound detail through when the outcome was confounded", async () => {
    const { campaignId } = await seedCampaign("confound");
    const recId = await seedRec(campaignId, { type: "decrease_budget", state: "executed" });
    await seedOutcome(recId, campaignId, {
      verdict: "confounded",
      confoundDetail: { otherActions: [{ actionType: "pause_adset", occurredAt: "2026-08-12T10:00:00Z", humanInvolved: true }] },
    });

    const rows = await listRecommendationsForAdmin(pool);
    const row = rows.find((r) => r.id === recId)!;
    expect(row.outcome!.verdict).toBe("confounded");
    expect(row.outcome!.confoundDetail?.otherActions?.[0]?.actionType).toBe("pause_adset");
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

  // AIC-76: fleet-wide aggregate — its own query, deliberately not a
  // client-side rollup over listRecommendationsForAdmin's capped list.
  describe("getOutcomeAggregate", () => {
    it("counts executed recs and buckets measured outcomes by verdict, per type", async () => {
      const a = await seedCampaign("agg-a");
      const b = await seedCampaign("agg-b");

      // pause_creative: 2 executed, 1 improved + 1 not yet measured.
      const rec1 = await seedRec(a.campaignId, { type: "pause_creative", state: "executed" });
      await seedOutcome(rec1, a.campaignId, { verdict: "improved" });
      await seedRec(b.campaignId, { type: "pause_creative", state: "executed" }); // no outcome row yet

      // decrease_budget: 1 executed, confounded — across a different customer.
      const rec2 = await seedRec(b.campaignId, { type: "decrease_budget", state: "executed" });
      await seedOutcome(rec2, b.campaignId, { verdict: "confounded" });

      // A proposed (never executed) rec must not inflate the executed count.
      await seedRec(a.campaignId, { type: "pause_creative", state: "proposed" });

      const agg = await getOutcomeAggregate(pool);
      const creative = agg.find((r) => r.type === "pause_creative")!;
      expect(creative.executed).toBeGreaterThanOrEqual(2);
      expect(creative.byVerdict.improved).toBeGreaterThanOrEqual(1);

      const budget = agg.find((r) => r.type === "decrease_budget")!;
      expect(budget.executed).toBeGreaterThanOrEqual(1);
      expect(budget.byVerdict.confounded).toBeGreaterThanOrEqual(1);
    });

    it("is reachable over HTTP behind an admin credential", async () => {
      const admin = await pool.query<{ id: string }>(
        `INSERT INTO app_users (email, password_hash, name, is_admin) VALUES ('__it_oversight_agg_admin@example.com','x','Op',true) RETURNING id`,
      );
      const auth = `Bearer ${signAuthToken(admin.rows[0].id)}`;
      const res = await request(createApp()).get("/api/admin/recommendations/outcomes-summary").set("Authorization", auth);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.byType)).toBe(true);
      await pool.query(`DELETE FROM app_users WHERE email = '__it_oversight_agg_admin@example.com'`);
    });
  });
});
