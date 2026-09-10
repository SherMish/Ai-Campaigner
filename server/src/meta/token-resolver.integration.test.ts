// DB integration for the token resolver (AIC-187). Requires DATABASE_URL with
// migrations applied; self-skips otherwise.
//
// The resolution rule is a SQL join plus a decrypt, and the failure it exists to
// prevent — an OAuth customer silently operated with OUR shared credential —
// only shows up against real rows.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import { pool } from "../db/pool.js";
import { tokenForCustomer, tokenForCampaign, sharedToken } from "./token-resolver.js";
import { encryptToken } from "./token-crypto.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

const CUSTOMERS: string[] = [];

async function makeCustomer(name: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO customers (business_name, is_test) VALUES ($1, true) RETURNING id`,
    [`__it_tokres_${name}`],
  );
  CUSTOMERS.push(rows[0].id);
  return rows[0].id;
}

async function connect(customerId: string, via: "manual" | "oauth", token?: string) {
  await pool.query(
    `INSERT INTO meta_connections
       (customer_id, business_portfolio_id, system_user_id, connected_via, access_token_encrypted, connected_at, access_health)
     VALUES ($1, '', '', $2, $3, now(), 'ok')`,
    [customerId, via, token ? encryptToken(token) : null],
  );
}

async function campaignFor(customerId: string): Promise<string> {
  const { rows: acct } = await pool.query<{ id: string }>(
    `INSERT INTO ad_accounts (connection_id, meta_ad_account_id, name, currency, timezone)
     SELECT id, 'act_it', '', 'ILS', 'Asia/Jerusalem' FROM meta_connections WHERE customer_id = $1 LIMIT 1
     RETURNING id`,
    [customerId],
  );
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO managed_campaigns (customer_id, ad_account_id, name, meta_campaign_id)
     VALUES ($1, $2, '__it_tokres', $3) RETURNING id`,
    [customerId, acct[0].id, `1202${Math.floor(Math.random() * 1e12)}`],
  );
  return rows[0].id;
}

d("token-resolver (DB)", () => {
  beforeAll(() => {
    process.env.META_TOKEN_ENC_KEY = randomBytes(32).toString("base64");
    process.env.META_SYSTEM_USER_TOKEN = "EAAG-SHARED-SYSTEM-USER";
  });

  afterAll(async () => {
    if (CUSTOMERS.length) {
      // One statement per query: a parameterized query cannot carry several.
      // Order matters — children before parents.
      await pool.query(`DELETE FROM managed_campaigns WHERE customer_id = ANY($1)`, [CUSTOMERS]);
      await pool.query(
        `DELETE FROM ad_accounts WHERE connection_id IN
           (SELECT id FROM meta_connections WHERE customer_id = ANY($1))`,
        [CUSTOMERS],
      );
      await pool.query(`DELETE FROM meta_connections WHERE customer_id = ANY($1)`, [CUSTOMERS]);
      await pool.query(`DELETE FROM customers WHERE id = ANY($1)`, [CUSTOMERS]);
    }
    await pool.end();
  });

  it("gives an oauth customer their OWN token", async () => {
    const c = await makeCustomer("oauth");
    await connect(c, "oauth", "EAAG-THEIRS");
    expect(await tokenForCustomer(pool, c)).toEqual({ token: "EAAG-THEIRS", source: "oauth" });
  });

  it("gives a manual customer the shared token", async () => {
    const c = await makeCustomer("manual");
    await connect(c, "manual");
    expect(await tokenForCustomer(pool, c)).toEqual({
      token: "EAAG-SHARED-SYSTEM-USER",
      source: "shared",
    });
  });

  it("gives a customer with no connection the shared token", async () => {
    // Every customer who predates OAuth and every half-provisioned one.
    const c = await makeCustomer("none");
    expect(await tokenForCustomer(pool, c)).toMatchObject({ source: "shared" });
  });

  it("resolves through the campaign for the campaign-scoped path", async () => {
    const c = await makeCustomer("bycamp");
    await connect(c, "oauth", "EAAG-BY-CAMPAIGN");
    const campaign = await campaignFor(c);
    expect(await tokenForCampaign(pool, campaign)).toEqual({
      token: "EAAG-BY-CAMPAIGN", source: "oauth",
    });
  });

  it("keeps two customers' credentials apart in one loop", async () => {
    // The ingestion tick's actual shape. Resolving once and reusing would
    // operate everyone through whichever token came first — and would MOSTLY
    // work, which is why it needs a test rather than care.
    const a = await makeCustomer("loop_a");
    const b = await makeCustomer("loop_b");
    await connect(a, "oauth", "EAAG-A");
    await connect(b, "oauth", "EAAG-B");
    const [ca, cb] = [await campaignFor(a), await campaignFor(b)];

    const seen: string[] = [];
    for (const id of [ca, cb, ca]) seen.push((await tokenForCampaign(pool, id))!.token);
    expect(seen).toEqual(["EAAG-A", "EAAG-B", "EAAG-A"]);
  });

  it("refuses rather than falling back when the stored token cannot be decrypted", async () => {
    // Falling back would run an OAuth customer's account on OUR credential:
    // either a permission error, or — if we happen to hold partner access —
    // a success that hides a broken key.
    const c = await makeCustomer("badkey");
    await connect(c, "oauth", "EAAG-LOCKED");
    process.env.META_TOKEN_ENC_KEY = randomBytes(32).toString("base64");
    expect(await tokenForCustomer(pool, c)).toBeNull();
  });

  it("returns null when there is no credential at all", async () => {
    const c = await makeCustomer("notoken");
    await connect(c, "manual");
    delete process.env.META_SYSTEM_USER_TOKEN;
    expect(await tokenForCustomer(pool, c)).toBeNull();
    expect(sharedToken()).toBeNull();
  });
});
