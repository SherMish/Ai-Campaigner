import type { Logger } from "../services/logger.js";
import { pool } from "./pool.js";

// One-off provisioning (gated by META_SEED_PISGA): make the app_user with
// META_SEED_OWNER_EMAIL the owner of a "Pisga" customer, and wire the real
// dogfood connection + managed campaign (ids from the AIC-1 probe). Idempotent:
// safe to re-run; skips anything already present. Remove the env vars after.
const AD_ACCOUNT = process.env.META_SEED_AD_ACCOUNT || "act_2181076988590009";
const CAMPAIGN_ID = process.env.META_SEED_CAMPAIGN || "120248253976380352";
const SYSTEM_USER = process.env.META_SEED_SYSTEM_USER || "61592806930741";
const AGREED_BUDGET_AGOROT = Number(process.env.META_SEED_BUDGET_AGOROT || "800"); // ₪8/day (current)

export async function seedPisgaOwner(log: Logger): Promise<void> {
  const email = process.env.META_SEED_OWNER_EMAIL;
  log.info(`[seed-pisga] ── provisioning Pisga ${email ? `for owner ${email}` : "(auto-selecting the app_user)"} ──`);
  try {
    // 1) the owner account — by email, or the single app_user if unambiguous.
    let ownerRow: { id: string; email: string; customer_id: string | null } | undefined;
    if (email) {
      ownerRow = (await pool.query<{ id: string; email: string; customer_id: string | null }>(
        `SELECT id, email, customer_id FROM app_users WHERE lower(email) = lower($1) LIMIT 1`,
        [email],
      )).rows[0];
      if (!ownerRow) { log.error(`[seed-pisga] no app_user with email ${email} — sign up first`); return; }
    } else {
      const all = await pool.query<{ id: string; email: string; customer_id: string | null }>(
        `SELECT id, email, customer_id FROM app_users ORDER BY created_at DESC`,
      );
      if (all.rows.length === 0) { log.error("[seed-pisga] no app_users exist — sign up first"); return; }
      if (all.rows.length > 1) { log.error(`[seed-pisga] ${all.rows.length} app_users exist — set META_SEED_OWNER_EMAIL to pick one`); return; }
      ownerRow = all.rows[0];
      log.info(`[seed-pisga] auto-selected the only app_user: ${ownerRow.email}`);
    }
    const userId = ownerRow.id;
    const u = { rows: [ownerRow] };

    // 2) Pisga customer (reuse the user's linked one, or an existing Pisga, else create)
    let customerId = u.rows[0].customer_id;
    if (!customerId) {
      const existing = await pool.query<{ id: string }>(
        `SELECT id FROM customers WHERE business_name = 'Pisga' AND is_test = true LIMIT 1`,
      );
      customerId = existing.rows[0]?.id ?? null;
    }
    if (!customerId) {
      const c = await pool.query<{ id: string }>(
        `INSERT INTO customers (business_name, category, main_service, geo_area, primary_customer,
           offer, contact_name, contact_email, is_test, onboarding_status)
         VALUES ('Pisga','education','Psychometric (PET) prep','Israel',
           'Self-directed PET applicants','AI-guided daily study plan','Pisga (dogfood)',$1,true,'ready')
         RETURNING id`,
        [ownerRow.email],
      );
      customerId = c.rows[0].id;
      log.info(`[seed-pisga] created Pisga customer ${customerId}`);
    } else {
      log.info(`[seed-pisga] using existing Pisga customer ${customerId}`);
    }

    // link owner → customer
    await pool.query(`UPDATE app_users SET customer_id = $2 WHERE id = $1`, [userId, customerId]);
    log.info(`[seed-pisga] linked app_user ${userId} → customer ${customerId}`);

    // 3) meta_connection (one per customer)
    let connId = (await pool.query<{ id: string }>(`SELECT id FROM meta_connections WHERE customer_id = $1`, [customerId])).rows[0]?.id;
    if (!connId) {
      connId = (await pool.query<{ id: string }>(
        `INSERT INTO meta_connections (customer_id, system_user_id, access_health, last_verified_at)
         VALUES ($1,$2,'ok', now()) RETURNING id`,
        [customerId, SYSTEM_USER],
      )).rows[0].id;
      log.info(`[seed-pisga] created meta_connection ${connId}`);
    }

    // 4) ad_account — scoped to THIS connection (migration 037: one Meta ad
    // account can now back several customers, each via their own
    // meta_connections row, so an unscoped lookup could match another
    // customer's ad_accounts row and skip creating this one's).
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
      log.info(`[seed-pisga] created ad_account ${acctId} (${AD_ACCOUNT})`);
    }

    // 5) managed_campaign (one per customer)
    const existingCamp = await pool.query<{ id: string }>(`SELECT id FROM managed_campaigns WHERE customer_id = $1`, [customerId]);
    if (existingCamp.rows.length === 0) {
      const camp = await pool.query<{ id: string }>(
        `INSERT INTO managed_campaigns
           (customer_id, ad_account_id, meta_campaign_id, name, status, objective,
            agreed_budget_agorot, budget_period)
         VALUES ($1,$2,$3,'Pisga — free_beta_signups','active','leads',$4,'daily')
         RETURNING id`,
        [customerId, acctId, CAMPAIGN_ID, AGREED_BUDGET_AGOROT],
      );
      log.info(`[seed-pisga] created managed_campaign ${camp.rows[0].id} (meta ${CAMPAIGN_ID}, agreed ${AGREED_BUDGET_AGOROT} agorot)`);
    } else {
      log.info(`[seed-pisga] managed_campaign already exists (${existingCamp.rows[0].id})`);
    }

    log.info("[seed-pisga] RESULT=DONE — owner linked to Pisga customer with connection + managed campaign");
  } catch (e) {
    log.error(`[seed-pisga] error: ${(e as Error).message}`);
    log.info("[seed-pisga] RESULT=FAIL");
  }
}
