import { GraphCampaignAdapter } from "../meta/campaign-adapter.js";
import type { LaunchWriter } from "./types.js";

// Same token-gated factory pattern as buildBuilderWriter/buildCustomerExecutor:
// no META_SYSTEM_USER_TOKEN → null, so the route reports an honest
// "temporarily unavailable" instead of pretending activation can happen.
export function buildLaunchWriter(): LaunchWriter | null {
  const token = process.env.META_SYSTEM_USER_TOKEN;
  if (!token) return null;
  const ver = process.env.META_GRAPH_VERSION || "v21.0";
  return new GraphCampaignAdapter(token, ver);
}
