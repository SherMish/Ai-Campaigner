// DB integration for multi-campaign selection (AIC-186). The case that matters
// is the one that leaks: another customer's campaign id must never resolve.
import { describe, it, expect, afterAll } from "vitest";
import { pool } from "../db/pool.js";
import { resolveOwnedCampaign, listOwnedCampaigns } from "./campaign-selection.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

async function seedCustomer(tag: string, campaigns: Array<{ name: string; destination: string }>) {
  const cust = await pool.query<{ id: string }>(
    `INSERT INTO customers (business_name, is_test) VALUES ($1, true) RETURNING id`, [`__it_sel_${tag}`],
  );
  const customerId = cust.rows[0].id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO app_users (email, password_hash, name, customer_id) VALUES ($1,'x','U',$2) RETURNING id`,
    [`__it_sel_${tag}@example.com`, customerId],
  );
  const conn = await pool.query<{ id: string }>(
    `INSERT INTO meta_connections (customer_id, system_user_id, access_health) VALUES ($1,'9','ok') RETURNING id`,
    [customerId],
  );
  const acct = await pool.query<{ id: string }>(
    `INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`,
    [conn.rows[0].id, `act_sel_${conn.rows[0].id.slice(0, 8)}`],
  );
  const ids: string[] = [];
  for (const [i, c] of campaigns.entries()) {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO managed_campaigns (customer_id, ad_account_id, meta_campaign_id, name, status, agreed_budget_agorot, destination, created_at)
       VALUES ($1,$2,$3,$4,'active',3000,$5, now() + ($6 || ' seconds')::interval) RETURNING id`,
      [customerId, acct.rows[0].id, `m_${tag}_${i}`, c.name, c.destination, String(i)],
    );
    ids.push(r.rows[0].id);
  }
  return { userId: user.rows[0].id, campaignIds: ids };
}

d("campaign selection (DB)", () => {
  afterAll(async () => {
    await pool.query(`DELETE FROM app_users WHERE email LIKE '__it_sel_%'`);
    await pool.query(`DELETE FROM customers WHERE business_name LIKE '__it_sel_%'`);
    await pool.end();
  });

  it("holds TWO campaigns for one customer — the constraint this ticket dropped", async () => {
    const { userId, campaignIds } = await seedCustomer("two", [
      { name: "WhatsApp", destination: "whatsapp" },
      { name: "Engagement", destination: "engagement" },
    ]);
    expect(campaignIds).toHaveLength(2);
    const list = await listOwnedCampaigns(pool, userId);
    expect(list.map((c) => c.destination)).toEqual(["whatsapp", "engagement"]);
    // The first is the default, and stays the default when a second is added —
    // otherwise the dashboard silently switches under the customer.
    expect(list.map((c) => c.isDefault)).toEqual([true, false]);
  });

  it("returns the OLDEST campaign when none is named, matching the old LIMIT 1", async () => {
    const { userId, campaignIds } = await seedCustomer("default", [
      { name: "First", destination: "whatsapp" },
      { name: "Second", destination: "engagement" },
    ]);
    const got = await resolveOwnedCampaign(pool, userId);
    expect(got?.campaignId).toBe(campaignIds[0]);
    expect(got?.destination).toBe("whatsapp");
  });

  it("returns the NAMED campaign when it belongs to the caller", async () => {
    const { userId, campaignIds } = await seedCustomer("named", [
      { name: "First", destination: "whatsapp" },
      { name: "Second", destination: "engagement" },
    ]);
    const got = await resolveOwnedCampaign(pool, userId, campaignIds[1]);
    expect(got?.campaignId).toBe(campaignIds[1]);
    expect(got?.destination).toBe("engagement");
  });

  it("REFUSES another customer's campaign id", async () => {
    // The failure mode this whole module exists to prevent: a campaign id in a
    // query string is a request, never a fact.
    const mine = await seedCustomer("mine", [{ name: "Mine", destination: "whatsapp" }]);
    const theirs = await seedCustomer("theirs", [{ name: "Theirs", destination: "engagement" }]);
    const got = await resolveOwnedCampaign(pool, mine.userId, theirs.campaignIds[0]);
    // Null, not "their campaign" and not a distinguishable "exists but not
    // yours" — telling them apart tells an attacker which ids are real.
    expect(got).toBeNull();
  });

  it("returns null for a caller with no campaign at all", async () => {
    const { userId } = await seedCustomer("none", []);
    expect(await resolveOwnedCampaign(pool, userId)).toBeNull();
    expect(await listOwnedCampaigns(pool, userId)).toEqual([]);
  });
});
