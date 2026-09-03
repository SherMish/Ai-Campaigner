// DB integration for adding content to an EXISTING campaign (AIC-63).
// Requires DATABASE_URL; self-skips otherwise. No real Meta call —
// FakeAddContentWriter stands in; the real adapter shape is verified by
// campaign-adapter.test.ts.
//
// AIC-106: adding content no longer waits for an approval click — every
// create is followed immediately by activation in the same call. The
// activation MECHANISM (approveAddition) is unchanged and still separately
// tested below for its idempotency/ownership/failure behaviour, because
// that's what makes retrying a half-failed create safe.
import { describe, it, expect, afterAll } from "vitest";
import { pool } from "../db/pool.js";
import { actorOf } from "../services/action-history.js";
import { addAdToExistingCampaign, addAdSetToExistingCampaign } from "./add-content.js";
import { approveAddition } from "./approve.js";
import { FakeAddContentWriter, FakeAdditionWriter } from "./types.js";

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

  it("adds an ad to an EXISTING ad set: creates PAUSED, then activates it immediately (AIC-106)", async () => {
    const { campaignId } = await makeExistingCampaign("ad-happy");
    const writer = new FakeAddContentWriter();

    const result = await addAdToExistingCampaign(pool, writer, {
      localCampaignId: campaignId,
      metaAdAccountId: "act_123",
      metaCampaignId: "meta_camp_it",
      metaAdSetId: "as_existing_1",
      pageId: "page_1",
      name: "New Ad",
      creativeId: "crea_1",
      additionKey: "attempt-1", actor: "customer",
    });

    expect(result.metaAdSetId).toBe("as_existing_1");
    expect(result.metaAdIds).toHaveLength(1);
    expect(writer.adCalls).toHaveLength(1);
    expect(writer.adSetCalls).toHaveLength(0); // no new ad set — reused the existing one

    // AIC-106: live immediately, no second step.
    expect(result.activation).toEqual({ outcome: "approved" });
    expect(writer.activateAdCalls).toEqual(result.metaAdIds);
    // The ad's PARENT ad set is deliberately NOT activated — it may be paused
    // on purpose, and adding an ad to it must not silently restart it.
    expect(writer.activateAdSetCalls).toHaveLength(0);

    const pending = await pool.query(`SELECT kind, meta_ad_set_id, approved_at FROM pending_additions WHERE id = $1`, [result.additionId]);
    expect(pending.rows[0]).toMatchObject({ kind: "ad", meta_ad_set_id: "as_existing_1" });
    expect(pending.rows[0].approved_at).toBeTruthy(); // approved in the same call

    const history = await pool.query(`SELECT action_type FROM action_history WHERE campaign_id = $1 ORDER BY occurred_at`, [campaignId]);
    expect(history.rows.map((r) => r.action_type)).toEqual(["create_ad", "activate_ad"]);
  });

  it("adding an ad is idempotent per additionKey: a resubmit never creates a second ad, a second row, or re-activates", async () => {
    const { campaignId } = await makeExistingCampaign("ad-idem");
    const writer = new FakeAddContentWriter();
    const input = { localCampaignId: campaignId, metaAdAccountId: "act_123", metaCampaignId: "meta_camp_it", metaAdSetId: "as_1",
      pageId: "page_1", name: "Ad", creativeId: "crea_1", additionKey: "same-key" , actor: "customer"};

    const first = await addAdToExistingCampaign(pool, writer, input);
    const second = await addAdToExistingCampaign(pool, writer, input);

    expect(second.additionId).toBe(first.additionId);
    expect(second.metaAdIds).toEqual(first.metaAdIds);
    expect(writer.adCalls).toHaveLength(1);
    const pending = await pool.query(`SELECT id FROM pending_additions WHERE campaign_id = $1`, [campaignId]);
    expect(pending.rows).toHaveLength(1);
    // The re-run sees an already-approved row and no-ops rather than
    // re-activating — the same guard that made the manual approve idempotent.
    expect(second.activation).toEqual({ outcome: "already_approved" });
    expect(writer.activateAdCalls).toHaveLength(1);
  });

  it("adds an ad set + its ads under the existing campaign — never creates a new campaign, activates both levels", async () => {
    const { campaignId } = await makeExistingCampaign("adset-happy");
    const writer = new FakeAddContentWriter();

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
      destination: "whatsapp",
      additionKey: "attempt-2", actor: "customer",
    });

    expect(result.metaAdIds).toHaveLength(2);
    expect(writer.campaignCalls).toHaveLength(0); // the critical assertion — no new campaign
    expect(writer.adSetCalls).toHaveLength(1);
    expect(writer.adSetCalls[0].metaCampaignId).toBe("meta_camp_existing");
    expect(writer.adCalls).toHaveLength(2);

    // A live ad set whose ads stayed paused would spend nothing — both levels.
    expect(result.activation).toEqual({ outcome: "approved" });
    expect(writer.activateAdSetCalls).toEqual([result.metaAdSetId]);
    expect(writer.activateAdCalls).toEqual(result.metaAdIds);

    const history = await pool.query(`SELECT action_type FROM action_history WHERE campaign_id = $1 ORDER BY occurred_at`, [campaignId]);
    expect(history.rows.map((r) => r.action_type)).toEqual([
      "create_ad_set", "create_ad", "create_ad", "activate_ad_set", "activate_ad", "activate_ad",
    ]);
  });

  it("AIC-154: an ad added to an ad set that already has ours continues the numbering", async () => {
    // THE COLLISION. The name used to come from the client, counted per
    // drafting session, so this produced a SECOND "מודעה 1" in an ad set that
    // already had one — and two ads with one name are indistinguishable
    // wherever the name is what identifies them.
    const { campaignId } = await makeExistingCampaign("ad-naming");
    const writer = new FakeAddContentWriter();
    writer.adsOnMeta = [
      { adId: "ad_a", adSetId: "as_existing_1", name: "מודעה 1", effectiveStatus: "ACTIVE", createdTime: null },
      // A different ad set's ad must not shift our numbering.
      { adId: "ad_b", adSetId: "as_other", name: "מודעה 9", effectiveStatus: "ACTIVE", createdTime: null },
    ];

    await addAdToExistingCampaign(pool, writer, {
      localCampaignId: campaignId,
      metaAdAccountId: "act_123",
      metaCampaignId: "meta_camp_it",
      metaAdSetId: "as_existing_1",
      pageId: "page_1",
      name: "whatever the client called it",
      creativeId: "crea_1",
      additionKey: "attempt-naming", actor: "customer",
    });

    expect(writer.adCalls[0].name).toBe("מודעה 2");
  });

  it("AIC-154: a new ad set numbers its own ads from 1, and keeps the customer's set name", async () => {
    const { campaignId } = await makeExistingCampaign("adset-naming");
    const writer = new FakeAddContentWriter();

    const result = await addAdSetToExistingCampaign(pool, writer, {
      localCampaignId: campaignId,
      metaAdAccountId: "act_123",
      metaCampaignId: "meta_camp_existing",
      pageId: "page_1",
      name: "נשים 35-55",
      targeting: { ageMin: 35, ageMax: 55, genders: [2], countries: ["IL"] },
      ads: [
        { clientKey: "ad-1", name: "Ad A", creativeId: "crea_a" },
        { clientKey: "ad-2", name: "Ad B", creativeId: "crea_b" },
      ],
      destination: "whatsapp",
      additionKey: "attempt-adset-naming", actor: "customer",
    });

    expect(writer.adCalls.map((a) => a.name)).toEqual(["מודעה 1", "מודעה 2"]);
    // The ad SET name is the customer's own words — that one they chose, and
    // it is the only name in this flow a person typed on purpose.
    expect(writer.adSetCalls[0].name).toBe("נשים 35-55");
    expect(result.metaAdIds).toHaveLength(2);
  });

  it("a mid-build failure on add-ad-set resumes cleanly: retry only creates what's missing", async () => {
    const { campaignId } = await makeExistingCampaign("adset-resume");
    const writer = new FakeAddContentWriter();
    writer.failNextCreateAd = 1;
    const input = {
      localCampaignId: campaignId, metaAdAccountId: "act_123", metaCampaignId: "meta_camp_existing", pageId: "page_1",
      name: "Set", targeting: { ageMin: 20, ageMax: 40, genders: [], countries: ["IL"] },
      ads: [{ clientKey: "ad-1", name: "Ad A", creativeId: "crea_a" }],
      destination: "whatsapp",
      additionKey: "attempt-3", actor: "customer",
    };

    await expect(addAdSetToExistingCampaign(pool, writer, input)).rejects.toThrow("simulated Meta create-ad failure");
    expect(writer.adSetCalls).toHaveLength(1);
    expect(writer.adCalls).toHaveLength(0);
    // No row yet — only inserted once every create succeeds, so a half-built
    // addition is never activated.
    expect((await pool.query(`SELECT id FROM pending_additions WHERE campaign_id = $1`, [campaignId])).rows).toHaveLength(0);
    expect(writer.activateAdSetCalls).toHaveLength(0);

    const retry = await addAdSetToExistingCampaign(pool, writer, input);
    expect(retry.metaAdIds).toHaveLength(1);
    expect(writer.adSetCalls).toHaveLength(1); // not recreated
    expect(writer.adCalls).toHaveLength(1);
    expect(retry.activation).toEqual({ outcome: "approved" });
  });

  // AIC-106: creates still succeed when the ACTIVATION half fails — the
  // objects exist (paused) and the caller is told so, rather than the whole
  // add being reported as a failure or silently claimed as live.
  it("a create whose activation fails is reported honestly, and retrying activates it", async () => {
    const { campaignId } = await makeExistingCampaign("activate-fail");
    const writer = new FakeAddContentWriter();
    writer.failNextActivateAd = 1;

    const result = await addAdToExistingCampaign(pool, writer, {
      localCampaignId: campaignId, metaAdAccountId: "act_123", metaCampaignId: "meta_camp_it", metaAdSetId: "as_1",
      pageId: "page_1", name: "Ad", creativeId: "crea_1", additionKey: "a-1", actor: "customer",
    });

    expect(result.metaAdIds).toHaveLength(1); // the ad DID get created
    expect(result.activation.outcome).toBe("failed");
    const pending = await pool.query(`SELECT approved_at FROM pending_additions WHERE id = $1`, [result.additionId]);
    expect(pending.rows[0].approved_at).toBeNull();

    const retry = await approveAddition(pool, writer, result.additionId, campaignId);
    expect(retry.outcome).toBe("approved");
  });

  // ── The activation mechanism itself (unchanged by AIC-106) ───────────────
  it("approving is idempotent: a second approval is a no-op, never double-activates or double-logs", async () => {
    const { campaignId } = await makeExistingCampaign("approve-idem");
    const writer = new FakeAddContentWriter();
    const added = await addAdToExistingCampaign(pool, writer, {
      localCampaignId: campaignId, metaAdAccountId: "act_123", metaCampaignId: "meta_camp_it", metaAdSetId: "as_1",
      pageId: "page_1", name: "Ad", creativeId: "crea_1", additionKey: "a-1", actor: "customer",
    });

    // Already activated by the create itself; a further call must no-op.
    const second = await approveAddition(pool, writer, added.additionId, campaignId);

    expect(added.activation.outcome).toBe("approved");
    expect(second).toEqual({ outcome: "already_approved" });
    expect(writer.activateAdCalls).toHaveLength(1);
  });

  it("ownership: approving with the wrong campaignId is refused as not_found", async () => {
    const a = await makeExistingCampaign("owner-a");
    const b = await makeExistingCampaign("owner-b");
    const writer = new FakeAddContentWriter();
    const added = await addAdToExistingCampaign(pool, writer, {
      localCampaignId: a.campaignId, metaAdAccountId: "act_123", metaCampaignId: "meta_camp_it", metaAdSetId: "as_1",
      pageId: "page_1", name: "Ad", creativeId: "crea_1", additionKey: "a-1", actor: "customer",
    });
    const otherWriter = new FakeAdditionWriter();

    const stolen = await approveAddition(pool, otherWriter, added.additionId, b.campaignId);

    expect(stolen.outcome).toBe("not_found");
    expect(otherWriter.activateAdCalls).toHaveLength(0);
  });

  // AIC-137, found live: every addition read "בוצע על ידינו" — us — for ads the
  // CUSTOMER had just added from their own dashboard. approved_by was written
  // NULL, and actorOf reads NULL-with-human_involved as "a human did it and it
  // was not the customer's dashboard". Right default, wrong answer here.
  it("attributes an addition to whoever actually did it", async () => {
    const { campaignId } = await makeExistingCampaign("actor");
    const writer = new FakeAddContentWriter();
    await addAdToExistingCampaign(pool, writer, {
      localCampaignId: campaignId, metaAdAccountId: "act_123", metaCampaignId: "meta_camp_it",
      metaAdSetId: "as_existing_1",
      pageId: "page_1", name: "Ad", creativeId: "cr_1", additionKey: "k-actor",
      actor: "customer",
    });

    const { rows } = await pool.query<{ approved_by: string | null; human_involved: boolean }>(
      `SELECT approved_by, human_involved FROM action_history
        WHERE campaign_id = $1 AND action_type = 'create_ad'`,
      [campaignId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].approved_by).toBe("customer");
    // The projection the dashboard actually reads.
    expect(actorOf(rows[0].human_involved, rows[0].approved_by)).toBe("customer");
  });
});
