// Why a customer's Meta connection can't support content writes right now —
// originally built for the customer-facing add-content 409 (AIC-63 follow-up,
// additions/session.ts's resolveAdditionAvailability), pulled out into its own
// pure function so the admin console can show the SAME classification per
// customer instead of re-deriving a second, driftable copy of the same four
// checks. One definition; two consumers (a customer hitting the wall
// themselves, and an operator scanning the fleet before that happens).
export type ConnectionReadinessReason = "no_campaign" | "not_launched" | "missing_page" | "connection_issue";

export interface ConnectionReadinessInput {
  campaignId: string | null;
  metaCampaignId: string | null;
  accessHealth: string | null;
  metaAdAccountId: string | null;
  pageId: string | null;
}

// null = fully ready (a real campaign, linked, healthy connection, ad
// account, and Page all present) — the ONLY case that isn't a reason.
export function classifyConnectionReadiness(input: ConnectionReadinessInput): ConnectionReadinessReason | null {
  if (!input.campaignId) return "no_campaign";
  if (!input.metaCampaignId) return "not_launched";
  if (input.accessHealth !== "ok" || !input.metaAdAccountId) return "connection_issue";
  if (!input.pageId) return "missing_page";
  return null;
}
