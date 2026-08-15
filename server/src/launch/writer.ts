import { GraphCampaignAdapter } from "../meta/campaign-adapter.js";
import type { LaunchWriter } from "./types.js";
import type { LaunchStateReader } from "../services/customer-launch.js";
import type { DeliveryReader } from "../meta/delivery-health.js";

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
//
// Also a DeliveryReader (bug fix, 2026-08-15): the same adapter instance
// doubles as the source for the post-launch delivery refresh (see
// approveLaunch) — mirrors how buildAdditionWriter already returns an
// intersection type for the same reason (routes/controls.ts's manual
// pause/resume reuses `writer` as its DeliveryReader too).
export function buildLaunchReader(): (LaunchStateReader & DeliveryReader) | null {
  const token = process.env.META_SYSTEM_USER_TOKEN;
  if (!token) return null;
  const ver = process.env.META_GRAPH_VERSION || "v21.0";
  return new GraphCampaignAdapter(token, ver);
}
