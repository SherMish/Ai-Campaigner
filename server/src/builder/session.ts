import type pg from "pg";
import { GraphCampaignAdapter } from "../meta/campaign-adapter.js";
import type { BuilderWriter } from "./types.js";
import type { CreativeWriter } from "./creative-types.js";

// What the guided builder (AIC-52) needs to know before it can do anything:
// a healthy, connected Meta ad account + Page, and no campaign yet (the
// builder is for a customer's FIRST campaign only — matches
// startBuilderCampaign's UNIQUE(customer_id) constraint on managed_campaigns).
export interface BuilderContext {
  customerId: string;
  // AIC-106 — read from the customer record, never operator-entered. See the
  // note in contextFromRow: this is what the creation confirmation names.
  businessName: string;
  // The agreed ceiling from provisioning, so the budget step can refuse an
  // over-ceiling number where it is typed rather than at the end of the
  // wizard. null when none is set yet.
  agreedBudgetAgorot: number | null;
  category: string; // free text (AIC-44 manual onboarding), may be ''
  adAccountUuid: string; // ad_accounts.id — the FK managed_campaigns.ad_account_id needs
  metaAdAccountId: string; // "act_..." — what every real Meta API call needs
  pageId: string;
}

interface ReadinessRow {
  category: string | null;
  business_name: string | null;
  // AIC-106 follow-up, found live: the wizard let an operator enter ₪40/day
  // against an agreed ceiling of ₪20 and only refused on the FINAL click,
  // after the whole wizard was filled. The ceiling has to be known at the
  // budget STEP, so it travels with the context.
  agreed_budget_agorot: number | string | null;
  already_has_campaign: boolean;
  access_health: string | null;
  ad_account_uuid: string | null;
  meta_ad_account_id: string | null;
  page_id: string | null;
}

// Shared by both resolvers below: a connection with no campaign yet, healthy
// access, and both an ad account + Page is what "ready to build" MEANS —
// whether the caller got here via their own JWT or an operator acting on
// their behalf (AIC-105 Branch A).
function contextFromRow(customerId: string, r: ReadinessRow | undefined): BuilderContext | null {
  if (!r || r.already_has_campaign) return null;
  if (r.access_health !== "ok" || !r.ad_account_uuid || !r.meta_ad_account_id || !r.page_id) return null;
  return {
    customerId,
    // AIC-106 — the confirmation shown at creation names the customer, and
    // that name must come from the RECORD being provisioned, never from
    // operator-entered text. It is the only thing that catches building
    // against the wrong customer once the launch gate is gone, so a name the
    // operator typed themselves would confirm nothing.
    businessName: r.business_name ?? "",
    agreedBudgetAgorot: r.agreed_budget_agorot == null ? null : Number(r.agreed_budget_agorot),
    category: r.category ?? "",
    adAccountUuid: r.ad_account_uuid,
    metaAdAccountId: r.meta_ad_account_id,
    pageId: r.page_id,
  };
}

// Returns null (never throws) when the customer isn't ready to build — no
// connection, an unhealthy one, missing ad account/Page, or a campaign
// already exists — so every route can respond with an honest 409 instead of
// crashing partway through a build or silently creating on a broken account.
export async function resolveBuilderContext(pool: pg.Pool, userId: string): Promise<BuilderContext | null> {
  const { rows } = await pool.query<{ customer_id: string | null } & ReadinessRow>(
    `SELECT u.customer_id, c.category, c.business_name,
            (SELECT mc.agreed_budget_agorot FROM managed_campaigns mc
              WHERE mc.customer_id = u.customer_id AND mc.meta_campaign_id IS NULL
              ORDER BY mc.created_at LIMIT 1) AS agreed_budget_agorot,
            EXISTS(SELECT 1 FROM managed_campaigns mc WHERE mc.customer_id = u.customer_id AND mc.meta_campaign_id IS NOT NULL) AS already_has_campaign,
            conn.access_health, aa.id AS ad_account_uuid, aa.meta_ad_account_id, conn.page_id
     FROM app_users u
     LEFT JOIN customers c ON c.id = u.customer_id
     LEFT JOIN meta_connections conn ON conn.customer_id = u.customer_id
     LEFT JOIN ad_accounts aa ON aa.connection_id = conn.id
     WHERE u.id = $1
     ORDER BY aa.created_at ASC
     LIMIT 1`,
    [userId],
  );
  const r = rows[0];
  if (!r?.customer_id) return null;
  return contextFromRow(r.customer_id, r);
}

// AIC-105 Branch A: the same readiness check, keyed on customerId directly
// instead of a JWT-bound userId — what the admin builder routes use when an
// operator builds a customer's FIRST campaign on their behalf (a customer
// with no self-serve login yet, or one on the phone with an operator during
// onboarding). Never trusts a client-supplied customerId as authorization —
// every caller sits behind requireAdmin; this only resolves READINESS.
export async function resolveBuilderContextForCustomer(pool: pg.Pool, customerId: string): Promise<BuilderContext | null> {
  const { rows } = await pool.query<ReadinessRow>(
    `SELECT c.category, c.business_name,
            (SELECT mc.agreed_budget_agorot FROM managed_campaigns mc
              WHERE mc.customer_id = c.id AND mc.meta_campaign_id IS NULL
              ORDER BY mc.created_at LIMIT 1) AS agreed_budget_agorot,
            EXISTS(SELECT 1 FROM managed_campaigns mc WHERE mc.customer_id = c.id AND mc.meta_campaign_id IS NOT NULL) AS already_has_campaign,
            conn.access_health, aa.id AS ad_account_uuid, aa.meta_ad_account_id, conn.page_id
     FROM customers c
     LEFT JOIN meta_connections conn ON conn.customer_id = c.id
     LEFT JOIN ad_accounts aa ON aa.connection_id = conn.id
     WHERE c.id = $1
     ORDER BY aa.created_at ASC
     LIMIT 1`,
    [customerId],
  );
  return contextFromRow(customerId, rows[0]);
}

// A local shell row (managed_campaigns) belongs to the caller and only the
// caller — every write route checks this before touching it.
export async function ownsLocalCampaign(pool: pg.Pool, customerId: string, localCampaignId: string | undefined): Promise<boolean> {
  if (!localCampaignId) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM managed_campaigns WHERE id = $1 AND customer_id = $2`,
    [localCampaignId, customerId],
  );
  return rows.length > 0;
}

// Same token-gated factory pattern as buildCustomerExecutor
// (customer-recommendations.ts): no META_SYSTEM_USER_TOKEN → null, so the
// route can report an honest "temporarily unavailable" instead of pretending.
export function buildBuilderWriter(): (BuilderWriter & CreativeWriter) | null {
  const token = process.env.META_SYSTEM_USER_TOKEN;
  if (!token) return null;
  const ver = process.env.META_GRAPH_VERSION || "v21.0";
  return new GraphCampaignAdapter(token, ver);
}
