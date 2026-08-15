// DB + HTTP integration for the opt-in audience details view (AIC-37). Requires
// DATABASE_URL; self-skips otherwise.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";
import { pool } from "../db/pool.js";
import { createApp } from "../app.js";
import { signAuthToken } from "../auth/tokens.js";
import { PgSnapshotStore } from "../meta/snapshot-store.js";
import { upsertAdSetMeta } from "./audience-meta-cache.js";
import { buildCampaignAudiences } from "./campaign-audiences.js";
import type { SnapshotUpsert } from "../meta/insights.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;
// A disjoint DAILY row (period_start = period_end) on today — inside every
// range's window by construction (day/week/month/allTime all end at "today"
// per resolveRangeWindow), so existing fixtures don't need to know or care
// which range a given test exercises.
const TODAY = new Date().toISOString().slice(0, 10);

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
    periodStart: TODAY, periodEnd: TODAY, spendAgorot: 0, leads: 0, cplAgorot: null,
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

  // AIC-73: previously fell back to the raw ad-set name here ("Winter Promo
  // A"/"B") — a real spec violation (AIC-37 forbids raw Meta names in the
  // customer app). Corrected: never the name, even when two ad sets share
  // identical structured targeting — a running suffix disambiguates instead.
  it("never falls back to the raw ad-set name — identical targeting gets a disambiguating suffix, not the Meta name", async () => {
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
    expect(labels).toEqual(["25–40", "25–40 (2)"]);
    expect(labels.some((l) => l.includes("Winter Promo"))).toBe(false);
  });

  // The single-ad-set case (AIC-73's actual trigger, e.g. GelNails): with
  // nothing to differ from, the ad set still gets its own composed label —
  // never the raw name it would have fallen back to under the old rule.
  it("a single ad set gets its own composed label, not the raw Meta name", async () => {
    const { userId, campaignId } = await seedChain("single");
    const store = new PgSnapshotStore(pool);
    await store.upsert([
      snap(campaignId, { grain: "adset", metaObjectId: "as_only", spendAgorot: 950, leads: 1, cplAgorot: 950 }),
    ]);
    await upsertAdSetMeta(pool, campaignId, [
      { adSetId: "as_only", name: "IL | Ramat Gan, Givatayim | Women 18-46 | Advantage+", ageMin: 18, ageMax: 46, genders: "female", geoSummary: "רמת גן, Givatayim", isDynamicCreative: false },
    ]);
    const result = await buildCampaignAudiences(pool, userId);
    expect(result?.audiences).toHaveLength(1);
    expect(result!.audiences[0].label).toBe("נשים · 18–46 · רמת גן, Givatayim");
  });

  it("excludes an ad set with historical spend but no meta-cache row (AIC-65: a dead/draft ad set never cached)", async () => {
    const { userId, campaignId } = await seedChain("dead");
    const store = new PgSnapshotStore(pool);
    await store.upsert([
      snap(campaignId, { grain: "adset", metaObjectId: "as_real", spendAgorot: 40000, leads: 20, cplAgorot: 2000 }),
      // as_dead has real historical spend (the GelNails shape) but generation.ts
      // never caches a dead/draft ad set's meta row — simulate that directly.
      snap(campaignId, { grain: "adset", metaObjectId: "as_dead", spendAgorot: 235, leads: 0, cplAgorot: null }),
    ]);
    await upsertAdSetMeta(pool, campaignId, [
      { adSetId: "as_real", name: "Women 18-46", ageMin: 18, ageMax: 46, genders: "female", geoSummary: "", isDynamicCreative: false },
    ]);

    const result = await buildCampaignAudiences(pool, userId);
    expect(result?.audiences).toHaveLength(1);
    expect(result?.audiences[0].adSetId).toBe("as_real");
  });

  // AIC-95: the panel used to always read the engine's fixed 7-complete-day
  // window (rollingPeriods().current), completely ignoring the day/week/
  // month/all-time switcher — its own disclaimer said so. This is the
  // regression test for the actual fix: two otherwise-identical days, one
  // inside the selected window and one outside it, must change what renders.
  it("follows the selected range — a day outside the window is excluded, changing the total", async () => {
    const { userId, campaignId } = await seedChain("range");
    const store = new PgSnapshotStore(pool);
    const longAgo = "2026-01-05"; // outside "day"/"week"/"month", inside "allTime"
    await store.upsert([
      snap(campaignId, { grain: "adset", metaObjectId: "as_x", spendAgorot: 1000, leads: 1, cplAgorot: 1000 }), // today
      snap(campaignId, { grain: "adset", metaObjectId: "as_x", periodStart: longAgo, periodEnd: longAgo, spendAgorot: 5000, leads: 5, cplAgorot: 1000 }),
    ]);
    await upsertAdSetMeta(pool, campaignId, [
      { adSetId: "as_x", name: "Set X", ageMin: 25, ageMax: 40, genders: "all", geoSummary: "", isDynamicCreative: false },
    ]);

    const day = await buildCampaignAudiences(pool, userId, "day");
    expect(day?.audiences[0].spendAgorot).toBe(1000); // only today

    const allTime = await buildCampaignAudiences(pool, userId, "allTime");
    expect(allTime?.audiences[0].spendAgorot).toBe(6000); // today + the old day
  });

  // The panel's core honesty fix: never a bare empty array.
  describe("empty windows state the reason instead of rendering nothing", () => {
    it("started_today: no historical data, but today has real rows the meta-cache hasn't caught up to yet", async () => {
      const { userId, campaignId } = await seedChain("started-today");
      const store = new PgSnapshotStore(pool);
      // Real data exists for today, but the ad set was never cached (AIC-65's
      // exclusion) — the exact shape of "day 1, before the first generation tick".
      await store.upsert([snap(campaignId, { grain: "adset", metaObjectId: "as_uncached", spendAgorot: 1000, leads: 1 })]);

      const result = await buildCampaignAudiences(pool, userId, "week");
      expect(result?.audiences).toEqual([]);
      expect(result?.empty).toEqual({ reason: "started_today", mostRecentDataDate: TODAY });
    });

    it("no_data_in_range: real historical data exists, just not inside the selected window", async () => {
      const { userId, campaignId } = await seedChain("gap");
      const store = new PgSnapshotStore(pool);
      const longAgo = "2026-01-05";
      await store.upsert([
        snap(campaignId, { grain: "adset", metaObjectId: "as_x", periodStart: longAgo, periodEnd: longAgo, spendAgorot: 5000, leads: 5 }),
      ]);
      await upsertAdSetMeta(pool, campaignId, [
        { adSetId: "as_x", name: "Set X", ageMin: 25, ageMax: 40, genders: "all", geoSummary: "", isDynamicCreative: false },
      ]);

      const result = await buildCampaignAudiences(pool, userId, "week"); // longAgo is well outside "week"
      expect(result?.audiences).toEqual([]);
      expect(result?.empty).toEqual({ reason: "no_data_in_range", mostRecentDataDate: longAgo });
    });

    it("no_data_yet: never had any per-object data at all", async () => {
      const { userId } = await seedChain("never");
      const result = await buildCampaignAudiences(pool, userId, "week");
      expect(result?.audiences).toEqual([]);
      expect(result?.empty).toEqual({ reason: "no_data_yet", mostRecentDataDate: null });
    });
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
