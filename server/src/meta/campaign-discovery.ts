import { GraphCampaignAdapter } from "./campaign-adapter.js";
import type { DetectedDestination } from "./tracking-health.js";

// AIC-105 Branch B — "pick, don't type" for an operator adopting a campaign
// the customer already has. Today's `/admin/customers/:id/onboarding` step 4
// requires typing a raw Meta ad-account id and campaign id by hand into two
// text fields; every character is a chance to attach the wrong customer's
// campaign or mistype a digit and provision garbage. Both lists mirror
// listPixels' shape (AIC-89): read live, return an id+name pair, let the
// operator click rather than transcribe.

export interface AdAccountOption {
  id: string; // "act_…"
  name: string;
  currency: string;
  accountStatus: number | null;
}

export interface DiscoveredCampaign {
  id: string; // Meta campaign id
  name: string;
  status: string;
  effectiveStatus: string;
  objective: string | null;
  dailyBudgetAgorot: number | null;
  destination: DetectedDestination;
}

export interface CampaignDiscoveryReader {
  // Every ad account the System User can currently act on — i.e. both AIC-101
  // access layers (shared to our Business Portfolio, then assigned to the
  // System User) already passed. This is deliberately NOT the layer-1-only
  // `client_ad_accounts` check access-probe.ts uses (that one exists to
  // diagnose a NOT-yet-working connection); this is "can we actually manage
  // it right now", which is exactly what step 4 needs before provisioning.
  listAdAccounts(): Promise<AdAccountOption[]>;
  // Every campaign under one ad account, each with its destination DETECTED
  // (see tracking-health.ts's detectDestination) rather than asked — the
  // ticket's "detect, don't ask" rule for adopting vs. building.
  listCampaigns(adAccountId: string): Promise<DiscoveredCampaign[]>;
}

// Same token-gated factory pattern as buildLaunchWriter/buildBuilderWriter:
// no META_SYSTEM_USER_TOKEN → null, so the route reports an honest
// "temporarily unavailable" instead of pretending the lists can load.
export function buildCampaignDiscoveryReader(): CampaignDiscoveryReader | null {
  const token = process.env.META_SYSTEM_USER_TOKEN;
  if (!token) return null;
  const ver = process.env.META_GRAPH_VERSION || "v21.0";
  return new GraphCampaignAdapter(token, ver);
}
