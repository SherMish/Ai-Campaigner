// Seed the single dogfood customer = Pisga. Idempotent: safe to run repeatedly.
// This is the account AIC-5/6/7 exercise end-to-end (our own campaign) before
// any external customer.
import "../load-env.js";
import { pool } from "./pool.js";

async function main() {
  // customers has no natural unique key, so guard on (business_name, is_test)
  // to stay idempotent rather than relying on ON CONFLICT.
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM customers WHERE business_name = 'Pisga' AND is_test = true LIMIT 1`,
  );

  let customerId = existing.rows[0]?.id;
  if (!customerId) {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO customers
         (business_name, category, main_service, geo_area, primary_customer,
          offer, contact_name, contact_email, is_test, onboarding_status)
       VALUES
         ('Pisga', 'education', 'Psychometric (PET) prep', 'Israel',
          'Self-directed PET applicants', 'AI-guided daily study plan',
          'Pisga (dogfood)', 'team@pisga.app', true, 'ready')
       RETURNING id`,
    );
    customerId = inserted.rows[0].id;
  }

  await pool.query(
    `INSERT INTO subscriptions (customer_id, status, setup_paid, plan)
     VALUES ($1, 'active', true, 'p0_dogfood')
     ON CONFLICT (customer_id) DO NOTHING`,
    [customerId],
  );

  console.log(`[seed] dogfood customer Pisga ready (${customerId})`);
  await pool.end();
}

main().catch((err) => {
  console.error("[seed] failed", err);
  process.exit(1);
});
