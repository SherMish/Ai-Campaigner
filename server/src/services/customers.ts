import type pg from "pg";
import type { AccessHealth, CampaignStatus, SubscriptionStatus } from "@aic/shared";
import { resolveThresholds, type RuleThresholds } from "../recommendations/rules.js";
import { classifyConnectionReadiness, type ConnectionReadinessReason } from "./connection-readiness.js";

// One row of the operator's customer list — status at a glance.
export interface CustomerListRow {
  id: string;
  businessName: string;
  category: string;
  isTest: boolean;
  isActive: boolean;
  deactivatedAt: string | null;
  onboardingStatus: string;
  subscriptionStatus: SubscriptionStatus | null;
  setupPaid: boolean | null;
  accessHealth: AccessHealth | null;
  campaignId: string | null;
  campaignName: string | null;
  campaignStatus: CampaignStatus | null;
  agreedBudgetAgorot: number | null;
  openRecommendations: number;
  // Same classification the customer-facing add-content 409 uses
  // (connection-readiness.ts) — null once a customer HAS a campaign,
  // access_health='ok', an ad account, and a Page; otherwise the reason
  // the operator would otherwise only discover after the customer hits a
  // wall themselves (confirmed live: an active, spending campaign whose
  // Page access was silently missing for weeks).
  connectionReadiness: ConnectionReadinessReason | null;
}

export async function listCustomers(pool: pg.Pool): Promise<CustomerListRow[]> {
  const { rows } = await pool.query(
    `SELECT c.id, c.business_name, c.category, c.is_test, c.is_active, c.deactivated_at, c.onboarding_status,
            s.status AS subscription_status, s.setup_paid,
            conn.access_health, conn.page_id,
            mc.id AS campaign_id, mc.name AS campaign_name, mc.status AS campaign_status, mc.agreed_budget_agorot,
            mc.meta_campaign_id, aa.meta_ad_account_id,
            COALESCE(r.open_recs, 0) AS open_recs
     FROM customers c
     LEFT JOIN subscriptions s      ON s.customer_id = c.id
     LEFT JOIN meta_connections conn ON conn.customer_id = c.id
     LEFT JOIN ad_accounts aa       ON aa.connection_id = conn.id
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
    isActive: r.is_active,
    deactivatedAt: r.deactivated_at ? new Date(r.deactivated_at).toISOString() : null,
    onboardingStatus: r.onboarding_status,
    subscriptionStatus: r.subscription_status ?? null,
    setupPaid: r.setup_paid ?? null,
    accessHealth: r.access_health ?? null,
    campaignId: r.campaign_id ?? null,
    campaignName: r.campaign_name ?? null,
    campaignStatus: r.campaign_status ?? null,
    agreedBudgetAgorot: r.agreed_budget_agorot ?? null,
    openRecommendations: Number(r.open_recs),
    connectionReadiness: classifyConnectionReadiness({
      campaignId: r.campaign_id ?? null,
      metaCampaignId: r.meta_campaign_id ?? null,
      accessHealth: r.access_health ?? null,
      metaAdAccountId: r.meta_ad_account_id ?? null,
      pageId: r.page_id ?? null,
    }),
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
  // AIC-64: the precise gate/threshold the engine blocked on, when there's no
  // outstanding recommendation to show instead — the operator's "is the agent
  // actually looking at this account?" answer.
  noRecReason: string | null;
  noRecDetail: Record<string, unknown> | null;
  // AIC-77a: this account's explicit rule-threshold overrides (sparse — only
  // overridden keys), and the fully-resolved effective set (override →
  // budget-relative formula → global default) the engine actually evaluates
  // against right now, so the admin edit form can show which values are
  // inherited vs overridden without re-deriving the resolution chain itself.
  thresholdOverrides: Record<string, number>;
  effectiveThresholds: RuleThresholds;
}

// Full per-customer view assembled from the real tables (AIC-16).
export async function getCustomerDetail(
  pool: pg.Pool,
  customerId: string,
): Promise<CustomerDetail | null> {
  const list = await pool.query(
    `SELECT c.*, s.status AS subscription_status, s.setup_paid, s.next_charge_date,
            conn.access_health, conn.page_id,
            mc.id AS campaign_id, mc.name AS campaign_name, mc.status AS campaign_status, mc.agreed_budget_agorot,
            mc.no_rec_reason, mc.no_rec_detail, mc.threshold_overrides, mc.live_budget_agorot,
            mc.meta_campaign_id, aa.meta_ad_account_id
     FROM customers c
     LEFT JOIN subscriptions s       ON s.customer_id = c.id
     LEFT JOIN meta_connections conn ON conn.customer_id = c.id
     LEFT JOIN ad_accounts aa        ON aa.connection_id = conn.id
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
    isActive: c.is_active,
    deactivatedAt: c.deactivated_at ? new Date(c.deactivated_at).toISOString() : null,
    onboardingStatus: c.onboarding_status,
    subscriptionStatus: c.subscription_status ?? null,
    setupPaid: c.setup_paid ?? null,
    accessHealth: c.access_health ?? null,
    campaignId: c.campaign_id ?? null,
    campaignName: c.campaign_name ?? null,
    campaignStatus: c.campaign_status ?? null,
    agreedBudgetAgorot: c.agreed_budget_agorot ?? null,
    openRecommendations: openRecs,
    connectionReadiness: classifyConnectionReadiness({
      campaignId: c.campaign_id ?? null,
      metaCampaignId: c.meta_campaign_id ?? null,
      accessHealth: c.access_health ?? null,
      metaAdAccountId: c.meta_ad_account_id ?? null,
      pageId: c.page_id ?? null,
    }),
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
    noRecReason: c.no_rec_reason ?? null,
    noRecDetail: c.no_rec_detail ?? null,
    thresholdOverrides: c.threshold_overrides ?? {},
    // Mirrors "Budget shown = liveBudgetAgorot ?? agreedBudgetAgorot"
    // (customer-overview.md) — the live-synced figure the engine actually
    // evaluates against, falling back to the agreed ceiling before the
    // engine's first tick.
    effectiveThresholds: resolveThresholds(c.threshold_overrides, c.live_budget_agorot ?? c.agreed_budget_agorot ?? 0),
  };
}
