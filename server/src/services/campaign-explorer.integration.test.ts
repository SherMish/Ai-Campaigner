// DB + HTTP integration for the full Meta data explorer (AIC-45). Requires
// DATABASE_URL. Live Meta calls are never made in tests — a FakeExplorerReader
// stands in, and the "no token" honest-degradation path is exercised by simply
// not setting META_SYSTEM_USER_TOKEN.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";
import { pool } from "../db/pool.js";
import { createApp } from "../app.js";
import { buildCampaignExplorer } from "./campaign-explorer.js";
import type { ExplorerCampaign, ExplorerReader } from "../meta/explorer.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;
const ADMIN = "Bearer test-admin";

const FAKE_TREE: ExplorerCampaign = {
  id: "meta_camp_1",
  name: "GelNails | Leads",
  effectiveStatus: "ACTIVE",
  dailyBudgetAgorot: 1000,
  lifetimeBudgetAgorot: null,
  bidStrategy: "LOWEST_COST_WITHOUT_CAP",
  metrics: {
    spendAgorot: 5000, impressions: 10000, reach: 8000, frequency: 1.25,
    cpmAgorot: 500, ctrPct: 1.2, cpcAgorot: 42, leads: 5, cplAgorot: 1000,
    qualityRanking: "AVERAGE", engagementRateRanking: "AVERAGE", conversionRateRanking: "AVERAGE",
  },
  adSets: [
    {
      id: "adset_1", name: "18-35", effectiveStatus: "ACTIVE", issues: [],
      dailyBudgetAgorot: 500, lifetimeBudgetAgorot: null, bidStrategy: null,
      targeting: { ageMin: 18, ageMax: 35, genders: ["all"], geoCountries: ["IL"], interests: [] },
      metrics: { spendAgorot: 3000, impressions: 6000, reach: 5000, frequency: 1.2, cpmAgorot: 500, ctrPct: 1.3, cpcAgorot: 40, leads: 3, cplAgorot: 1000, qualityRanking: null, engagementRateRanking: null, conversionRateRanking: null },
      ads: [], pageId: null,
    },
    {
      id: "adset_2", name: "errored", effectiveStatus: "ACTIVE", issues: ["Page Is Unpublished For Ad"],
      dailyBudgetAgorot: 500, lifetimeBudgetAgorot: null, bidStrategy: null,
      targeting: { ageMin: 35, ageMax: 45, genders: ["all"], geoCountries: ["IL"], interests: [] },
      metrics: { spendAgorot: 0, impressions: 0, reach: null, frequency: null, cpmAgorot: null, ctrPct: null, cpcAgorot: null, leads: 0, cplAgorot: null, qualityRanking: null, engagementRateRanking: null, conversionRateRanking: null },
      ads: [], pageId: null,
    },
  ],
  period: { start: "2026-08-02", end: "2026-08-08" },
  fetchedAt: "2026-08-09T00:00:00.000Z",
};

class FakeExplorerReader implements ExplorerReader {
  public calls: string[] = [];
  constructor(private readonly tree: ExplorerCampaign | null = FAKE_TREE, private readonly err?: Error) {}
  async getExplorerTree(metaCampaignId: string): Promise<ExplorerCampaign> {
    this.calls.push(metaCampaignId);
    if (this.err) throw this.err;
    return this.tree!;
  }
}

async function seedCampaign(tag: string, metaCampaignId: string | null): Promise<{ customerId: string; campaignId: string }> {
  const cust = await pool.query<{ id: string }>(`INSERT INTO customers (business_name) VALUES ($1) RETURNING id`, [`__it_explorer_${tag}`]);
  const customerId = cust.rows[0].id;
  const conn = await pool.query<{ id: string }>(`INSERT INTO meta_connections (customer_id, access_health) VALUES ($1,'ok') RETURNING id`, [customerId]);
  const acct = await pool.query<{ id: string }>(`INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`, [conn.rows[0].id, `act_expl_${conn.rows[0].id.slice(0, 8)}`]);
  const camp = await pool.query<{ id: string }>(
    `INSERT INTO managed_campaigns (customer_id, ad_account_id, name, status, meta_campaign_id) VALUES ($1,$2,$3,'active',$4) RETURNING id`,
    [customerId, acct.rows[0].id, `camp_${tag}`, metaCampaignId],
  );
  return { customerId, campaignId: camp.rows[0].id };
}

d("full Meta data explorer (DB + HTTP)", () => {
  beforeAll(() => { process.env.ADMIN_TOKEN = "test-admin"; delete process.env.META_SYSTEM_USER_TOKEN; });
  afterAll(async () => {
    await pool.query(`DELETE FROM customers WHERE business_name LIKE '__it_explorer_%'`);
    await pool.end();
  });

  it("returns null for a campaign that doesn't exist", async () => {
    const r = await buildCampaignExplorer(pool, "00000000-0000-0000-0000-000000000000");
    expect(r).toBeNull();
  });

  it("degrades honestly with 'no_meta_campaign' when the campaign isn't linked to Meta yet", async () => {
    const { campaignId } = await seedCampaign("unlinked", null);
    const r = await buildCampaignExplorer(pool, campaignId);
    expect(r?.unavailableReason).toBe("no_meta_campaign");
    expect(r?.tree).toBeNull();
  });

  it("degrades honestly with 'no_token' when META_SYSTEM_USER_TOKEN isn't set and no reader is injected", async () => {
    const { campaignId } = await seedCampaign("notoken", "meta_camp_x");
    const r = await buildCampaignExplorer(pool, campaignId);
    expect(r?.unavailableReason).toBe("no_token");
  });

  it("assembles the real tree — 2 ad sets, one healthy, one errored, both rendered truthfully", async () => {
    const { campaignId } = await seedCampaign("full", "meta_camp_1");
    const reader = new FakeExplorerReader();
    const r = await buildCampaignExplorer(pool, campaignId, { reader });
    expect(r?.unavailableReason).toBeNull();
    expect(r?.tree?.adSets).toHaveLength(2);
    expect(r?.tree?.adSets[0].targeting.ageMin).toBe(18);
    expect(r?.tree?.adSets[1].issues).toContain("Page Is Unpublished For Ad");
    expect(reader.calls).toEqual(["meta_camp_1"]);
  });

  it("surfaces a Meta error honestly as 'meta_error' rather than a 500 or a fabricated tree", async () => {
    const { campaignId } = await seedCampaign("error", "meta_camp_err");
    const reader = new FakeExplorerReader(null, new Error("Graph API rate limited"));
    const r = await buildCampaignExplorer(pool, campaignId, { reader });
    expect(r?.unavailableReason).toBe("meta_error");
    expect(r?.errorDetail).toContain("rate limited");
  });

  it("404s the route for an unknown campaign id and honestly reports 'no_token' for a real one (no token in test env)", async () => {
    const app = createApp();
    const missing = await request(app).get("/api/admin/campaigns/00000000-0000-0000-0000-000000000000/explorer").set("Authorization", ADMIN);
    expect(missing.status).toBe(404);

    const { campaignId } = await seedCampaign("http", "meta_camp_http");
    const res = await request(app).get(`/api/admin/campaigns/${campaignId}/explorer`).set("Authorization", ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.unavailableReason).toBe("no_token");
  });

  it("rejects the route without an admin credential", async () => {
    const { campaignId } = await seedCampaign("auth", "meta_camp_auth");
    const res = await request(createApp()).get(`/api/admin/campaigns/${campaignId}/explorer`);
    expect(res.status).toBe(401);
  });
});
