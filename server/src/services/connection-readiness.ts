import { FIXED_DESTINATION, WEBSITE_DESTINATION, missingRequiredFields, type CampaignRequiredField } from "@aic/shared";

// Why a customer's Meta connection can't support content writes right now —
// originally built for the customer-facing add-content 409 (AIC-63 follow-up,
// additions/session.ts's resolveAdditionAvailability), pulled out into its own
// pure function so the admin console can show the SAME classification per
// customer instead of re-deriving a second, driftable copy of the same four
// checks. One definition; two consumers (a customer hitting the wall
// themselves, and an operator scanning the fleet before that happens).
//
// AIC-103: "incomplete_config" is a FIFTH, deliberately-last reason — a
// campaign missing a type-required field (managed_campaigns.website_url on a
// Pixel campaign, whatsapp_destination on a WhatsApp one). Found live:
// free_beta_signups_leads passed every earlier check (real campaign,
// launched, healthy connection, Page present) and still couldn't take a
// write, because the ONE thing missing was config we hold, not a connection
// problem. Distinct from connection_issue on purpose — the customer-facing
// copy for these two must never be the same: a connection problem is
// (sometimes) something the customer's Meta side can fix; incomplete_config
// never is, since every field the table names is something WE provision.
export type ConnectionReadinessReason = "no_campaign" | "not_launched" | "missing_page" | "connection_issue" | "incomplete_config";

export interface ConnectionReadinessInput {
  campaignId: string | null;
  metaCampaignId: string | null;
  accessHealth: string | null;
  metaAdAccountId: string | null;
  pageId: string | null;
  // Optional on purpose: callers that only need the original four checks
  // (e.g. a caller with no campaign row to derive these from yet) can omit
  // them entirely and simply never see "incomplete_config" — never a forced
  // false negative from treating "unknown" as "complete".
  isMessaging?: boolean;
  whatsappDestination?: string | null;
  websiteUrl?: string | null;
  trackingPixelId?: string | null;
  leadEventTypes?: string[] | null;
}

// null = fully ready (a real campaign, linked, healthy connection, ad
// account, Page, and complete type-required config all present) — the ONLY
// case that isn't a reason.
export function classifyConnectionReadiness(input: ConnectionReadinessInput): ConnectionReadinessReason | null {
  if (!input.campaignId) return "no_campaign";
  if (!input.metaCampaignId) return "not_launched";
  if (input.accessHealth !== "ok" || !input.metaAdAccountId) return "connection_issue";
  if (!input.pageId) return "missing_page";
  if (input.isMessaging !== undefined) {
    const destination = input.isMessaging ? FIXED_DESTINATION : WEBSITE_DESTINATION;
    const missing = missingRequiredFields(destination, {
      whatsappDestination: input.whatsappDestination ?? null,
      websiteUrl: input.websiteUrl ?? null,
      trackingPixelId: input.trackingPixelId ?? null,
      leadEventTypes: input.leadEventTypes ?? null,
    });
    if (missing.length > 0) return "incomplete_config";
  }
  return null;
}

// The detail an operator needs (which field, exactly) that the bare reason
// enum above can't carry — kept a separate call so every consumer that only
// wants the reason (the common case) doesn't pay for a second table lookup.
export function missingConfigFields(input: ConnectionReadinessInput): CampaignRequiredField[] {
  if (input.isMessaging === undefined) return [];
  const destination = input.isMessaging ? FIXED_DESTINATION : WEBSITE_DESTINATION;
  return missingRequiredFields(destination, {
    whatsappDestination: input.whatsappDestination ?? null,
    websiteUrl: input.websiteUrl ?? null,
    trackingPixelId: input.trackingPixelId ?? null,
    leadEventTypes: input.leadEventTypes ?? null,
  });
}
