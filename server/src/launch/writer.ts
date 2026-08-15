import { GraphCampaignAdapter } from "../meta/campaign-adapter.js";
import type { LaunchWriter } from "./types.js";
import type { LaunchStateReader } from "../services/customer-launch.js";

// Same token-gated factory pattern as buildBuilderWriter/buildCustomerExecutor:
// no META_SYSTEM_USER_TOKEN → null, so the route reports an honest
// "temporarily unavailable" instead of pretending activation can happen.
export function buildLaunchWriter(): LaunchWriter | null {
  const token = process.env.META_SYSTEM_USER_TOKEN;
  if (!token) return null;
  const ver = process.env.META_GRAPH_VERSION || "v21.0";
  return new GraphCampaignAdapter(token, ver);
}

// The READ half of the launch gate: live ad count + the pixel's host, so the
// consent screen states facts about Meta's current state rather than about
// what our own builder happened to create. Same token gate — a null reader
// blocks approval with `verification_unavailable` rather than silently
// presenting an unverified summary as safe.
export function buildLaunchReader(): LaunchStateReader | null {
  const token = process.env.META_SYSTEM_USER_TOKEN;
  if (!token) return null;
  const ver = process.env.META_GRAPH_VERSION || "v21.0";
  return new GraphCampaignAdapter(token, ver);
}
