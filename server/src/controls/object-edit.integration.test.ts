// DB integration for editing an ad set / renaming an ad (AIC-185).
// The case that matters is the read-back: Meta answering 200 and storing
// something else must NEVER be reported to the customer as a success.
import { describe, it, expect, afterAll } from "vitest";
import { pool } from "../db/pool.js";
import { editAdSet, editAdName } from "./object-edit.js";
import type { AdSetDetail } from "../meta/ad-set-detail.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

async function seed(tag: string): Promise<{ campaignId: string }> {
  const cust = await pool.query<{ id: string }>(
    `INSERT INTO customers (business_name, is_test) VALUES ($1, true) RETURNING id`, [`__it_edit_${tag}`],
  );
  const conn = await pool.query<{ id: string }>(
    `INSERT INTO meta_connections (customer_id, system_user_id, access_health) VALUES ($1,'9','ok') RETURNING id`,
    [cust.rows[0].id],
  );
  const acct = await pool.query<{ id: string }>(
    `INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`,
    [conn.rows[0].id, `act_edit_${conn.rows[0].id.slice(0, 8)}`],
  );
  const camp = await pool.query<{ id: string }>(
    `INSERT INTO managed_campaigns (customer_id, ad_account_id, meta_campaign_id, name, status, agreed_budget_agorot)
     VALUES ($1,$2,'m_edit','C','active',3000) RETURNING id`,
    [cust.rows[0].id, acct.rows[0].id],
  );
  return { campaignId: camp.rows[0].id };
}

const detail = (over: Partial<AdSetDetail> = {}): AdSetDetail => ({
  adSetId: "as_1", name: "לפני", ageMin: 18, ageMax: 65, genders: "all",
  places: [], placement: "advantage", dailyBudgetAgorot: null, createdAt: null, ...over,
});

const history = async (campaignId: string) =>
  (await pool.query<{ action_type: string; result: string }>(
    `SELECT action_type, result FROM action_history WHERE campaign_id = $1 ORDER BY occurred_at`, [campaignId],
  )).rows;

// ONE teardown for the whole file: pool.end() inside the first describe closed
// the pool before the second ever ran.
if (HAS_DB) {
  afterAll(async () => {
    await pool.query(`DELETE FROM customers WHERE business_name LIKE '__it_edit_%'`);
    await pool.end();
  });
}

d("editAdSet (DB)", () => {
  it("applies the edit, preserves untouched targeting, and logs a success", async () => {
    const { campaignId } = await seed("ok");
    let sent: Record<string, unknown> | undefined;
    const writer = {
      getAdSetDetail: async () => detail({ ageMin: 25, ageMax: 45 }),
      // Meta's own object, including a key this code does not model.
      getAdSetRawTargeting: async () => ({ age_min: 18, age_max: 65, targeting_automation: { advantage_audience: 1 } }),
      updateAdSet: async (_id: string, f: { targeting?: Record<string, unknown> }) => { sent = f.targeting; },
    };
    const r = await editAdSet({
      pool, writer, campaignId, metaAdSetId: "as_1",
      patch: { ageMin: 25, ageMax: 45 }, actor: { kind: "customer", label: "c" },
    });
    expect(r.outcome).toBe("changed");
    // Meta REPLACES targeting, so anything not copied forward is destroyed.
    expect(sent).toMatchObject({ age_min: 25, age_max: 45, targeting_automation: { advantage_audience: 1 } });
    expect(await history(campaignId)).toEqual([{ action_type: "edit_ad_set", result: "success" }]);
  });

  it("reports NOT APPLIED when Meta stores something else, and logs it as failed", async () => {
    // The lived case: age 20–35 was sent, Meta answered 200, and 18–65 was
    // what it stored. Reporting that as success is the product lying about
    // the customer's own money.
    const { campaignId } = await seed("mismatch");
    const writer = {
      getAdSetDetail: async () => detail({ ageMin: 18, ageMax: 65 }),
      getAdSetRawTargeting: async () => ({}),
      updateAdSet: async () => {},
    };
    const r = await editAdSet({
      pool, writer, campaignId, metaAdSetId: "as_1",
      patch: { ageMin: 20, ageMax: 35 }, actor: { kind: "customer", label: "c" },
    });
    expect(r.outcome).toBe("not_applied");
    expect(r.mismatches).toEqual([
      { field: "ageMin", asked: "20", stored: "18" },
      { field: "ageMax", asked: "35", stored: "65" },
    ]);
    expect(await history(campaignId)).toEqual([{ action_type: "edit_ad_set", result: "failed" }]);
  });

  it("refuses an invalid range before touching Meta at all", async () => {
    const { campaignId } = await seed("invalid");
    let called = false;
    const writer = {
      getAdSetDetail: async () => detail(),
      getAdSetRawTargeting: async () => ({}),
      updateAdSet: async () => { called = true; },
    };
    const r = await editAdSet({
      pool, writer, campaignId, metaAdSetId: "as_1",
      patch: { ageMin: 50, ageMax: 30 }, actor: { kind: "customer", label: "c" },
    });
    expect(r).toEqual({ outcome: "invalid", problem: "age_inverted" });
    expect(called).toBe(false);
    // Nothing attempted means nothing to audit.
    expect(await history(campaignId)).toEqual([]);
  });

  it("logs a failed write without claiming it worked", async () => {
    const { campaignId } = await seed("throws");
    const writer = {
      getAdSetDetail: async () => detail(),
      getAdSetRawTargeting: async () => ({}),
      updateAdSet: async () => { throw new Error("meta said no"); },
    };
    const r = await editAdSet({
      pool, writer, campaignId, metaAdSetId: "as_1",
      patch: { name: "אחרי" }, actor: { kind: "customer", label: "c" },
    });
    expect(r.outcome).toBe("failed");
    expect(await history(campaignId)).toEqual([{ action_type: "edit_ad_set", result: "failed" }]);
  });
});

d("editAdName (DB)", () => {
  it("renames, verifies by re-reading, and logs", async () => {
    const { campaignId } = await seed("adname");
    let stored = "מודעה 1";
    const writer = {
      getAdName: async () => stored,
      updateAd: async (_id: string, f: { name: string }) => { stored = f.name; },
    };
    const r = await editAdName({
      pool, writer, campaignId, metaAdId: "ad_1", name: "  מודעה חדשה  ",
      actor: { kind: "customer", label: "c" },
    });
    expect(r.outcome).toBe("changed");
    expect(stored).toBe("מודעה חדשה"); // trimmed
    expect(await history(campaignId)).toEqual([{ action_type: "edit_ad", result: "success" }]);
  });

  it("refuses an empty name without calling Meta", async () => {
    const { campaignId } = await seed("adempty");
    let called = false;
    const writer = { getAdName: async () => "x", updateAd: async () => { called = true; } };
    const r = await editAdName({
      pool, writer, campaignId, metaAdId: "ad_1", name: "   ",
      actor: { kind: "customer", label: "c" },
    });
    expect(r).toEqual({ outcome: "invalid", problem: "empty_name" });
    expect(called).toBe(false);
  });
});
