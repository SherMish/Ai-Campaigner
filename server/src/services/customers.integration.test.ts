// DB + HTTP integration for the customers view (AIC-16). Requires DATABASE_URL.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";
import { pool } from "../db/pool.js";
import { createApp } from "../app.js";
import { listCustomers, getCustomerDetail } from "./customers.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

const ADMIN = "Bearer test-admin";
d("customers view (DB + HTTP)", () => {
  beforeAll(() => { process.env.ADMIN_TOKEN = "test-admin"; });
  afterAll(async () => { await pool.end(); });

  it("assembles list + detail from the real tables", async () => {
    const cust = await pool.query<{ id: string }>(
      `INSERT INTO customers (business_name, category, main_service, offer, contact_email, onboarding_status)
       VALUES ('__it_cust Co','fitness','personal training','free trial','a@b.co','ready') RETURNING id`,
    );
    const customerId = cust.rows[0].id;
    await pool.query(`INSERT INTO subscriptions (customer_id, status, setup_paid) VALUES ($1,'active',true)`, [customerId]);
    const conn = await pool.query<{ id: string }>(`INSERT INTO meta_connections (customer_id, access_health) VALUES ($1,'ok') RETURNING id`, [customerId]);
    const acct = await pool.query<{ id: string }>(`INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`, [conn.rows[0].id, `act_cv_${conn.rows[0].id.slice(0,8)}`]);
    const camp = await pool.query<{ id: string }>(`INSERT INTO managed_campaigns (customer_id, ad_account_id, status, agreed_budget_agorot) VALUES ($1,$2,'active',10000) RETURNING id`, [customerId, acct.rows[0].id]);
    await pool.query(`INSERT INTO recommendations (campaign_id, type, state, rationale) VALUES ($1,'increase_budget','proposed','x')`, [camp.rows[0].id]);
    await pool.query(`INSERT INTO ops_queue_items (customer_id, type, severity) VALUES ($1,'support_request','medium')`, [customerId]);
    // AIC-64/85: the precise no-rec reason should reach the operator's detail view.
    await pool.query(
      `UPDATE managed_campaigns SET no_rec_reason = 'no_comparable_audiences', no_rec_detail = $2 WHERE id = $1`,
      [camp.rows[0].id, JSON.stringify({ comparableCount: 1 })],
    );

    const list = await listCustomers(pool);
    const row = list.find((r) => r.id === customerId)!;
    expect(row.subscriptionStatus).toBe("active");
    expect(row.accessHealth).toBe("ok");
    expect(row.campaignStatus).toBe("active");
    expect(row.agreedBudgetAgorot).toBe(10000);
    expect(row.openRecommendations).toBe(1);
    // The seed never links a real Meta campaign — this row is honestly
    // "not_launched", not silently "ready".
    expect(row.connectionReadiness).toBe("not_launched");

    const detail = await getCustomerDetail(pool, customerId);
    expect(detail?.mainService).toBe("personal training");
    expect(detail?.outstandingRecommendation?.type).toBe("increase_budget");
    expect(detail?.openOpsItems).toBe(1);
    expect(detail?.noRecReason).toBe("no_comparable_audiences");
    expect(detail?.noRecDetail).toMatchObject({ comparableCount: 1 });
    expect(detail?.connectionReadiness).toBe("not_launched");

    const res = await request(createApp()).get(`/api/admin/customers/${customerId}`).set("Authorization", ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.businessName).toBe("__it_cust Co");

    await pool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  });

  // REGRESSION: an operator scanning the fleet had no way to see this without
  // the customer hitting the wall themselves first (the real add-content bug).
  it("surfaces the SAME connection-readiness reason the customer-facing add-content flow would hit", async () => {
    const cust = await pool.query<{ id: string }>(
      `INSERT INTO customers (business_name, category, onboarding_status) VALUES ('__it_cust_readiness', 'fitness', 'ready') RETURNING id`,
    );
    const customerId = cust.rows[0].id;
    const conn = await pool.query<{ id: string }>(
      `INSERT INTO meta_connections (customer_id, access_health) VALUES ($1,'ok') RETURNING id`, // page_id left NULL
      [customerId],
    );
    const acct = await pool.query<{ id: string }>(
      `INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`,
      [conn.rows[0].id, `act_readiness_${conn.rows[0].id.slice(0, 8)}`],
    );
    // A real whatsapp_destination — otherwise AIC-103's completeness check
    // would ALSO flag this row (as incomplete_config), muddying this test's
    // one thing under test (the page_id gap specifically).
    await pool.query(
      `INSERT INTO managed_campaigns (customer_id, ad_account_id, status, meta_campaign_id, whatsapp_destination) VALUES ($1,$2,'active','meta_camp_readiness','972500000000')`,
      [customerId, acct.rows[0].id],
    );

    const list = await listCustomers(pool);
    expect(list.find((r) => r.id === customerId)?.connectionReadiness).toBe("missing_page");

    const detail = await getCustomerDetail(pool, customerId);
    expect(detail?.connectionReadiness).toBe("missing_page");

    // Fill in the Page — the same customer should now read as fully ready.
    await pool.query(`UPDATE meta_connections SET page_id = 'page_readiness_1' WHERE customer_id = $1`, [customerId]);
    const listAfter = await listCustomers(pool);
    expect(listAfter.find((r) => r.id === customerId)?.connectionReadiness).toBeNull();

    await pool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  });

  // AIC-103: the ops-console health check — this is how an operator finds a
  // free_beta_signups_leads BEFORE a customer's raw 409, not one at a time.
  it("surfaces incomplete_config + which fields, for a campaign otherwise fully ready but missing website_url", async () => {
    const cust = await pool.query<{ id: string }>(
      `INSERT INTO customers (business_name, category, onboarding_status) VALUES ('__it_cust_incomplete', 'fitness', 'ready') RETURNING id`,
    );
    const customerId = cust.rows[0].id;
    const conn = await pool.query<{ id: string }>(
      `INSERT INTO meta_connections (customer_id, access_health, page_id) VALUES ($1,'ok','page_incomplete_1') RETURNING id`,
      [customerId],
    );
    const acct = await pool.query<{ id: string }>(
      `INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`,
      [conn.rows[0].id, `act_incomplete_${conn.rows[0].id.slice(0, 8)}`],
    );
    // A real Pixel campaign (lead_event_types set), missing website_url +
    // tracking_pixel_id — exactly free_beta_signups_leads' real shape.
    await pool.query(
      `INSERT INTO managed_campaigns (customer_id, ad_account_id, status, meta_campaign_id, lead_event_types)
       VALUES ($1,$2,'active','meta_camp_incomplete', ARRAY['offsite_conversion.fb_pixel_complete_registration'])`,
      [customerId, acct.rows[0].id],
    );

    const list = await listCustomers(pool);
    const row = list.find((r) => r.id === customerId)!;
    expect(row.connectionReadiness).toBe("incomplete_config");
    expect(row.missingConfigFields).toEqual(["website_url", "tracking_pixel_id"]);

    const detail = await getCustomerDetail(pool, customerId);
    expect(detail?.connectionReadiness).toBe("incomplete_config");
    expect(detail?.missingConfigFields).toEqual(["website_url", "tracking_pixel_id"]);

    await pool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  });
});
