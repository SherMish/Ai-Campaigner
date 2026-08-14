import { shekelToAgorot, type Agorot } from "@aic/shared";
import type { RawInsightRow, InsightsPeriod } from "./types.js";

// ── Lead definition (AIC-6, made per-campaign by AIC-87) ──────────────────
// The DEFAULT is the P0 shape: Leads-objective, Click-to-WhatsApp, where the
// countable lead is the messaging-conversation-started event. We prefer the
// 7-day-attribution variant when present, else the un-suffixed type — never
// summing both (that would double count). No WhatsApp reading, no
// individual-lead tracking (PRD forbids both).
export const LEAD_ACTION_PRIORITY = [
  "onsite_conversion.messaging_conversation_started_7d",
  "onsite_conversion.messaging_conversation_started",
] as const;

// AIC-87: `priority` is the campaign's own lead definition
// (`managed_campaigns.lead_event_types`), because "what counts as a lead" is a
// property of the campaign, not of the product. A conversion-optimized campaign
// reports e.g. `offsite_conversion.fb_pixel_complete_registration` and counted
// ZERO under the old hardcoded constant — a working campaign rendered as a
// failing one.
//
// It stays a LIST, not a single type, because first-match-wins is the whole
// point: Meta reports the same conversion under several aliases at once
// (`offsite_conversion.fb_pixel_*`, `omni_*`, the bare name), so summing across
// types would multiply one real lead into several. Taking only the first match
// present is what keeps the count honest — for the WhatsApp pair AND for any
// per-campaign list.
//
// Defaulted, so every existing call site and test keeps today's behaviour
// unchanged (the same trick as `evaluateCampaign(ev, thresholds = …)`, AIC-77a).
export function extractLeads(
  actions?: Array<{ action_type: string; value: string }>,
  priority: readonly string[] = LEAD_ACTION_PRIORITY,
): number {
  if (!actions?.length) return 0;
  for (const type of priority) {
    const matches = actions.filter((a) => a.action_type === type);
    if (matches.length) {
      return matches.reduce((sum, a) => sum + Math.round(Number(a.value) || 0), 0);
    }
  }
  return 0;
}

// ── CPL ───────────────────────────────────────────────────────────────────
// cost per lead = spend / leads, in agorot. NULL when there are no leads (an
// honest "no data" rather than a divide-by-zero or a misleading 0).
export function computeCpl(spendAgorot: Agorot, leads: number): Agorot | null {
  if (leads <= 0) return null;
  return Math.round(spendAgorot / leads);
}

// ── Normalization ─────────────────────────────────────────────────────────
export interface SnapshotUpsert {
  campaignId: string;
  grain: RawInsightRow["grain"];
  metaObjectId: string;
  parentMetaId: string | null;
  creativeName: string | null;
  periodStart: string;
  periodEnd: string;
  spendAgorot: Agorot;
  leads: number;
  cplAgorot: Agorot | null;
  impressions: number;
  linkClicks: number;
  deliveryStatus: string;
  raw: Record<string, unknown>;
}

// Turn one raw Insights row into a snapshot upsert. Spend (currency-unit string)
// becomes integer agorot; leads/CPL come from the definitions above.
export function normalizeRow(
  row: RawInsightRow,
  campaignId: string,
  period: InsightsPeriod,
  // AIC-87: the campaign's own `lead_event_types`, threaded down from
  // `managed_campaigns` through `ManagedCampaignRef`. Undefined (not passed)
  // falls through to `extractLeads`' own default — the WhatsApp pair.
  leadEventTypes?: readonly string[],
): SnapshotUpsert {
  const spendAgorot = shekelToAgorot(Number(row.spend) || 0);
  const leads = extractLeads(row.actions, leadEventTypes);
  return {
    campaignId,
    grain: row.grain,
    metaObjectId: row.objectId,
    parentMetaId: row.parentId ?? null,
    creativeName: row.name ?? null,
    periodStart: period.start,
    periodEnd: period.end,
    spendAgorot,
    leads,
    cplAgorot: computeCpl(spendAgorot, leads),
    impressions: Math.round(Number(row.impressions) || 0),
    linkClicks: Math.round(Number(row.inlineLinkClicks) || 0),
    deliveryStatus: row.deliveryStatus ?? "",
    raw: row.raw ?? {},
  };
}
