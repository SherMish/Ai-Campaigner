// DB integration for manual object controls (AIC-66). Requires DATABASE_URL.
import { describe, it, expect, afterAll } from "vitest";
import { pool } from "../db/pool.js";
import { FakeControlWriter } from "./types.js";
import { setObjectStatus, assertOwnedByCampaign } from "./manual-controls.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

async function seedCampaign(tag: string): Promise<string> {
  const cust = await pool.query<{ id: string }>(
    `INSERT INTO customers (business_name, is_test) VALUES ($1, true) RETURNING id`,
    [`__it_ctl_${tag}`],
  );
  const conn = await pool.query<{ id: string }>(
    `INSERT INTO meta_connections (customer_id, access_health) VALUES ($1,'ok') RETURNING id`,
    [cust.rows[0].id],
  );
  const acct = await pool.query<{ id: string }>(
    `INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`,
    [conn.rows[0].id, `act_ctl_${conn.rows[0].id.slice(0, 8)}`],
  );
  const camp = await pool.query<{ id: string }>(
    `INSERT INTO managed_campaigns (customer_id, ad_account_id, meta_campaign_id, name, status)
     VALUES ($1,$2,'meta_camp_ctl','C','active') RETURNING id`,
    [cust.rows[0].id, acct.rows[0].id],
  );
  return camp.rows[0].id;
}

async function history(campaignId: string) {
  const { rows } = await pool.query(
    `SELECT action_type, target_meta_id, previous_state, new_state, approved_by, human_involved, result
     FROM action_history WHERE campaign_id = $1 ORDER BY occurred_at ASC, action_type ASC`,
    [campaignId],
  );
  return rows;
}

const CUSTOMER = { kind: "customer" as const, label: "customer" };
const OPERATOR = { kind: "operator" as const, label: "ops@example.com" };

d("manual controls (AIC-66)", () => {
  afterAll(async () => {
    await pool.query(`DELETE FROM customers WHERE business_name LIKE '__it_ctl_%'`);
    await pool.end();
  });

  it("pauses an ad, verifies the read-back, and logs it as a human action", async () => {
    const campaignId = await seedCampaign("pause");
    const writer = new FakeControlWriter();
    writer.statuses.set("ad_1", "ACTIVE");

    const res = await setObjectStatus({
      pool, writer, campaignId, kind: "ad", metaObjectId: "ad_1", status: "PAUSED", actor: CUSTOMER,
    });

    expect(res).toMatchObject({ outcome: "changed", previousStatus: "ACTIVE", newStatus: "PAUSED" });
    expect(writer.setAdCalls).toEqual([{ id: "ad_1", status: "PAUSED" }]);

    const rows = await history(campaignId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action_type: "pause_ad", target_meta_id: "ad_1",
      approved_by: "customer", human_involved: true, result: "success",
    });
    expect(rows[0].previous_state).toEqual({ status: "ACTIVE" });
    expect(rows[0].new_state).toEqual({ status: "PAUSED" });
  });

  it("resuming is the reverse and is recorded distinctly from a pause", async () => {
    const campaignId = await seedCampaign("resume");
    const writer = new FakeControlWriter();
    writer.statuses.set("as_1", "PAUSED");

    const res = await setObjectStatus({
      pool, writer, campaignId, kind: "ad_set", metaObjectId: "as_1", status: "ACTIVE", actor: CUSTOMER,
    });

    expect(res.outcome).toBe("changed");
    expect(writer.setAdSetCalls).toEqual([{ id: "as_1", status: "ACTIVE" }]);
    expect((await history(campaignId))[0]).toMatchObject({ action_type: "resume_ad_set", result: "success" });
  });

  it("is idempotent: already at the target status → no write, no duplicate log", async () => {
    const campaignId = await seedCampaign("idem");
    const writer = new FakeControlWriter();
    writer.statuses.set("ad_1", "PAUSED");

    const res = await setObjectStatus({
      pool, writer, campaignId, kind: "ad", metaObjectId: "ad_1", status: "PAUSED", actor: CUSTOMER,
    });

    expect(res.outcome).toBe("already");
    expect(writer.setAdCalls).toEqual([]);
    expect(await history(campaignId)).toHaveLength(0);
  });

  it("a write Meta accepts but doesn't apply is reported as failed, not success", async () => {
    const campaignId = await seedCampaign("noapply");
    const writer = new FakeControlWriter();
    writer.statuses.set("ad_1", "ACTIVE");
    writer.ignoreNextWrite = 1; // accepted, never applied

    const res = await setObjectStatus({
      pool, writer, campaignId, kind: "ad", metaObjectId: "ad_1", status: "PAUSED", actor: CUSTOMER,
    });

    expect(res.outcome).toBe("failed");
    expect(res.detail).toMatch(/still reads/);
    expect((await history(campaignId))[0]).toMatchObject({ action_type: "pause_ad", result: "failed" });
  });

  it("a failed Meta write logs the failure and never claims success", async () => {
    const campaignId = await seedCampaign("failed");
    const writer = new FakeControlWriter();
    writer.statuses.set("as_1", "ACTIVE");
    writer.failNextWrite = 1;

    const res = await setObjectStatus({
      pool, writer, campaignId, kind: "ad_set", metaObjectId: "as_1", status: "PAUSED", actor: OPERATOR,
    });

    expect(res.outcome).toBe("failed");
    expect((await history(campaignId))[0]).toMatchObject({ action_type: "pause_ad_set", result: "failed", approved_by: "ops@example.com" });
  });

  it("records WHO acted, so the customer history can distinguish self from operator", async () => {
    const campaignId = await seedCampaign("actor");
    const writer = new FakeControlWriter();
    writer.statuses.set("ad_1", "ACTIVE");
    await setObjectStatus({ pool, writer, campaignId, kind: "ad", metaObjectId: "ad_1", status: "PAUSED", actor: OPERATOR });

    const rows = await history(campaignId);
    expect(rows[0].approved_by).toBe("ops@example.com");
    expect(rows[0].human_involved).toBe(true); // never an "automated" change
  });

  it("archive and delete map to their own action types (admin-only paths)", async () => {
    const campaignId = await seedCampaign("archive");
    const writer = new FakeControlWriter();
    writer.statuses.set("as_1", "PAUSED");
    writer.statuses.set("ad_1", "PAUSED");

    await setObjectStatus({ pool, writer, campaignId, kind: "ad_set", metaObjectId: "as_1", status: "ARCHIVED", actor: OPERATOR });
    await setObjectStatus({ pool, writer, campaignId, kind: "ad", metaObjectId: "ad_1", status: "DELETED", actor: OPERATOR });

    const types = (await history(campaignId)).map((r) => r.action_type);
    expect(types).toEqual(["archive_ad_set", "delete_ad"]);
  });

  it("a DELETED object that stops being readable still counts as applied", async () => {
    const campaignId = await seedCampaign("gone");
    const writer = new FakeControlWriter();
    writer.statuses.set("ad_1", "PAUSED");
    // after the delete, reads throw — Meta often stops serving the object
    const realGet = writer.getAdStatus.bind(writer);
    let calls = 0;
    writer.getAdStatus = async (id: string) => {
      calls++;
      if (calls > 1) throw new Error("(#100) object does not exist");
      return realGet(id);
    };

    const res = await setObjectStatus({
      pool, writer, campaignId, kind: "ad", metaObjectId: "ad_1", status: "DELETED", actor: OPERATOR,
    });
    expect(res.outcome).toBe("changed");
  });

  describe("ownership (a client-supplied Meta id is never trusted)", () => {
    it("accepts an object that really lives under the caller's campaign", async () => {
      const writer = new FakeControlWriter();
      writer.campaignAds = ["ad_mine"];
      writer.campaignAdSets = ["as_mine"];
      expect(await assertOwnedByCampaign(writer, "meta_camp_ctl", "ad", "ad_mine")).toBe(true);
      expect(await assertOwnedByCampaign(writer, "meta_camp_ctl", "ad_set", "as_mine")).toBe(true);
    });

    it("rejects an id from someone else's campaign", async () => {
      const writer = new FakeControlWriter();
      writer.campaignAds = ["ad_mine"];
      expect(await assertOwnedByCampaign(writer, "meta_camp_ctl", "ad", "ad_someone_else")).toBe(false);
    });

    it("doesn't confuse an ad id with an ad-set id", async () => {
      const writer = new FakeControlWriter();
      writer.campaignAds = ["ad_1"];
      writer.campaignAdSets = ["as_1"];
      expect(await assertOwnedByCampaign(writer, "meta_camp_ctl", "ad_set", "ad_1")).toBe(false);
    });
  });
});
