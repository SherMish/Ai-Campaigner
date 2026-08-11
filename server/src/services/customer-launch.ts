import type pg from "pg";
import { activateCampaign, type ActivateResult } from "../launch/activate.js";
import type { LaunchWriter } from "../launch/types.js";

// The customer-facing side of the launch gate (AIC-53): what a customer sees
// before approving, and the approve action itself. Scoped entirely from the
// caller's own JWT — never a client-supplied campaignId, so there is nothing
// to check ownership of.

export interface LaunchSummary {
  campaignId: string;
  name: string;
  dailyBudgetAgorot: number;
  budgetPeriod: "daily" | "monthly";
  whatsappDestination: string;
  adCount: number;
}

// A campaign is "pending launch" when it's passed first-campaign review
// (status='active') but the customer hasn't approved activation yet
// (launch_approved_at IS NULL) and it's actually linked to a real Meta
// campaign. Returns null when there's nothing pending — the common case.
export async function getPendingLaunch(pool: pg.Pool, userId: string): Promise<LaunchSummary | null> {
  const { rows } = await pool.query<{
    id: string;
    name: string;
    agreed_budget_agorot: number;
    budget_period: "daily" | "monthly";
    whatsapp_destination: string;
    ad_count: string;
  }>(
    `SELECT mc.id, mc.name, mc.agreed_budget_agorot, mc.budget_period, mc.whatsapp_destination,
            (SELECT COUNT(*) FROM action_history ah WHERE ah.campaign_id = mc.id AND ah.action_type = 'create_ad') AS ad_count
     FROM app_users u
     JOIN managed_campaigns mc ON mc.customer_id = u.customer_id
     WHERE u.id = $1 AND mc.status = 'active' AND mc.launch_approved_at IS NULL AND mc.meta_campaign_id IS NOT NULL`,
    [userId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    campaignId: r.id,
    name: r.name,
    dailyBudgetAgorot: r.agreed_budget_agorot,
    budgetPeriod: r.budget_period,
    whatsappDestination: r.whatsapp_destination,
    adCount: Number(r.ad_count),
  };
}

export async function approveLaunch(
  pool: pg.Pool,
  writer: LaunchWriter,
  userId: string,
): Promise<ActivateResult | { outcome: "not_found" }> {
  const pending = await getPendingLaunch(pool, userId);
  if (!pending) return { outcome: "not_found" };
  return activateCampaign(pool, writer, pending.campaignId, "customer");
}
