import type pg from "pg";
import type { Agorot, CampaignStatus } from "@aic/shared";
import { buildCampaignReadout, type CampaignReadout } from "./readout.js";
import {
  listCustomerActionHistory,
  condense,
  type CondensedEntry,
} from "./action-history.js";
import { getLeadQualityStatus, type LeadQualityStatus } from "./lead-quality-review.js";

// What the logged-in customer's Home + Settings screens render from. Assembled
// from the customer's own rows (never another customer's) + the snapshot-based
// readout. Everything is read-only; no live Meta call at render time.
export type AccessHealth = "ok" | "revoked" | "invalid" | "needs_reconnect";
export type HomeState = "ok" | "collecting" | "paused" | "attention" | "no_campaign" | "ready_to_launch" | "stopped";

export interface CustomerOverview {
  account: { name: string; email: string };
  customer: {
    id: string;
    businessName: string;
    onboardingStatus: string;
    contactName: string;
    contactEmail: string;
  } | null;
  connection: {
    accessHealth: AccessHealth;
    adAccount: { metaAdAccountId: string; name: string; currency: string } | null;
    pageId: string | null;
    instagramId: string | null;
  } | null;
  campaign: {
    id: string;
    name: string;
    status: CampaignStatus;
    objective: string;
    agreedBudgetAgorot: Agorot;
    budgetPeriod: "daily" | "monthly";
    automationEnabled: boolean;
    deliveryOk: boolean;
    // AIC-53: review-approved (status='active') but the customer hasn't
    // approved activation yet — the campaign is still PAUSED on Meta.
    readyToLaunch: boolean;
    // AIC-64: why the engine's last tick had nothing to propose — null before
    // the engine has ever run, or when an acting recommendation exists instead.
    noRecReason: string | null;
    noRecDetail: Record<string, unknown> | null;
    // The live-read Meta daily budget, cached every generation tick — the
    // number to actually show the customer. `agreedBudgetAgorot` is the
    // engine's own safety ceiling and can legitimately differ (it only ever
    // auto-rises to match live, never auto-lowers). Null before the engine's
    // first tick for this campaign.
    liveBudgetAgorot: Agorot | null;
    // AIC-71: is anything actually showing right now, and how many ads —
    // computed the same tick as deliveryOk, from real ad/ad-set status, not
    // `status` (a DB "we manage this" flag) or historical spend. Defaults to
    // true/null until the engine's first tick for this campaign.
    delivering: boolean;
    deliveringAdCount: number | null;
  } | null;
  subscription: {
    plan: string;
    status: string;
    setupPaid: boolean;
    monthlyAmountAgorot: Agorot;
    nextChargeDate: string | null;
  } | null;
  readout: CampaignReadout | null;
  // AIC-67: incremental delta-review watermark — null when there's no campaign.
  leadQuality: LeadQualityStatus | null;
  recentActivity: CondensedEntry[];
  pendingRecommendations: number;
  // Which kind of "needs attention" the customer sees, so Home shows the right
  // message: a lost Meta connection vs a delivery problem (AIC-39).
  attentionKind: "connection" | "delivery" | null;
  homeState: HomeState;
}

// Derive the single Home headline state from the customer's real rows. Order
// matters: a lost connection or an attention/paused campaign outranks "how much
// data do we have," and "still collecting" outranks "all good."
function deriveHomeState(
  campaign: CustomerOverview["campaign"],
  connection: CustomerOverview["connection"],
  readout: CampaignReadout | null,
): HomeState {
  if (!campaign) return "no_campaign";
  if (connection && connection.accessHealth !== "ok") return "attention";
  // AIC-53: review-approved but not yet customer-activated outranks delivery/
  // collecting — a still-PAUSED campaign has no delivery data to judge yet,
  // and the one actionable thing is the launch approval itself.
  if (campaign.readyToLaunch) return "ready_to_launch";
  if (!campaign.deliveryOk) return "attention"; // a not-delivering ad set (AIC-39)
  if (campaign.status === "paused") return "paused";
  if (campaign.status === "needs_attention" || campaign.status === "connection_problem")
    return "attention";
  // AIC-71: nothing delivering isn't a problem (AIC-39 already caught real
  // errors above) and isn't "we manage this" (campaign.status, checked above)
  // — it's the honest "you (or nothing) turned this off" reading of live ad/
  // ad-set status. Outranks `collecting`: a campaign with everything paused
  // will never accumulate data no matter how long we wait.
  if (!campaign.delivering) return "stopped";
  const hasData =
    !!readout &&
    (readout.current.spendAgorot > 0 ||
      readout.current.leads > 0 ||
      readout.perCreative.length > 0);
  if (!hasData) return "collecting";
  return "ok";
}

export async function buildCustomerOverview(
  pool: pg.Pool,
  userId: string,
  ref: Date = new Date(),
): Promise<CustomerOverview | null> {
  const user = await pool.query<{
    name: string;
    email: string;
    customer_id: string | null;
  }>(`SELECT name, email, customer_id FROM app_users WHERE id = $1`, [userId]);
  if (user.rows.length === 0) return null;
  const account = {
    name: user.rows[0].name ?? "",
    email: user.rows[0].email,
  };
  const customerId = user.rows[0].customer_id;

  // No linked customer yet (account created, onboarding not provisioned).
  if (!customerId) {
    return {
      account,
      customer: null,
      connection: null,
      campaign: null,
      subscription: null,
      readout: null,
      leadQuality: null,
      recentActivity: [],
      pendingRecommendations: 0,
      attentionKind: null,
      homeState: "no_campaign",
    };
  }

  const [custRes, connRes, campRes, subRes] = await Promise.all([
    pool.query<{
      id: string;
      business_name: string;
      onboarding_status: string;
      contact_name: string;
      contact_email: string;
    }>(
      `SELECT id, business_name, onboarding_status, contact_name, contact_email
       FROM customers WHERE id = $1`,
      [customerId],
    ),
    pool.query<{
      access_health: AccessHealth;
      page_id: string | null;
      instagram_id: string | null;
      meta_ad_account_id: string | null;
      ad_account_name: string | null;
      currency: string | null;
    }>(
      `SELECT mc.access_health, mc.page_id, mc.instagram_id,
              aa.meta_ad_account_id, aa.name AS ad_account_name, aa.currency
       FROM meta_connections mc
       LEFT JOIN ad_accounts aa ON aa.connection_id = mc.id
       WHERE mc.customer_id = $1
       ORDER BY aa.created_at ASC
       LIMIT 1`,
      [customerId],
    ),
    pool.query<{
      id: string;
      name: string;
      status: CampaignStatus;
      objective: string;
      agreed_budget_agorot: number;
      budget_period: "daily" | "monthly";
      automation_enabled: boolean;
      delivery_ok: boolean;
      launch_approved_at: Date | null;
      meta_campaign_id: string | null;
      no_rec_reason: string | null;
      no_rec_detail: Record<string, unknown> | null;
      live_budget_agorot: number | null;
      delivering: boolean;
      delivering_ad_count: number | null;
      leads_to_date: number | null;
    }>(
      `SELECT id, name, status, objective, agreed_budget_agorot, budget_period, automation_enabled, delivery_ok, launch_approved_at, meta_campaign_id, no_rec_reason, no_rec_detail, live_budget_agorot, delivering, delivering_ad_count, leads_to_date
       FROM managed_campaigns WHERE customer_id = $1`,
      [customerId],
    ),
    pool.query<{
      plan: string;
      status: string;
      setup_paid: boolean;
      monthly_amount_agorot: number;
      next_charge_date: string | null;
    }>(
      `SELECT plan, status, setup_paid, monthly_amount_agorot, next_charge_date
       FROM subscriptions WHERE customer_id = $1`,
      [customerId],
    ),
  ]);

  const customer = custRes.rows[0]
    ? {
        id: custRes.rows[0].id,
        businessName: custRes.rows[0].business_name,
        onboardingStatus: custRes.rows[0].onboarding_status,
        contactName: custRes.rows[0].contact_name,
        contactEmail: custRes.rows[0].contact_email,
      }
    : null;

  const connection = connRes.rows[0]
    ? {
        accessHealth: connRes.rows[0].access_health,
        adAccount: connRes.rows[0].meta_ad_account_id
          ? {
              metaAdAccountId: connRes.rows[0].meta_ad_account_id,
              name: connRes.rows[0].ad_account_name ?? "",
              currency: connRes.rows[0].currency ?? "ILS",
            }
          : null,
        pageId: connRes.rows[0].page_id,
        instagramId: connRes.rows[0].instagram_id,
      }
    : null;

  const campaign = campRes.rows[0]
    ? {
        id: campRes.rows[0].id,
        name: campRes.rows[0].name,
        status: campRes.rows[0].status,
        objective: campRes.rows[0].objective,
        agreedBudgetAgorot: Number(campRes.rows[0].agreed_budget_agorot),
        budgetPeriod: campRes.rows[0].budget_period,
        automationEnabled: campRes.rows[0].automation_enabled,
        deliveryOk: campRes.rows[0].delivery_ok,
        readyToLaunch:
          campRes.rows[0].status === "active" &&
          campRes.rows[0].launch_approved_at === null &&
          campRes.rows[0].meta_campaign_id !== null,
        noRecReason: campRes.rows[0].no_rec_reason,
        noRecDetail: campRes.rows[0].no_rec_detail,
        liveBudgetAgorot: campRes.rows[0].live_budget_agorot,
        delivering: campRes.rows[0].delivering,
        deliveringAdCount: campRes.rows[0].delivering_ad_count,
      }
    : null;

  const subscription = subRes.rows[0]
    ? {
        plan: subRes.rows[0].plan,
        status: subRes.rows[0].status,
        setupPaid: subRes.rows[0].setup_paid,
        monthlyAmountAgorot: Number(subRes.rows[0].monthly_amount_agorot),
        nextChargeDate: subRes.rows[0].next_charge_date,
      }
    : null;

  const readout = campaign
    ? await buildCampaignReadout(pool, campaign.id, ref)
    : null;

  // AIC-67: "leads to date" is all-time cumulative, not this-week's — the
  // watermark tracks net-new leads regardless of week boundaries, so there's
  // no "does the counter reset on Monday" edge case to get wrong.
  //
  // Read from the cached `leads_to_date` column (generation.ts's tick,
  // leads-to-date.ts), NEVER by summing insight_snapshots: those rows are
  // OVERLAPPING rolling-7-day windows (a new one written every day, shifted
  // by one day), so summing them multiplies real leads by however many
  // overlapping snapshots exist for the period — a real bug, caught live
  // (1 real lead read back as "3 to review"). Null before the engine's first
  // tick for this campaign — reads as 0 pending until then, same convention
  // as deliveringAdCount/liveBudgetAgorot.
  const leadQuality = campaign
    ? await getLeadQualityStatus(pool, campaign.id, campRes.rows[0].leads_to_date ?? 0, ref)
    : null;

  const recentActivity = condense(
    await listCustomerActionHistory(pool, customerId),
  ).slice(0, 8);

  const pendingRecommendations = campaign
    ? Number(
        (
          await pool.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM recommendations WHERE campaign_id = $1 AND state = 'proposed'`,
            [campaign.id],
          )
        ).rows[0].n,
      )
    : 0;

  const attentionKind: "connection" | "delivery" | null =
    connection && connection.accessHealth !== "ok"
      ? "connection"
      : campaign && !campaign.deliveryOk
        ? "delivery"
        : null;

  return {
    account,
    customer,
    connection,
    campaign,
    subscription,
    readout,
    leadQuality,
    recentActivity,
    pendingRecommendations,
    attentionKind,
    homeState: deriveHomeState(campaign, connection, readout),
  };
}
