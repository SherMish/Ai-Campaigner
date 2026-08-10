// DB + HTTP integration for the opt-in audience details view (AIC-37). Requires
// DATABASE_URL; self-skips otherwise.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";
import { pool } from "../db/pool.js";
import { createApp } from "../app.js";
import { signAuthToken } from "../auth/tokens.js";
import { PgSnapshotStore } from "../meta/snapshot-store.js";
import { rollingPeriods } from "../meta/scheduled-ingestion.js";
import { upsertAdSetMeta } from "./audience-meta-cache.js";
import { buildCampaignAudiences } from "./campaign-audiences.js";
import type { SnapshotUpsert } from "../meta/insights.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;
const { current: CUR } = rollingPeriods();

async function seedChain(tag: string) {
  const cust = await pool.query<{ id: string }>(
    `INSERT INTO customers (business_name, is_test, onboarding_status) VALUES ($1, true, 'ready') RETURNING id`,
    [`__it_aud_${tag}`],
  );
  const customerId = cust.rows[0].id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO app_users (email, password_hash, name, customer_id) VALUES ($1,'x','Owner',$2) RETURNING id`,
    [`__it_aud_${tag}@example.com`, customerId],
  );
  const conn = await pool.query<{ id: string }>(
    `INSERT INTO meta_connections (customer_id, system_user_id, access_health) VALUES ($1,'9','ok') RETURNING id`,
    [customerId],
  );
  const acct = await pool.query<{ id: string }>(
    `INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`,
    [conn.rows[0].id, `act_aud_${conn.rows[0].id.slice(0, 8)}`],
  );
  const camp = await pool.query<{ id: string }>(
    `INSERT INTO managed_campaigns (customer_id, ad_account_id, meta_campaign_id, name, status, agreed_budget_agorot)
     VALUES ($1,$2,'meta_aud_1','IT Campaign','active',10000) RETURNING id`,
    [customerId, acct.rows[0].id],
  );
  return { customerId, userId: user.rows[0].id, campaignId: camp.rows[0].id };
}

function snap(campaignId: string, o: Partial<SnapshotUpsert> & Pick<SnapshotUpsert, "grain" | "metaObjectId">): SnapshotUpsert {
  return {
    campaignId, parentMetaId: null, creativeName: null,
    periodStart: CUR.start, periodEnd: CUR.end, spendAgorot: 0, leads: 0, cplAgorot: null,
    impressions: 0, linkClicks: 0, deliveryStatus: "active", raw: {}, ...o,
  };
}

d("campaign audiences (DB + HTTP)", () => {
  beforeAll(() => { process.env.JWT_SECRET ||= "test-secret-audiences"; });
  afterAll(async () => {
    await pool.query(`DELETE FROM app_users WHERE email LIKE '__it_aud_%'`);
    await pool.query(`DELETE FROM customers WHERE business_name LIKE '__it_aud_%'`);
    await pool.end();
  });

  it("groups creatives under their ad set and labels by age (structured dimension)", async () => {
    const { userId, campaignId } = await seedChain("age");
    const store = new PgSnapshotStore(pool);
    await store.upsert([
      snap(campaignId, { grain: "adset", metaObjectId: "as_a", spendAgorot: 20000, leads: 10, cplAgorot: 2000 }),
      snap(campaignId, { grain: "adset", metaObjectId: "as_b", spendAgorot: 20000, leads: 4, cplAgorot: 5000 }),
      snap(campaignId, { grain: "creative", metaObjectId: "cr_a1", parentMetaId: "as_a", creativeName: "Almond", spendAgorot: 20000, leads: 10, cplAgorot: 2000 }),
      snap(campaignId, { grain: "creative", metaObjectId: "cr_b1", parentMetaId: "as_b", creativeName: "Almond", spendAgorot: 20000, leads: 4, cplAgorot: 5000 }),
    ]);
    await upsertAdSetMeta(pool, campaignId, [
      { adSetId: "as_a", name: "Set A", ageMin: 18, ageMax: 35, genders: "all", geoSummary: "", isDynamicCreative: false },
      { adSetId: "as_b", name: "Set B", ageMin: 35, ageMax: 45, genders: "all", geoSummary: "", isDynamicCreative: false },
    ]);

    const result = await buildCampaignAudiences(pool, userId);
    expect(result?.audiences).toHaveLength(2);
    const byLabel = new Map(result!.audiences.map((a) => [a.label, a]));
    expect(byLabel.has("18–35")).toBe(true);
    expect(byLabel.has("35–45")).toBe(true);
    // the same creative NAME appears under both audiences as distinct rows here
    // (this is the internal-detail view — it's the Home roll-up that de-dupes).
    expect(byLabel.get("18–35")!.creatives).toHaveLength(1);
    expect(byLabel.get("18–35")!.creatives[0].creativeName).toBe("Almond");

    // Over HTTP, scoped by the caller's JWT.
    const token = signAuthToken(userId);
    const res = await request(createApp()).get("/api/app/audiences").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.audiences).toHaveLength(2);
  });

  it("falls back to the ad set's own name when nothing structured differs", async () => {
    const { userId, campaignId } = await seedChain("noname");
    const store = new PgSnapshotStore(pool);
    await store.upsert([
      snap(campaignId, { grain: "adset", metaObjectId: "as_x", spendAgorot: 5000, leads: 2, cplAgorot: 2500 }),
      snap(campaignId, { grain: "adset", metaObjectId: "as_y", spendAgorot: 5000, leads: 2, cplAgorot: 2500 }),
    ]);
    await upsertAdSetMeta(pool, campaignId, [
      { adSetId: "as_x", name: "Winter Promo A", ageMin: 25, ageMax: 40, genders: "all", geoSummary: "", isDynamicCreative: false },
      { adSetId: "as_y", name: "Winter Promo B", ageMin: 25, ageMax: 40, genders: "all", geoSummary: "", isDynamicCreative: false },
    ]);
    const result = await buildCampaignAudiences(pool, userId);
    const labels = result!.audiences.map((a) => a.label).sort();
    expect(labels).toEqual(["Winter Promo A", "Winter Promo B"]);
  });

  it("rejects the endpoint without a token, and returns null for a user with no campaign", async () => {
    const noToken = await request(createApp()).get("/api/app/audiences");
    expect(noToken.status).toBe(401);

    const cust = await pool.query<{ id: string }>(
      `INSERT INTO customers (business_name, is_test) VALUES ('__it_aud_none', true) RETURNING id`,
    );
    const user = await pool.query<{ id: string }>(
      `INSERT INTO app_users (email, password_hash, customer_id) VALUES ('__it_aud_none@example.com','x',$1) RETURNING id`,
      [cust.rows[0].id],
    );
    expect(await buildCampaignAudiences(pool, user.rows[0].id)).toBeNull();
  });
});
