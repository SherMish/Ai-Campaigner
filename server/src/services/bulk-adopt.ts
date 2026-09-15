import type { DiscoveredCampaign } from "../meta/campaign-discovery.js";

// AIC-190 — which of an ad account's campaigns the wizard imports, and why it
// skips the rest.
//
// Pure, so the rules are testable and so the preview the operator confirms is
// computed by exactly the code the import then runs. A preview built by one
// function and an import done by another is a preview that can lie.

export type SkipReason =
  | "no_ad_sets"
  | "mixed_ad_sets"
  | "unrecognized_objective"
  | "deleted"
  | "no_budget"
  | "missing_whatsapp";

export interface PlannedCampaign {
  metaCampaignId: string;
  campaignName: string;
  objective: "leads" | "engagement";
  agreedBudgetAgorot: number;
  /** Where the budget came from — shown in the preview so the operator can see
   *  which ceilings are Meta's and which are the one they typed. */
  budgetSource: "meta" | "fallback";
  destinationType: "whatsapp" | "website" | "engagement";
  messagingChannel: string | null;
  leadEventTypes: string[] | null;
  trackingPixelId: string | null;
  effectiveStatus: string;
}

export interface SkippedCampaign {
  metaCampaignId: string;
  campaignName: string;
  reason: SkipReason;
}

export interface BulkPlan {
  adopt: PlannedCampaign[];
  skip: SkippedCampaign[];
}

export interface SharedFields {
  /** The business's WhatsApp number — one per business, not per campaign. */
  whatsappDestination: string | null;
  /** The agreed ceiling for campaigns with no campaign-level budget on Meta
   *  (boosted posts, ad-set budgets). Agorot. */
  fallbackBudgetAgorot: number | null;
}

// Gone from Meta's point of view. Importing one would put a campaign in the
// customer's switcher that can never deliver again.
const DEAD = new Set(["DELETED", "ARCHIVED"]);

export function planBulkAdoption(campaigns: DiscoveredCampaign[], shared: SharedFields): BulkPlan {
  const adopt: PlannedCampaign[] = [];
  const skip: SkippedCampaign[] = [];
  const whatsapp = shared.whatsappDestination?.trim() || null;
  const fallback =
    Number.isInteger(shared.fallbackBudgetAgorot) && (shared.fallbackBudgetAgorot as number) > 0
      ? (shared.fallbackBudgetAgorot as number)
      : null;

  for (const c of campaigns) {
    const base = { metaCampaignId: c.id, campaignName: c.name };

    if (DEAD.has(c.effectiveStatus.toUpperCase()) || DEAD.has(c.status.toUpperCase())) {
      skip.push({ ...base, reason: "deleted" });
      continue;
    }

    // Skip, never guess. An undetectable destination imported as "whatsapp"
    // by default would count the wrong action as a lead, and the dashboard
    // would report a working campaign as a failing one (AIC-87/88).
    const d = c.destination;
    if (!d.supported) {
      skip.push({ ...base, reason: d.reason });
      continue;
    }

    const own = c.dailyBudgetAgorot != null && c.dailyBudgetAgorot > 0 ? c.dailyBudgetAgorot : null;
    const budget = own ?? fallback;
    if (budget == null) {
      skip.push({ ...base, reason: "no_budget" });
      continue;
    }

    if (d.destinationType === "whatsapp" && !whatsapp) {
      skip.push({ ...base, reason: "missing_whatsapp" });
      continue;
    }

    adopt.push({
      ...base,
      // Our vocabulary, derived from what the campaign DOES rather than from
      // Meta's objective string: every existing row holds 'leads' or
      // 'engagement', and a new value such as 'traffic' is one nothing reads.
      objective: d.destinationType === "engagement" ? "engagement" : "leads",
      agreedBudgetAgorot: budget,
      budgetSource: own != null ? "meta" : "fallback",
      destinationType: d.destinationType,
      messagingChannel: d.destinationType === "whatsapp" ? d.messagingChannel : null,
      leadEventTypes: d.destinationType === "whatsapp" ? null : d.leadEventTypes,
      trackingPixelId: d.destinationType === "website" ? d.trackingPixelId : null,
      effectiveStatus: c.effectiveStatus,
    });
  }

  return { adopt, skip };
}
