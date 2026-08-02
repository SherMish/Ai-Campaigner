import type pg from "pg";
import type { SubscriptionStatus } from "@aic/shared";

// ── Manual billing ledger (AIC-19) ────────────────────────────────────────────
// P0 collects ₪299 setup + ₪299/mo manually (invoice / Bit / transfer). This is
// the operator ledger — enough to run the business and read setup→subscription
// conversion, with NO payment gateway.

export interface BillingUpdate {
  setupPaid?: boolean;
  setupPaidAt?: string | null; // ISO date
  status?: SubscriptionStatus;
  nextChargeDate?: string | null; // ISO date
  monthlyAmountAgorot?: number;
}

export async function updateBilling(
  pool: pg.Pool,
  customerId: string,
  u: BillingUpdate,
): Promise<void> {
  // Upsert: onboarding usually creates the subscription, but tolerate its absence.
  await pool.query(
    `INSERT INTO subscriptions (customer_id) VALUES ($1) ON CONFLICT (customer_id) DO NOTHING`,
    [customerId],
  );
  await pool.query(
    `UPDATE subscriptions SET
       setup_paid            = COALESCE($2, setup_paid),
       setup_paid_at         = COALESCE($3, setup_paid_at),
       status                = COALESCE($4, status),
       next_charge_date      = COALESCE($5, next_charge_date),
       monthly_amount_agorot = COALESCE($6, monthly_amount_agorot)
     WHERE customer_id = $1`,
    [
      customerId,
      u.setupPaid ?? null,
      u.setupPaidAt ?? null,
      u.status ?? null,
      u.nextChargeDate ?? null,
      u.monthlyAmountAgorot ?? null,
    ],
  );
}

export interface ConversionSummary {
  customers: number;
  setupPaid: number;
  subscribed: number; // status = active
  setupToSubscriptionRate: number | null; // subscribed / setupPaid
}

// Setup→subscription conversion across real (non-test) customers.
export async function conversionSummary(pool: pg.Pool): Promise<ConversionSummary> {
  const { rows } = await pool.query<{ customers: string; setup_paid: string; subscribed: string }>(
    `SELECT count(*)::int AS customers,
            count(*) FILTER (WHERE s.setup_paid)::int AS setup_paid,
            count(*) FILTER (WHERE s.status = 'active')::int AS subscribed
     FROM customers c
     LEFT JOIN subscriptions s ON s.customer_id = c.id
     WHERE c.is_test = false`,
  );
  const setupPaid = Number(rows[0].setup_paid);
  const subscribed = Number(rows[0].subscribed);
  return {
    customers: Number(rows[0].customers),
    setupPaid,
    subscribed,
    setupToSubscriptionRate: setupPaid === 0 ? null : Math.round((subscribed / setupPaid) * 100) / 100,
  };
}

// ── Weekly lead-quality capture (AIC-19, PRD §20) ─────────────────────────────
// Campaign-level weekly signal — NOT a CRM, no individual-lead tracking.

export interface LeadQualityInput {
  campaignId: string;
  weekStart: string; // ISO date (Monday)
  leadsReported: number;
  relevantCount: number;
  customersWon?: number | null;
}

export async function upsertLeadQuality(pool: pg.Pool, q: LeadQualityInput): Promise<void> {
  await pool.query(
    `INSERT INTO lead_quality_feedback (campaign_id, week_start, leads_reported, relevant_count, customers_won)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (campaign_id, week_start) DO UPDATE SET
       leads_reported = EXCLUDED.leads_reported,
       relevant_count = EXCLUDED.relevant_count,
       customers_won  = EXCLUDED.customers_won`,
    [q.campaignId, q.weekStart, q.leadsReported, q.relevantCount, q.customersWon ?? null],
  );
}

export interface LeadQualityRow {
  weekStart: string;
  leadsReported: number;
  relevantCount: number;
  customersWon: number | null;
}

export async function listLeadQuality(pool: pg.Pool, campaignId: string): Promise<LeadQualityRow[]> {
  const { rows } = await pool.query(
    `SELECT week_start, leads_reported, relevant_count, customers_won
     FROM lead_quality_feedback WHERE campaign_id = $1 ORDER BY week_start DESC`,
    [campaignId],
  );
  return rows.map((r) => ({
    weekStart: new Date(r.week_start).toISOString().slice(0, 10),
    leadsReported: Number(r.leads_reported),
    relevantCount: Number(r.relevant_count),
    customersWon: r.customers_won === null ? null : Number(r.customers_won),
  }));
}

// Response rate for a week: answered campaigns / active managed campaigns.
export async function leadQualityResponseRate(
  pool: pg.Pool,
  weekStart: string,
): Promise<{ answered: number; active: number; rate: number | null }> {
  const active = Number(
    (await pool.query<{ n: string }>(`SELECT count(*)::int AS n FROM managed_campaigns WHERE status = 'active'`)).rows[0].n,
  );
  const answered = Number(
    (await pool.query<{ n: string }>(
      `SELECT count(DISTINCT lqf.campaign_id)::int AS n
       FROM lead_quality_feedback lqf
       JOIN managed_campaigns mc ON mc.id = lqf.campaign_id AND mc.status = 'active'
       WHERE lqf.week_start = $1`,
      [weekStart],
    )).rows[0].n,
  );
  return { answered, active, rate: active === 0 ? null : Math.round((answered / active) * 100) / 100 };
}
