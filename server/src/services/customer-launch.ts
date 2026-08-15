import type pg from "pg";
import { activateCampaign, type ActivateResult } from "../launch/activate.js";
import type { LaunchWriter } from "../launch/types.js";
import { resolveLaunchDestination, type LaunchDestination } from "./launch-destination.js";
import type { DeliveryReader } from "../meta/delivery-health.js";
import { refreshDeliveryNow } from "./delivery-monitor.js";
import type { OpsQueue } from "./ops-queue.js";

// The customer-facing side of the launch gate (AIC-53): what a customer sees
// before approving, and the approve action itself. Scoped entirely from the
// caller's own JWT — never a client-supplied campaignId, so there is nothing
// to check ownership of.
//
// This screen is a CONSENT surface. Every row exists so the customer can check
// "is this what I think I'm approving?" before real money starts moving, so
// two rules apply that don't apply elsewhere:
//   1. Never render a fact we don't have. A blank value beside a confident
//      label is worse than no row — it asserts something untrue.
//   2. If we cannot verify a precondition, BLOCK the approval rather than show
//      a technically-true value next to an enabled button.

// Why approval is not currently possible. Empty array = safe to launch.
export type LaunchBlocker =
  // Zero live ads on Meta: approving would spend nothing and do nothing.
  | "no_ads"
  // We can't say where leads will arrive (see resolveLaunchDestination).
  | "unknown_destination"
  // We couldn't reach Meta to check either of the above. Not the same as
  // "everything is fine" — it's "we don't know", and it blocks for the same
  // reason a null verdict does in tracking-health (AIC-88).
  | "verification_unavailable";

export interface LaunchSummary {
  campaignId: string;
  name: string;
  dailyBudgetAgorot: number;
  budgetPeriod: "daily" | "monthly";
  destination: LaunchDestination;
  // Live ad count from Meta, or null when Meta couldn't be reached. Was
  // previously COUNT(*) over action_history rows with action_type='create_ad'
  // — i.e. ads WE created through the builder, which reads 0 for any campaign
  // connected from outside the builder even when real ads exist.
  adCount: number | null;
  blockers: LaunchBlocker[];
}

// The narrow live reads this gate needs. Both are already implemented by
// GraphCampaignAdapter; declared here so tests can pass a plain object.
export interface LaunchStateReader {
  getCampaignState(metaCampaignId: string): Promise<{ adStatuses: Record<string, "active" | "paused"> }>;
  getPixelTopHost(pixelId: string): Promise<string | null>;
}

// A campaign is "pending launch" when it's passed first-campaign review
// (status='active') but the customer hasn't approved activation yet
// (launch_approved_at IS NULL) and it's actually linked to a real Meta
// campaign. Returns null when there's nothing pending — the common case.
export async function getPendingLaunch(
  pool: pg.Pool,
  userId: string,
  reader?: LaunchStateReader | null,
): Promise<LaunchSummary | null> {
  const { rows } = await pool.query<{
    id: string;
    name: string;
    meta_campaign_id: string;
    agreed_budget_agorot: number;
    budget_period: "daily" | "monthly";
    whatsapp_destination: string;
    lead_event_types: string[];
    tracking_pixel_id: string | null;
  }>(
    `SELECT mc.id, mc.name, mc.meta_campaign_id, mc.agreed_budget_agorot, mc.budget_period,
            mc.whatsapp_destination, mc.lead_event_types, mc.tracking_pixel_id
     FROM app_users u
     JOIN managed_campaigns mc ON mc.customer_id = u.customer_id
     WHERE u.id = $1 AND mc.status = 'active' AND mc.launch_approved_at IS NULL AND mc.meta_campaign_id IS NOT NULL`,
    [userId],
  );
  const r = rows[0];
  if (!r) return null;

  // Live Meta reads. Each is independently fail-open into "unknown" rather than
  // throwing the whole summary away — the customer should still see the budget
  // and name, with the approval blocked and the reason stated.
  let adCount: number | null = null;
  let domain: string | null = null;
  if (reader) {
    try {
      const state = await reader.getCampaignState(r.meta_campaign_id);
      adCount = Object.keys(state.adStatuses ?? {}).length;
    } catch {
      adCount = null;
    }
    if (r.tracking_pixel_id) {
      try {
        domain = await reader.getPixelTopHost(r.tracking_pixel_id);
      } catch {
        domain = null; // context only — never blocks
      }
    }
  }

  const destination = resolveLaunchDestination({
    whatsappDestination: r.whatsapp_destination,
    leadEventTypes: r.lead_event_types ?? [],
    domain,
  });

  const blockers: LaunchBlocker[] = [];
  if (destination.kind === "unknown") blockers.push("unknown_destination");
  if (adCount === null) blockers.push("verification_unavailable");
  else if (adCount === 0) blockers.push("no_ads");

  return {
    campaignId: r.id,
    name: r.name,
    dailyBudgetAgorot: r.agreed_budget_agorot,
    budgetPeriod: r.budget_period,
    destination,
    adCount,
    blockers,
  };
}

export async function approveLaunch(
  pool: pg.Pool,
  writer: LaunchWriter,
  userId: string,
  reader?: (LaunchStateReader & DeliveryReader) | null,
  ops?: OpsQueue,
): Promise<ActivateResult | { outcome: "not_found" } | { outcome: "blocked"; blockers: LaunchBlocker[] }> {
  const pending = await getPendingLaunch(pool, userId, reader);
  if (!pending) return { outcome: "not_found" };
  // Enforced server-side, not just by a disabled button: the UI can be
  // bypassed, and this is the gate that turns on real spending.
  if (pending.blockers.length > 0) {
    return { outcome: "blocked", blockers: pending.blockers };
  }
  const result = await activateCampaign(pool, writer, pending.campaignId, "customer");

  // Bug fix, 2026-08-15, found live: activateCampaign only writes to Meta —
  // the cached delivery/status columns aren't touched, so they stayed at
  // whatever the last hourly tick saw (typically "still paused, nothing
  // delivering"). A customer who just approved launch — the single most
  // consequential action available — saw the dashboard confidently claim
  // nothing was showing, while real ads had gone ACTIVE on Meta seconds
  // earlier. Same refresh-in-request fix AIC-71 already applied to manual
  // pause/resume (`routes/controls.ts`); `delivery-monitor.ts`'s own doc
  // comment on `refreshDeliveryNow` predicts this exact symptom for any
  // write path that skips it — this was the one that still did.
  if (result.outcome === "activated" && reader && ops) {
    const row = await pool.query<{ customer_id: string | null; meta_campaign_id: string }>(
      `SELECT customer_id, meta_campaign_id FROM managed_campaigns WHERE id = $1`,
      [pending.campaignId],
    );
    if (row.rows[0]) {
      await refreshDeliveryNow({
        pool, ops, deliveryReader: reader, campaignId: pending.campaignId,
        customerId: row.rows[0].customer_id, metaCampaignId: row.rows[0].meta_campaign_id,
      });
    }
  }

  return result;
}
