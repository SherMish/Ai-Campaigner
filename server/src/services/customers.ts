import type pg from "pg";
import type { AccessHealth, CampaignStatus, SubscriptionStatus } from "@aic/shared";

// One row of the operator's customer list — status at a glance.
export interface CustomerListRow {
  id: string;
  businessName: string;
  category: string;
  isTest: boolean;
  onboardingStatus: string;
  subscriptionStatus: SubscriptionStatus | null;
  setupPaid: boolean | null;
  accessHealth: AccessHealth | null;
  campaignId: string | null;
  campaignName: string | null;
  campaignStatus: CampaignStatus | null;
  agreedBudgetAgorot: number | null;
  openRecommendations: number;
}

export async function listCustomers(pool: pg.Pool): Promise<CustomerListRow[]> {
  const { rows } = await pool.query(
    `SELECT c.id, c.business_name, c.category, c.is_test, c.onboarding_status,
            s.status AS subscription_status, s.setup_paid,
            conn.access_health,
            mc.id AS campaign_id, mc.name AS campaign_name, mc.status AS campaign_status, mc.agreed_budget_agorot,
            COALESCE(r.open_recs, 0) AS open_recs
     FROM customers c
     LEFT JOIN subscriptions s      ON s.customer_id = c.id
     LEFT JOIN meta_connections conn ON conn.customer_id = c.id
     LEFT JOIN managed_campaigns mc  ON mc.customer_id = c.id
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS open_recs FROM recommendations r
       WHERE r.campaign_id = mc.id AND r.state = 'proposed'
     ) r ON true
     ORDER BY c.business_name`,
  );
  return rows.map((r) => ({
    id: r.id,
    businessName: r.business_name,
    category: r.category,
    isTest: r.is_test,
    onboardingStatus: r.onboarding_status,
    subscriptionStatus: r.subscription_status ?? null,
    setupPaid: r.setup_paid ?? null,
    accessHealth: r.access_health ?? null,
    campaignId: r.campaign_id ?? null,
    campaignName: r.campaign_name ?? null,
    campaignStatus: r.campaign_status ?? null,
    agreedBudgetAgorot: r.agreed_budget_agorot ?? null,
    openRecommendations: Number(r.open_recs),
  }));
}

export interface CustomerDetail extends CustomerListRow {
  mainService: string;
  geoArea: string;
  primaryCustomer: string;
  offer: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  nextChargeDate: string | null;
  outstandingRecommendation: {
    id: string;
    type: string;
    rationale: string;
    proposedBudgetAgorot: number | null;
    maxSpendImpactAgorot: number | null;
  } | null;
  openOpsItems: number;
}

// Full per-customer view assembled from the real tables (AIC-16).
export async function getCustomerDetail(
  pool: pg.Pool,
  customerId: string,
): Promise<CustomerDetail | null> {
  const list = await pool.query(
    `SELECT c.*, s.status AS subscription_status, s.setup_paid, s.next_charge_date,
            conn.access_health,
            mc.id AS campaign_id, mc.name AS campaign_name, mc.status AS campaign_status, mc.agreed_budget_agorot
     FROM customers c
     LEFT JOIN subscriptions s       ON s.customer_id = c.id
     LEFT JOIN meta_connections conn ON conn.customer_id = c.id
     LEFT JOIN managed_campaigns mc   ON mc.customer_id = c.id
     WHERE c.id = $1`,
    [customerId],
  );
  const c = list.rows[0];
  if (!c) return null;

  let outstanding: CustomerDetail["outstandingRecommendation"] = null;
  let openOps = 0;
  if (c.campaign_id) {
    const rec = await pool.query(
      `SELECT id, type, rationale, proposed_budget_agorot, max_spend_impact_agorot
       FROM recommendations WHERE campaign_id = $1 AND state = 'proposed'
       ORDER BY created_at DESC LIMIT 1`,
      [c.campaign_id],
    );
    if (rec.rows[0]) {
      outstanding = {
        id: rec.rows[0].id,
        type: rec.rows[0].type,
        rationale: rec.rows[0].rationale,
        proposedBudgetAgorot: rec.rows[0].proposed_budget_agorot,
        maxSpendImpactAgorot: rec.rows[0].max_spend_impact_agorot,
      };
    }
  }
  const ops = await pool.query<{ count: string }>(
    `SELECT count(*) FROM ops_queue_items WHERE customer_id = $1 AND status <> 'resolved'`,
    [customerId],
  );
  openOps = Number(ops.rows[0].count);

  const openRecs = c.campaign_id
    ? Number((await pool.query<{ count: string }>(`SELECT count(*) FROM recommendations WHERE campaign_id = $1 AND state = 'proposed'`, [c.campaign_id])).rows[0].count)
    : 0;

  return {
    id: c.id,
    businessName: c.business_name,
    category: c.category,
    isTest: c.is_test,
    onboardingStatus: c.onboarding_status,
    subscriptionStatus: c.subscription_status ?? null,
    setupPaid: c.setup_paid ?? null,
    accessHealth: c.access_health ?? null,
    campaignId: c.campaign_id ?? null,
    campaignName: c.campaign_name ?? null,
    campaignStatus: c.campaign_status ?? null,
    agreedBudgetAgorot: c.agreed_budget_agorot ?? null,
    openRecommendations: openRecs,
    mainService: c.main_service,
    geoArea: c.geo_area,
    primaryCustomer: c.primary_customer,
    offer: c.offer,
    contactName: c.contact_name,
    contactPhone: c.contact_phone,
    contactEmail: c.contact_email,
    nextChargeDate: c.next_charge_date ? new Date(c.next_charge_date).toISOString().slice(0, 10) : null,
    outstandingRecommendation: outstanding,
    openOpsItems: openOps,
  };
}
