// AIC-128: the customer's "remove this ad" — hidden on our side, untouched on
// Meta. Requires DATABASE_URL; self-skips otherwise.
//
// THE POINT OF THIS FILE is the arithmetic. Hiding is a presentation filter,
// so every total in the product must be byte-identical before and after, and
// the difference between an ad set's total and the rows shown under it must be
// fully accounted for. A remove that quietly changed a number would be worse
// than no remove at all.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { pool } from "../db/pool.js";
import { PgSnapshotStore } from "../meta/snapshot-store.js";
import { upsertAdSetMeta } from "./audience-meta-cache.js";
import { upsertAdMeta } from "./ad-meta-cache.js";
import { buildCampaignAudiences } from "./campaign-audiences.js";
import { buildCampaignReadout } from "./readout.js";
import { hideAd, unhideAd, listHiddenAds } from "../controls/hidden-ads.js";
import { FakeControlWriter } from "../controls/types.js";
import type { SnapshotUpsert } from "../meta/insights.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;
const TODAY = new Date().toISOString().slice(0, 10);

async function seedChain(tag: string) {
  const cust = await pool.query<{ id: string }>(
    `INSERT INTO customers (business_name, is_test, onboarding_status) VALUES ($1, true, 'ready') RETURNING id`,
    [`__it_hid_${tag}`],
  );
  const customerId = cust.rows[0].id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO app_users (email, password_hash, name, customer_id) VALUES ($1,'x','Owner',$2) RETURNING id`,
    [`__it_hid_${tag}@example.com`, customerId],
  );
  const conn = await pool.query<{ id: string }>(
    `INSERT INTO meta_connections (customer_id, system_user_id, access_health) VALUES ($1,'9','ok') RETURNING id`,
    [customerId],
  );
  const acct = await pool.query<{ id: string }>(
    `INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`,
    [conn.rows[0].id, `act_hid_${conn.rows[0].id.slice(0, 8)}`],
  );
  const camp = await pool.query<{ id: string }>(
    `INSERT INTO managed_campaigns (customer_id, ad_account_id, meta_campaign_id, name, status, agreed_budget_agorot)
     VALUES ($1,$2,$3,'IT Campaign','active',10000) RETURNING id`,
    [customerId, acct.rows[0].id, `meta_hid_${tag}`],
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

// Two ads under one ad set, whose ad-set total is deliberately the exact sum of
// the two, so any drift in the totals shows up as a failed assertion rather
// than as a plausible-looking number.
async function seedTwoAds(tag: string) {
  const chain = await seedChain(tag);
  const store = new PgSnapshotStore(pool);
  await store.upsert([
    snap(chain.campaignId, { grain: "campaign", metaObjectId: `meta_hid_${tag}`, spendAgorot: 30000, leads: 9, cplAgorot: 3333 }),
    snap(chain.campaignId, { grain: "adset", metaObjectId: "as_h", spendAgorot: 30000, leads: 9, cplAgorot: 3333 }),
    snap(chain.campaignId, { grain: "creative", metaObjectId: "ad_keep", parentMetaId: "as_h", creativeName: "Keep", spendAgorot: 20000, leads: 6, cplAgorot: 3333 }),
    snap(chain.campaignId, { grain: "creative", metaObjectId: "ad_gone", parentMetaId: "as_h", creativeName: "Gone", spendAgorot: 10000, leads: 3, cplAgorot: 3333 }),
  ]);
  await upsertAdSetMeta(pool, chain.campaignId, [
    { adSetId: "as_h", name: "Set H", ageMin: 18, ageMax: 45, genders: "all", geoSummary: "", isDynamicCreative: false },
  ]);
  await upsertAdMeta(pool, chain.campaignId, [
    { adId: "ad_keep", adSetId: "as_h", name: "Keep", effectiveStatus: "ACTIVE", createdTime: null },
    { adId: "ad_gone", adSetId: "as_h", name: "Gone", effectiveStatus: "PAUSED", createdTime: null },
  ]);
  return chain;
}

function pausedWriter(...pausedIds: string[]) {
  const w = new FakeControlWriter();
  for (const id of pausedIds) w.statuses.set(id, "PAUSED");
  return w;
}

d("hidden ads (AIC-128)", () => {
  beforeAll(() => { process.env.JWT_SECRET ||= "test-secret-hidden"; });
  afterAll(async () => {
    await pool.query(`DELETE FROM app_users WHERE email LIKE '__it_hid_%'`);
    await pool.query(`DELETE FROM customers WHERE business_name LIKE '__it_hid_%'`);
    await pool.end();
  });

  describe("the numbers do not move", () => {
    it("removes the row, leaves every total identical, and accounts for the gap", async () => {
      const { userId, campaignId } = await seedTwoAds("nums");

      const before = (await buildCampaignAudiences(pool, userId))!.audiences[0];
      expect(before.creatives.map((c) => c.metaObjectId).sort()).toEqual(["ad_gone", "ad_keep"]);
      expect(before.spendAgorot).toBe(30000);
      expect(before.leads).toBe(9);

      const outcome = await hideAd({
        pool, writer: pausedWriter("ad_gone"), campaignId, metaAdId: "ad_gone", actorLabel: "customer",
      });
      expect(outcome).toBe("hidden");

      const after = (await buildCampaignAudiences(pool, userId))!.audiences[0];

      // The row is gone from the customer's view...
      expect(after.creatives.map((c) => c.metaObjectId)).toEqual(["ad_keep"]);

      // ...and THE AD SET'S OWN TOTALS ARE UNCHANGED. This is the guarantee:
      // hiding is a view filter, and money already spent is still money spent.
      expect(after.spendAgorot).toBe(before.spendAgorot);
      expect(after.leads).toBe(before.leads);
      expect(after.cplAgorot).toBe(before.cplAgorot);

      // The difference between the total and the visible rows is reported
      // exactly, so the arithmetic on screen still closes.
      expect(after.removedCreativesCount).toBe(1);
      expect(after.removedSpendAgorot).toBe(10000);
      expect(after.removedLeads).toBe(3);
      const shownSpend = after.creatives.reduce((n, c) => n + c.spendAgorot, 0);
      const shownLeads = after.creatives.reduce((n, c) => n + c.leads, 0);
      expect(shownSpend + after.removedSpendAgorot).toBe(after.spendAgorot);
      expect(shownLeads + after.removedLeads).toBe(after.leads);
    });

    it("leaves the stored snapshot rows completely untouched", async () => {
      const { userId, campaignId } = await seedTwoAds("snaps");
      const rowsBefore = await pool.query(
        `SELECT count(*)::int AS n, COALESCE(SUM(spend_agorot),0)::int AS spend
           FROM insight_snapshots WHERE campaign_id = $1`, [campaignId]);

      await hideAd({ pool, writer: pausedWriter("ad_gone"), campaignId, metaAdId: "ad_gone", actorLabel: "customer" });
      await buildCampaignAudiences(pool, userId);

      const rowsAfter = await pool.query(
        `SELECT count(*)::int AS n, COALESCE(SUM(spend_agorot),0)::int AS spend
           FROM insight_snapshots WHERE campaign_id = $1`, [campaignId]);
      // Ingestion is the source of every number in the product. If hiding
      // could reach it, every historical figure would be rewritable from the
      // UI — so this is the load-bearing assertion, not a formality.
      expect(rowsAfter.rows[0]).toEqual(rowsBefore.rows[0]);
    });
  });

  describe("the operator's view is not filtered", () => {
    it("keeps the removed ad, with its numbers, in the admin readout", async () => {
      // A removal is a CUSTOMER preference. Operators debug against Meta's
      // truth, and a support call that starts "my ad disappeared" is
      // unanswerable if the operator's own view disappeared it too.
      //
      // This holds structurally: the admin readout's perCreative comes from
      // store.creativeStats, a different method that never consults hidden_ads.
      // The test pins that separation so a future refactor merging the two
      // read paths has to notice it.
      const { campaignId } = await seedTwoAds("adminview");
      const before = await buildCampaignReadout(pool, campaignId);
      await hideAd({ pool, writer: pausedWriter("ad_gone"), campaignId, metaAdId: "ad_gone", actorLabel: "customer" });
      const after = await buildCampaignReadout(pool, campaignId);

      expect(after!.perCreative.map((c) => c.metaObjectId).sort())
        .toEqual(before!.perCreative.map((c) => c.metaObjectId).sort());
      expect(after!.current).toEqual(before!.current);
    });
  });

  describe("pause-first is a rule, not a disabled button", () => {
    it("refuses to hide an ad that is still ACTIVE on Meta", async () => {
      const { campaignId } = await seedTwoAds("active");
      // FakeControlWriter reports ACTIVE for anything not explicitly paused.
      const outcome = await hideAd({
        pool, writer: new FakeControlWriter(), campaignId, metaAdId: "ad_keep", actorLabel: "customer",
      });
      // Removing a running ad from view would leave it invisible AND still
      // spending — the one genuinely costly mistake this surface allows.
      expect(outcome).toBe("not_paused");
      expect(await listHiddenAds(pool, campaignId)).toHaveLength(0);
    });

    it("allows hiding one already archived at Meta by an operator", async () => {
      const { campaignId } = await seedTwoAds("arch");
      const w = new FakeControlWriter();
      w.statuses.set("ad_gone", "ARCHIVED");
      expect(await hideAd({ pool, writer: w, campaignId, metaAdId: "ad_gone", actorLabel: "customer" })).toBe("hidden");
    });
  });

  describe("restore", () => {
    it("brings the row and its numbers back", async () => {
      const { userId, campaignId } = await seedTwoAds("restore");
      await hideAd({ pool, writer: pausedWriter("ad_gone"), campaignId, metaAdId: "ad_gone", actorLabel: "customer" });

      expect(await unhideAd({ pool, campaignId, metaAdId: "ad_gone", actorLabel: "customer" })).toBe("restored");

      const back = (await buildCampaignAudiences(pool, userId))!.audiences[0];
      expect(back.creatives.map((c) => c.metaObjectId).sort()).toEqual(["ad_gone", "ad_keep"]);
      expect(back.removedCreativesCount).toBe(0);
      expect(back.removedSpendAgorot).toBe(0);
    });

    it("is idempotent in both directions", async () => {
      const { campaignId } = await seedTwoAds("idem");
      const w = pausedWriter("ad_gone");
      expect(await hideAd({ pool, writer: w, campaignId, metaAdId: "ad_gone", actorLabel: "customer" })).toBe("hidden");
      expect(await hideAd({ pool, writer: w, campaignId, metaAdId: "ad_gone", actorLabel: "customer" })).toBe("already_hidden");
      expect(await unhideAd({ pool, campaignId, metaAdId: "ad_gone", actorLabel: "customer" })).toBe("restored");
      expect(await unhideAd({ pool, campaignId, metaAdId: "ad_gone", actorLabel: "customer" })).toBe("not_hidden");
    });
  });

  describe("the other ways an ad can reach the list", () => {
    it("does not resurrect a hidden ad that never recorded any data", async () => {
      // campaign-audiences merges ads that exist on Meta but have no insight
      // row (the 2026-08-22 fix). Without hiding applied in that loop too, an
      // ad removed before it ever spent would reappear immediately.
      const { userId, campaignId } = await seedTwoAds("nodata");
      await upsertAdMeta(pool, campaignId, [
        { adId: "ad_keep", adSetId: "as_h", name: "Keep", effectiveStatus: "ACTIVE", createdTime: null },
        { adId: "ad_gone", adSetId: "as_h", name: "Gone", effectiveStatus: "PAUSED", createdTime: null },
        { adId: "ad_new", adSetId: "as_h", name: "New", effectiveStatus: "PAUSED", createdTime: null },
      ]);
      await hideAd({ pool, writer: pausedWriter("ad_new"), campaignId, metaAdId: "ad_new", actorLabel: "customer" });

      const row = (await buildCampaignAudiences(pool, userId))!.audiences[0];
      expect(row.creatives.map((c) => c.metaObjectId).sort()).toEqual(["ad_gone", "ad_keep"]);
      // It is listed as removed, so the customer can still find and restore it...
      expect(row.removedCreatives.map((c) => c.metaObjectId)).toEqual(["ad_new"]);
      // ...but it must NOT inflate the removed MONEY, which exists to explain a
      // gap in the arithmetic. It never spent anything, so there is no gap.
      expect(row.removedSpendAgorot).toBe(0);
      expect(row.removedLeads).toBe(0);
    });

    it("does not advertise a hidden ad through moreCreativesCount", async () => {
      // "N more with data from another period" would name the very row the
      // customer asked us to stop showing, and double-report it next to the
      // hidden note.
      const { userId, campaignId } = await seedTwoAds("morecount");
      const store = new PgSnapshotStore(pool);
      const old = "2020-01-05";
      await store.upsert([
        { campaignId, grain: "creative", metaObjectId: "ad_old", parentMetaId: "as_h", creativeName: "Old",
          periodStart: old, periodEnd: old, spendAgorot: 5000, leads: 1, cplAgorot: 5000,
          impressions: 0, linkClicks: 0, deliveryStatus: "active", raw: {} },
      ]);
      const withOld = (await buildCampaignAudiences(pool, userId, "day"))!.audiences[0];
      expect(withOld.moreCreativesCount).toBe(1);

      await hideAd({ pool, writer: pausedWriter("ad_old"), campaignId, metaAdId: "ad_old", actorLabel: "customer" });
      const hidden = (await buildCampaignAudiences(pool, userId, "day"))!.audiences[0];
      expect(hidden.moreCreativesCount).toBe(0);
    });
  });

  describe("an ad archived or deleted at Meta leaves the view too", () => {
    it("drops out of the default list once Meta stops reporting it", async () => {
      const { userId, campaignId } = await seedTwoAds("metagone");
      const before = (await buildCampaignAudiences(pool, userId))!.audiences[0];
      expect(before.creatives.map((c) => c.metaObjectId).sort()).toEqual(["ad_gone", "ad_keep"]);

      // What an operator archiving at Meta actually looks like from here: the
      // ad simply stops appearing in {campaign}/ads on the next tick.
      await upsertAdMeta(pool, campaignId, [
        { adId: "ad_keep", adSetId: "as_h", name: "Keep", effectiveStatus: "ACTIVE", createdTime: null },
      ]);

      const after = (await buildCampaignAudiences(pool, userId))!.audiences[0];
      expect(after.creatives.map((c) => c.metaObjectId)).toEqual(["ad_keep"]);
      expect(after.removedCreatives.map((c) => c.metaObjectId)).toEqual(["ad_gone"]);
      // Not restorable, and labelled as such — Meta has no un-archive, so a
      // restore button here would be a button that cannot work.
      expect(after.removedCreatives[0].removed).toBe("gone_at_meta");
      // The totals still hold, exactly as with a customer-removed ad.
      expect(after.spendAgorot).toBe(before.spendAgorot);
      expect(after.removedSpendAgorot).toBe(10000);
    });

    it("brings it back if Meta reports it again (a transient miss self-heals)", async () => {
      const { userId, campaignId } = await seedTwoAds("selfheal");
      await upsertAdMeta(pool, campaignId, [
        { adId: "ad_keep", adSetId: "as_h", name: "Keep", effectiveStatus: "ACTIVE", createdTime: null },
      ]);
      expect((await buildCampaignAudiences(pool, userId))!.audiences[0].removedCreativesCount).toBe(1);

      // The old hard-DELETE prune could not do this: it threw the row away, so
      // a blip or a pagination edge was indistinguishable from a real deletion.
      await upsertAdMeta(pool, campaignId, [
        { adId: "ad_keep", adSetId: "as_h", name: "Keep", effectiveStatus: "ACTIVE", createdTime: null },
        { adId: "ad_gone", adSetId: "as_h", name: "Gone", effectiveStatus: "PAUSED", createdTime: null },
      ]);
      const healed = (await buildCampaignAudiences(pool, userId))!.audiences[0];
      expect(healed.creatives.map((c) => c.metaObjectId).sort()).toEqual(["ad_gone", "ad_keep"]);
      expect(healed.removedCreativesCount).toBe(0);
    });

    it("reports gone_at_meta, not by_customer, when both apply", async () => {
      // If a customer removed it and an operator later archived it at Meta, the
      // restore button must disappear — restoring would put back a row for an
      // object that no longer exists.
      const { userId, campaignId } = await seedTwoAds("both");
      await hideAd({ pool, writer: pausedWriter("ad_gone"), campaignId, metaAdId: "ad_gone", actorLabel: "customer" });
      await upsertAdMeta(pool, campaignId, [
        { adId: "ad_keep", adSetId: "as_h", name: "Keep", effectiveStatus: "ACTIVE", createdTime: null },
      ]);
      const row = (await buildCampaignAudiences(pool, userId))!.audiences[0];
      expect(row.removedCreatives[0].removed).toBe("gone_at_meta");
    });
  });

  it("writes an honest action_history row that does not claim a Meta change", async () => {
    const { campaignId } = await seedTwoAds("history");
    await hideAd({ pool, writer: pausedWriter("ad_gone"), campaignId, metaAdId: "ad_gone", actorLabel: "customer" });
    const { rows } = await pool.query<{ action_type: string; new_state: unknown }>(
      `SELECT action_type, new_state FROM action_history WHERE campaign_id = $1 AND target_meta_id = 'ad_gone'`,
      [campaignId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].action_type).toBe("hide_ad");
    // The Meta status is deliberately unchanged, so the history records our
    // VISIBILITY — claiming a status transition here would be a lie.
    expect(rows[0].new_state).toEqual({ hidden: true });
  });
});
