// DB integration for the builder's idempotent create-writes (AIC-50). Requires
// DATABASE_URL; self-skips otherwise. No live Meta call — FakeBuilderWriter
// stands in; the real adapter shape is verified by the live dogfood test.
import { describe, it, expect, afterAll } from "vitest";
import { pool } from "../db/pool.js";
import { startBuilderCampaign, buildCampaignOnMeta, type BuildCampaignInput } from "./campaign-create.js";
import { FakeBuilderWriter } from "./types.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

async function makeCustomer(tag: string): Promise<{ customerId: string; adAccountId: string }> {
  const cust = await pool.query<{ id: string }>(`INSERT INTO customers (business_name) VALUES ($1) RETURNING id`, [`__it_builder_${tag}`]);
  const customerId = cust.rows[0].id;
  const conn = await pool.query<{ id: string }>(`INSERT INTO meta_connections (customer_id) VALUES ($1) RETURNING id`, [customerId]);
  const acct = await pool.query<{ id: string }>(`INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`, [conn.rows[0].id, `act_bld_${conn.rows[0].id.slice(0, 8)}`]);
  return { customerId, adAccountId: acct.rows[0].id };
}

function baseInput(localCampaignId: string, adAccountId: string): BuildCampaignInput {
  return {
    localCampaignId,
    adAccountId,
    pageId: "page_1",
    name: "__it_builder campaign",
    dailyBudgetAgorot: 4000,
    specialAdCategories: [],
    bidStrategy: "LOWEST_COST_WITHOUT_CAP",
    whatsappDestination: "972500000000",
    adSets: [
      {
        clientKey: "adset-1",
        name: "Adset 1",
        targeting: { ageMin: 18, ageMax: 45, genders: [], countries: ["IL"] },
        ads: [
          { clientKey: "adset-1-ad-1", name: "Ad 1", creativeId: "crea_1" },
          { clientKey: "adset-1-ad-2", name: "Ad 2", creativeId: "crea_2" },
        ],
      },
    ],
  };
}

d("campaign builder create-writes (DB)", () => {
  afterAll(async () => {
    await pool.query(`DELETE FROM customers WHERE business_name LIKE '__it_builder_%'`);
    await pool.end();
  });

  it("startBuilderCampaign creates a shell row and is idempotent (resume finds the same row)", async () => {
    const { customerId, adAccountId } = await makeCustomer("start");
    const first = await startBuilderCampaign(pool, customerId, adAccountId);
    const second = await startBuilderCampaign(pool, customerId, adAccountId);
    expect(second.id).toBe(first.id);

    const { rows } = await pool.query(`SELECT status, meta_campaign_id FROM managed_campaigns WHERE id = $1`, [first.id]);
    expect(rows[0].status).toBe("under_review");
    expect(rows[0].meta_campaign_id).toBeNull();
  });

  it("creates every object PAUSED, logs action_history for each, and links the campaign on success", async () => {
    const { customerId, adAccountId } = await makeCustomer("happy");
    const { id: localCampaignId } = await startBuilderCampaign(pool, customerId, adAccountId);
    const writer = new FakeBuilderWriter();

    const result = await buildCampaignOnMeta(pool, writer, baseInput(localCampaignId, adAccountId));

    expect(result.metaCampaignId).toBeTruthy();
    expect(result.adSets).toHaveLength(1);
    expect(result.adSets[0].ads).toHaveLength(2);

    // (The created-PAUSED invariant is enforced inside GraphCampaignAdapter,
    // where status=PAUSED is hardcoded into every create call — see
    // campaign-adapter.test.ts. FakeBuilderWriter's params don't carry status
    // at all, since real customers/tests can't ever override it.)
    expect(writer.adSetCalls).toHaveLength(1);
    expect(writer.adCalls).toHaveLength(2);

    const camp = await pool.query(`SELECT meta_campaign_id, status, name, agreed_budget_agorot FROM managed_campaigns WHERE id = $1`, [localCampaignId]);
    expect(camp.rows[0].meta_campaign_id).toBe(result.metaCampaignId);
    expect(camp.rows[0].status).toBe("under_review"); // building never activates
    expect(camp.rows[0].agreed_budget_agorot).toBe(4000);

    const history = await pool.query(`SELECT action_type, target_meta_id FROM action_history WHERE campaign_id = $1 ORDER BY occurred_at`, [localCampaignId]);
    expect(history.rows.map((r) => r.action_type)).toEqual(["create_campaign", "create_ad_set", "create_ad", "create_ad"]);
  });

  it("a mid-build failure is reconcilable: resuming skips every already-created object and only retries the failed step", async () => {
    const { customerId, adAccountId } = await makeCustomer("resume");
    const { id: localCampaignId } = await startBuilderCampaign(pool, customerId, adAccountId);
    const writer = new FakeBuilderWriter();
    writer.failNextCreateAd = 1; // the FIRST ad's create call fails first time through

    await expect(buildCampaignOnMeta(pool, writer, baseInput(localCampaignId, adAccountId))).rejects.toThrow("simulated Meta create-ad failure");

    // The campaign and the ad set already landed on Meta — confirm they're
    // NOT re-created on resume. Neither ad has succeeded yet (the first one
    // is what failed).
    expect(writer.campaignCalls).toHaveLength(1);
    expect(writer.adSetCalls).toHaveLength(1);
    expect(writer.adCalls).toHaveLength(0);

    const result = await buildCampaignOnMeta(pool, writer, baseInput(localCampaignId, adAccountId));
    expect(result.adSets[0].ads).toHaveLength(2);
    // Still only ONE call each for campaign/ad-set — resume never re-created them.
    expect(writer.campaignCalls).toHaveLength(1);
    expect(writer.adSetCalls).toHaveLength(1);
    expect(writer.adCalls).toHaveLength(2); // both ads now created, none duplicated

    const camp = await pool.query(`SELECT meta_campaign_id FROM managed_campaigns WHERE id = $1`, [localCampaignId]);
    expect(camp.rows[0].meta_campaign_id).toBeTruthy();
  });

  it("a full re-run after success makes no new Meta calls at all", async () => {
    const { customerId, adAccountId } = await makeCustomer("rerun");
    const { id: localCampaignId } = await startBuilderCampaign(pool, customerId, adAccountId);
    const writer = new FakeBuilderWriter();

    const first = await buildCampaignOnMeta(pool, writer, baseInput(localCampaignId, adAccountId));
    const second = await buildCampaignOnMeta(pool, writer, baseInput(localCampaignId, adAccountId));

    expect(second).toEqual(first);
    expect(writer.campaignCalls).toHaveLength(1);
    expect(writer.adSetCalls).toHaveLength(1);
    expect(writer.adCalls).toHaveLength(2);
  });
});
