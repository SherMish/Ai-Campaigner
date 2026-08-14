import type { Logger } from "../services/logger.js";
import { pool } from "./pool.js";

// One-off provisioning (gated by META_SEED_TEST_FREEBETA): connect the real
// free_beta_signups_leads Pixel campaign to the app_user with
// META_SEED_TEST_FREEBETA_EMAIL. Modeled directly on seed-pisga-owner.ts —
// same shape, different customer/campaign — because this ad account
// (act_2181076988590009) is the SAME Meta Business Portfolio Pisga's GelNails
// campaign already lives under (migration 037 made that legal: one Meta ad
// account can now back several customers, each via their own
// meta_connections row). Idempotent: safe to re-run; skips anything already
// present. Remove the env vars after.
//
// AIC-87: lead_event_types is set to this campaign's REAL Pixel conversion
// action type, confirmed via a read-only Graph probe before writing anything
// — objective OUTCOME_LEADS, optimization_goal OFFSITE_CONVERSIONS,
// promoted_object.custom_event_type COMPLETE_REGISTRATION, and the actual
// Insights actions carry offsite_conversion.fb_pixel_complete_registration.
// Connecting it WITHOUT this would ingest 0 leads on real spend — the exact
// bug AIC-87 exists to prevent.
//
// The campaign is PAUSED on Meta and stays that way through this script —
// nothing spends, nothing can be recommended against, while this is verified.
const AD_ACCOUNT = process.env.META_SEED_TEST_FREEBETA_AD_ACCOUNT || "act_2181076988590009";
const CAMPAIGN_ID = process.env.META_SEED_TEST_FREEBETA_CAMPAIGN || "120248236848650352";
const SYSTEM_USER = process.env.META_SEED_TEST_FREEBETA_SYSTEM_USER || "61592806930741";
const PIXEL_ID = process.env.META_SEED_TEST_FREEBETA_PIXEL || "984664453249037";
const LEAD_EVENT_TYPE = "offsite_conversion.fb_pixel_complete_registration";
const AGREED_BUDGET_AGOROT = Number(process.env.META_SEED_TEST_FREEBETA_BUDGET_AGOROT || "2000"); // ₪20/day (Meta's real daily_budget)

export async function seedTestFreeBeta(log: Logger): Promise<void> {
  const email = process.env.META_SEED_TEST_FREEBETA_EMAIL;
  if (!email) { log.error("[seed-test-freebeta] META_SEED_TEST_FREEBETA_EMAIL not set"); return; }
  log.info(`[seed-test-freebeta] ── provisioning free_beta_signups_leads for ${email} ──`);
  try {
    // 1) the owner account — must already exist (this script never signs anyone up).
    const ownerRow = (await pool.query<{ id: string; email: string; customer_id: string | null }>(
      `SELECT id, email, customer_id FROM app_users WHERE lower(email) = lower($1) LIMIT 1`,
      [email],
    )).rows[0];
    if (!ownerRow) { log.error(`[seed-test-freebeta] no app_user with email ${email} — sign up first`); return; }
    const userId = ownerRow.id;

    // 2) a customer for this user (create fresh; test@test.com gets its OWN
    // customer, not a shared one — distinct from seed-pisga-owner's reuse
    // logic, which was specifically about re-attaching the SAME dogfood Pisga
    // customer across re-runs).
    let customerId = ownerRow.customer_id;
    if (!customerId) {
      const existing = await pool.query<{ id: string }>(
        `SELECT id FROM customers WHERE business_name = 'free_beta test' AND is_test = true LIMIT 1`,
      );
      customerId = existing.rows[0]?.id ?? null;
    }
    if (!customerId) {
      const c = await pool.query<{ id: string }>(
        `INSERT INTO customers (business_name, category, main_service, geo_area, primary_customer,
           offer, contact_name, contact_email, is_test, onboarding_status)
         VALUES ('free_beta test','education','Free beta signup funnel','Israel',
           'Prospective beta users','Free beta access','Test Account',$1,true,'ready')
         RETURNING id`,
        [ownerRow.email],
      );
      customerId = c.rows[0].id;
      log.info(`[seed-test-freebeta] created customer ${customerId}`);
    } else {
      log.info(`[seed-test-freebeta] using existing customer ${customerId}`);
    }

    await pool.query(`UPDATE app_users SET customer_id = $2 WHERE id = $1`, [userId, customerId]);
    log.info(`[seed-test-freebeta] linked app_user ${userId} → customer ${customerId}`);

    // 3) meta_connection (one per customer — this customer's own, separate
    // from Sharon's connection to the same ad account).
    let connId = (await pool.query<{ id: string }>(`SELECT id FROM meta_connections WHERE customer_id = $1`, [customerId])).rows[0]?.id;
    if (!connId) {
      connId = (await pool.query<{ id: string }>(
        `INSERT INTO meta_connections (customer_id, system_user_id, access_health, last_verified_at)
         VALUES ($1,$2,'ok', now()) RETURNING id`,
        [customerId, SYSTEM_USER],
      )).rows[0].id;
      log.info(`[seed-test-freebeta] created meta_connection ${connId}`);
    }

    // 4) ad_account — scoped to THIS connection (migration 037: the same
    // meta_ad_account_id can now legally back a second customer's own row).
    let acctId = (await pool.query<{ id: string }>(
      `SELECT id FROM ad_accounts WHERE connection_id = $1 AND meta_ad_account_id = $2`,
      [connId, AD_ACCOUNT],
    )).rows[0]?.id;
    if (!acctId) {
      acctId = (await pool.query<{ id: string }>(
        `INSERT INTO ad_accounts (connection_id, meta_ad_account_id, name, currency)
         VALUES ($1,$2,'Pisga — פרסום','ILS') RETURNING id`,
        [connId, AD_ACCOUNT],
      )).rows[0].id;
      log.info(`[seed-test-freebeta] created ad_account ${acctId} (${AD_ACCOUNT})`);
    }

    // 5) managed_campaign (one per customer) — status 'active' directly,
    // bypassing campaign_reviews entirely (same as seed-pisga-owner.ts): this
    // is a one-off provisioning script, not the customer-facing builder flow.
    const existingCamp = await pool.query<{ id: string }>(`SELECT id FROM managed_campaigns WHERE customer_id = $1`, [customerId]);
    if (existingCamp.rows.length === 0) {
      const camp = await pool.query<{ id: string }>(
        `INSERT INTO managed_campaigns
           (customer_id, ad_account_id, meta_campaign_id, name, status, objective,
            agreed_budget_agorot, budget_period, lead_event_types, tracking_pixel_id)
         VALUES ($1,$2,$3,'free_beta_signups_leads','active','leads',$4,'daily',$5,$6)
         RETURNING id`,
        [customerId, acctId, CAMPAIGN_ID, AGREED_BUDGET_AGOROT, [LEAD_EVENT_TYPE], PIXEL_ID],
      );
      log.info(`[seed-test-freebeta] created managed_campaign ${camp.rows[0].id} (meta ${CAMPAIGN_ID}, lead_event_types=${LEAD_EVENT_TYPE})`);
    } else {
      log.info(`[seed-test-freebeta] managed_campaign already exists (${existingCamp.rows[0].id})`);
    }

    log.info("[seed-test-freebeta] RESULT=DONE — test@test.com linked to free_beta_signups_leads");
  } catch (e) {
    log.error(`[seed-test-freebeta] error: ${(e as Error).message}`);
    log.info("[seed-test-freebeta] RESULT=FAIL");
  }
}
