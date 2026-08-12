// DB integration for adding content to an EXISTING campaign (AIC-63).
// Requires DATABASE_URL; self-skips otherwise. No real Meta call —
// FakeBuilderWriter/FakeAdditionWriter stand in; the real adapter shape is
// verified by campaign-adapter.test.ts.
import { describe, it, expect, afterAll } from "vitest";
import { pool } from "../db/pool.js";
import { addAdToExistingCampaign, addAdSetToExistingCampaign } from "./add-content.js";
import { approveAddition } from "./approve.js";
import { FakeBuilderWriter } from "../builder/types.js";
import { FakeAdditionWriter } from "./types.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

// An EXISTING, already-linked (active on Meta) managed campaign — the
// opposite fixture shape from campaign-create.integration.test.ts's shell row.
async function makeExistingCampaign(tag: string): Promise<{ customerId: string; campaignId: string; adAccountId: string }> {
  const cust = await pool.query<{ id: string }>(`INSERT INTO customers (business_name, is_test) VALUES ($1, true) RETURNING id`, [`__it_addcontent_${tag}`]);
  const customerId = cust.rows[0].id;
  const conn = await pool.query<{ id: string }>(`INSERT INTO meta_connections (customer_id) VALUES ($1) RETURNING id`, [customerId]);
  const acct = await pool.query<{ id: string }>(`INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`, [conn.rows[0].id, `act_add_${conn.rows[0].id.slice(0, 8)}`]);
  const camp = await pool.query<{ id: string }>(
    `INSERT INTO managed_campaigns (customer_id, ad_account_id, status, meta_campaign_id) VALUES ($1,$2,'active','meta_camp_existing') RETURNING id`,
    [customerId, acct.rows[0].id],
  );
  return { customerId, campaignId: camp.rows[0].id, adAccountId: acct.rows[0].id };
}

d("add content to an existing campaign (DB)", () => {
  afterAll(async () => {
    await pool.query(`DELETE FROM customers WHERE business_name LIKE '__it_addcontent_%'`);
    await pool.end();
  });

  it("adds an ad to an EXISTING ad set: creates PAUSED, logs, records a pending approval", async () => {
    const { campaignId } = await makeExistingCampaign("ad-happy");
    const writer = new FakeBuilderWriter();

    const result = await addAdToExistingCampaign(pool, writer, {
      localCampaignId: campaignId,
      metaAdAccountId: "act_123",
      metaAdSetId: "as_existing_1",
      name: "New Ad",
      creativeId: "crea_1",
      additionKey: "attempt-1",
    });

    expect(result.metaAdSetId).toBe("as_existing_1");
    expect(result.metaAdIds).toHaveLength(1);
    expect(writer.adCalls).toHaveLength(1);
    expect(writer.adSetCalls).toHaveLength(0); // no new ad set — reused the existing one

    const pending = await pool.query(`SELECT kind, meta_ad_set_id, meta_ad_ids, approved_at FROM pending_additions WHERE id = $1`, [result.additionId]);
    expect(pending.rows[0]).toMatchObject({ kind: "ad", meta_ad_set_id: "as_existing_1" });
    expect(pending.rows[0].approved_at).toBeNull();

    const history = await pool.query(`SELECT action_type FROM action_history WHERE campaign_id = $1`, [campaignId]);
    expect(history.rows.map((r) => r.action_type)).toEqual(["create_ad"]);
  });

  it("adding an ad is idempotent per additionKey: a resubmit never creates a second ad or a second pending row", async () => {
    const { campaignId } = await makeExistingCampaign("ad-idem");
    const writer = new FakeBuilderWriter();
    const input = { localCampaignId: campaignId, metaAdAccountId: "act_123", metaAdSetId: "as_1", name: "Ad", creativeId: "crea_1", additionKey: "same-key" };

    const first = await addAdToExistingCampaign(pool, writer, input);
    const second = await addAdToExistingCampaign(pool, writer, input);

    expect(second.additionId).toBe(first.additionId);
    expect(second.metaAdIds).toEqual(first.metaAdIds);
    expect(writer.adCalls).toHaveLength(1);
    const pending = await pool.query(`SELECT id FROM pending_additions WHERE campaign_id = $1`, [campaignId]);
    expect(pending.rows).toHaveLength(1);
  });

  it("adds an ad set + its ads under the existing campaign — never creates a new campaign", async () => {
    const { campaignId } = await makeExistingCampaign("adset-happy");
    const writer = new FakeBuilderWriter();

    const result = await addAdSetToExistingCampaign(pool, writer, {
      localCampaignId: campaignId,
      metaAdAccountId: "act_123",
      metaCampaignId: "meta_camp_existing",
      pageId: "page_1",
      name: "Older women",
      targeting: { ageMin: 35, ageMax: 55, genders: [2], countries: ["IL"] },
      ads: [
        { clientKey: "ad-1", name: "Ad A", creativeId: "crea_a" },
        { clientKey: "ad-2", name: "Ad B", creativeId: "crea_b" },
      ],
      additionKey: "attempt-2",
    });

    expect(result.metaAdIds).toHaveLength(2);
    expect(writer.campaignCalls).toHaveLength(0); // the critical assertion — no new campaign
    expect(writer.adSetCalls).toHaveLength(1);
    expect(writer.adSetCalls[0].metaCampaignId).toBe("meta_camp_existing");
    expect(writer.adCalls).toHaveLength(2);

    const history = await pool.query(`SELECT action_type FROM action_history WHERE campaign_id = $1 ORDER BY occurred_at`, [campaignId]);
    expect(history.rows.map((r) => r.action_type)).toEqual(["create_ad_set", "create_ad", "create_ad"]);
  });

  it("a mid-build failure on add-ad-set resumes cleanly: retry only creates what's missing", async () => {
    const { campaignId } = await makeExistingCampaign("adset-resume");
    const writer = new FakeBuilderWriter();
    writer.failNextCreateAd = 1;
    const input = {
      localCampaignId: campaignId, metaAdAccountId: "act_123", metaCampaignId: "meta_camp_existing", pageId: "page_1",
      name: "Set", targeting: { ageMin: 20, ageMax: 40, genders: [], countries: ["IL"] },
      ads: [{ clientKey: "ad-1", name: "Ad A", creativeId: "crea_a" }],
      additionKey: "attempt-3",
    };

    await expect(addAdSetToExistingCampaign(pool, writer, input)).rejects.toThrow("simulated Meta create-ad failure");
    expect(writer.adSetCalls).toHaveLength(1);
    expect(writer.adCalls).toHaveLength(0);
    // No pending row yet — only inserted once everything succeeds.
    expect((await pool.query(`SELECT id FROM pending_additions WHERE campaign_id = $1`, [campaignId])).rows).toHaveLength(0);

    const retry = await addAdSetToExistingCampaign(pool, writer, input);
    expect(retry.metaAdIds).toHaveLength(1);
    expect(writer.adSetCalls).toHaveLength(1); // not recreated
    expect(writer.adCalls).toHaveLength(1);
  });

  it("approving an ad-set addition activates the ad set AND its ads, verifies, logs, marks approved", async () => {
    const { campaignId } = await makeExistingCampaign("approve-adset");
    const builderWriter = new FakeBuilderWriter();
    const added = await addAdSetToExistingCampaign(pool, builderWriter, {
      localCampaignId: campaignId, metaAdAccountId: "act_123", metaCampaignId: "meta_camp_existing", pageId: "page_1",
      name: "Set", targeting: { ageMin: 20, ageMax: 40, genders: [], countries: ["IL"] },
      ads: [{ clientKey: "ad-1", name: "Ad A", creativeId: "crea_a" }],
      additionKey: "approve-1",
    });

    const additionWriter = new FakeAdditionWriter();
    const result = await approveAddition(pool, additionWriter, added.additionId, campaignId);

    expect(result).toEqual({ outcome: "approved" });
    expect(additionWriter.activateAdSetCalls).toEqual([added.metaAdSetId]);
    expect(additionWriter.activateAdCalls).toEqual(added.metaAdIds);

    const pending = await pool.query(`SELECT approved_at FROM pending_additions WHERE id = $1`, [added.additionId]);
    expect(pending.rows[0].approved_at).toBeTruthy();

    const history = await pool.query(`SELECT action_type FROM action_history WHERE campaign_id = $1 AND action_type LIKE 'activate%' ORDER BY occurred_at`, [campaignId]);
    expect(history.rows.map((r) => r.action_type)).toEqual(["activate_ad_set", "activate_ad"]);
  });

  it("approving is idempotent: a second approval is a no-op, never double-activates or double-logs", async () => {
    const { campaignId } = await makeExistingCampaign("approve-idem");
    const builderWriter = new FakeBuilderWriter();
    const added = await addAdToExistingCampaign(pool, builderWriter, {
      localCampaignId: campaignId, metaAdAccountId: "act_123", metaAdSetId: "as_1", name: "Ad", creativeId: "crea_1", additionKey: "a-1",
    });
    const additionWriter = new FakeAdditionWriter();

    const first = await approveAddition(pool, additionWriter, added.additionId, campaignId);
    const second = await approveAddition(pool, additionWriter, added.additionId, campaignId);

    expect(first.outcome).toBe("approved");
    expect(second).toEqual({ outcome: "already_approved" });
    expect(additionWriter.activateAdCalls).toHaveLength(1);
  });

  it("ownership: approving with the wrong campaignId is refused as not_found", async () => {
    const a = await makeExistingCampaign("owner-a");
    const b = await makeExistingCampaign("owner-b");
    const builderWriter = new FakeBuilderWriter();
    const added = await addAdToExistingCampaign(pool, builderWriter, {
      localCampaignId: a.campaignId, metaAdAccountId: "act_123", metaAdSetId: "as_1", name: "Ad", creativeId: "crea_1", additionKey: "a-1",
    });
    const additionWriter = new FakeAdditionWriter();

    const stolen = await approveAddition(pool, additionWriter, added.additionId, b.campaignId);

    expect(stolen.outcome).toBe("not_found");
    expect(additionWriter.activateAdCalls).toHaveLength(0);
  });

  it("a failed activation is reported honestly and never marked approved", async () => {
    const { campaignId } = await makeExistingCampaign("approve-fail");
    const builderWriter = new FakeBuilderWriter();
    const added = await addAdToExistingCampaign(pool, builderWriter, {
      localCampaignId: campaignId, metaAdAccountId: "act_123", metaAdSetId: "as_1", name: "Ad", creativeId: "crea_1", additionKey: "a-1",
    });
    const additionWriter = new FakeAdditionWriter();
    additionWriter.failNextActivateAd = 1;

    const result = await approveAddition(pool, additionWriter, added.additionId, campaignId);

    expect(result.outcome).toBe("failed");
    const pending = await pool.query(`SELECT approved_at FROM pending_additions WHERE id = $1`, [added.additionId]);
    expect(pending.rows[0].approved_at).toBeNull();

    const retry = await approveAddition(pool, additionWriter, added.additionId, campaignId);
    expect(retry.outcome).toBe("approved");
  });
});
