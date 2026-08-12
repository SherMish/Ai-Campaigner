// DB integration for the ad-set-meta cache (AIC-37 + AIC-65's prune fix).
// Requires DATABASE_URL; self-skips otherwise.
import { describe, it, expect, afterAll } from "vitest";
import { pool } from "../db/pool.js";
import { upsertAdSetMeta, listAdSetMeta } from "./audience-meta-cache.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

async function seed(tag: string): Promise<string> {
  const cust = await pool.query<{ id: string }>(
    `INSERT INTO customers (business_name, is_test) VALUES ($1, true) RETURNING id`,
    [`__it_asmc_${tag}`],
  );
  const customerId = cust.rows[0].id;
  const conn = await pool.query<{ id: string }>(
    `INSERT INTO meta_connections (customer_id, access_health) VALUES ($1,'ok') RETURNING id`,
    [customerId],
  );
  const acct = await pool.query<{ id: string }>(
    `INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`,
    [conn.rows[0].id, `act_asmc_${conn.rows[0].id.slice(0, 8)}`],
  );
  const camp = await pool.query<{ id: string }>(
    `INSERT INTO managed_campaigns (customer_id, ad_account_id, meta_campaign_id, name, status)
     VALUES ($1,$2,'m','C','active') RETURNING id`,
    [customerId, acct.rows[0].id],
  );
  return camp.rows[0].id;
}

function meta(adSetId: string, name: string) {
  return { adSetId, name, ageMin: 18, ageMax: 35, genders: "all" as const, geoSummary: "", isDynamicCreative: false };
}

d("upsertAdSetMeta (DB) — cache + prune (AIC-65)", () => {
  afterAll(async () => {
    await pool.query(`DELETE FROM customers WHERE business_name LIKE '__it_asmc_%'`);
    await pool.end();
  });

  it("caches ad sets, then prunes one no longer in the managed list (the real GelNails bug)", async () => {
    const campaignId = await seed("t1");
    await upsertAdSetMeta(pool, campaignId, [meta("as_real", "Real"), meta("as_dead", "Was real, now dead")]);
    let cached = await listAdSetMeta(pool, campaignId);
    expect(cached.map((c) => c.adSetId).sort()).toEqual(["as_dead", "as_real"]);

    // Next tick: as_dead was excluded as unmanaged (deleted/draft) — never
    // passed in again. It must disappear from the cache, not linger forever.
    await upsertAdSetMeta(pool, campaignId, [meta("as_real", "Real")]);
    cached = await listAdSetMeta(pool, campaignId);
    expect(cached.map((c) => c.adSetId)).toEqual(["as_real"]);
  });

  it("clears the whole cache when no ad sets are managed anymore", async () => {
    const campaignId = await seed("t2");
    await upsertAdSetMeta(pool, campaignId, [meta("as_a", "A"), meta("as_b", "B")]);
    await upsertAdSetMeta(pool, campaignId, []);
    expect(await listAdSetMeta(pool, campaignId)).toEqual([]);
  });

  it("never touches another campaign's cached rows", async () => {
    const campA = await seed("t3a");
    const campB = await seed("t3b");
    await upsertAdSetMeta(pool, campA, [meta("as_a", "A")]);
    await upsertAdSetMeta(pool, campB, [meta("as_b", "B")]);
    await upsertAdSetMeta(pool, campA, []); // A now has none managed
    expect(await listAdSetMeta(pool, campA)).toEqual([]);
    expect((await listAdSetMeta(pool, campB)).map((c) => c.adSetId)).toEqual(["as_b"]);
  });
});
