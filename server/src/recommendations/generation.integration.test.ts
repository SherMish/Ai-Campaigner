// DB integration for the generation eligibility query (AIC-9). Requires
// DATABASE_URL; self-skips otherwise. The tick logic itself is unit-tested in
// generation.test.ts (fakes); here we assert only the eligible-campaigns filter.
import { describe, it, expect, afterAll } from "vitest";
import { pool } from "../db/pool.js";
import { listEligibleForGeneration } from "./generation.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

// Seed one customer+connection+campaign with the given knobs; return campaign id.
async function seed(tag: string, o: {
  status?: string; automation?: boolean; metaId?: string | null; health?: string;
  destination?: string;
}): Promise<string> {
  const cust = await pool.query<{ id: string }>(
    `INSERT INTO customers (business_name, is_test) VALUES ($1, true) RETURNING id`,
    [`__it_gen_${tag}`],
  );
  const customerId = cust.rows[0].id;
  const conn = await pool.query<{ id: string }>(
    `INSERT INTO meta_connections (customer_id, system_user_id, access_health) VALUES ($1,'9',$2) RETURNING id`,
    [customerId, o.health ?? "ok"],
  );
  const acct = await pool.query<{ id: string }>(
    `INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`,
    [conn.rows[0].id, `act_gen_${conn.rows[0].id.slice(0, 8)}`],
  );
  const camp = await pool.query<{ id: string }>(
    `INSERT INTO managed_campaigns (customer_id, ad_account_id, meta_campaign_id, name, status, automation_enabled, agreed_budget_agorot, destination)
     VALUES ($1,$2,$3,$4,$5,$6,1000,$7) RETURNING id`,
    [customerId, acct.rows[0].id, o.metaId === undefined ? "meta_gen" : o.metaId,
     `gen_${tag}`, o.status ?? "active", o.automation ?? true, o.destination ?? "whatsapp"],
  );
  return camp.rows[0].id;
}

d("listEligibleForGeneration (DB)", () => {
  afterAll(async () => {
    await pool.query(`DELETE FROM customers WHERE business_name LIKE '__it_gen_%'`);
    await pool.end();
  });

  it("includes only active + automation-on + linked + healthy campaigns", async () => {
    const eligible = await seed("ok", {});
    await seed("paused", { status: "paused" });
    await seed("autooff", { automation: false });
    await seed("nometa", { metaId: null });
    await seed("badhealth", { health: "revoked" });
    await seed("unmanaged", { status: "unmanaged" });
    // AIC-189 — an engagement campaign is healthy, active and automated, and
    // still must not reach the engine: every rule is cost-per-LEAD shaped, and
    // an engagement campaign has no lead. Comparing a cost-per-comment against
    // a lead threshold produces a confident recommendation from a metric that
    // does not apply.
    await seed("engagement", { destination: "engagement" });

    const ids = (await listEligibleForGeneration(pool)).map((c) => c.id);
    expect(ids).toContain(eligible);
    // none of the excluded ones
    const all = await pool.query<{ id: string }>(
      `SELECT id FROM managed_campaigns WHERE name LIKE 'gen_%' AND name <> 'gen_ok'`,
    );
    for (const r of all.rows) expect(ids).not.toContain(r.id);
  });
});
