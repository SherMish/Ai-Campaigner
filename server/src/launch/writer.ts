import { GraphCampaignAdapter } from "../meta/campaign-adapter.js";
import { pool } from "../db/pool.js";
import { tokenForUser } from "../meta/token-resolver.js";
import type { LaunchWriter } from "./types.js";
import type { LaunchStateReader } from "../services/customer-launch.js";
import type { DeliveryReader } from "../meta/delivery-health.js";

// AIC-187: resolved per customer. A manual connection still yields the shared
// System User token; an OAuth connection yields that customer's own. A null
// result now covers one more case than it used to — an OAuth token we cannot
// decrypt — and it is deliberately still a null: "temporarily unavailable" is
// the honest answer for a credential we hold and cannot use.
export async function buildLaunchWriter(userId: string): Promise<LaunchWriter | null> {
  const resolved = await tokenForUser(pool, userId);
  if (!resolved) return null;
  const ver = process.env.META_GRAPH_VERSION || "v21.0";
  return new GraphCampaignAdapter(resolved.token, ver);
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
export async function buildLaunchReader(
  userId: string,
): Promise<(LaunchStateReader & DeliveryReader) | null> {
  const resolved = await tokenForUser(pool, userId);
  if (!resolved) return null;
  const ver = process.env.META_GRAPH_VERSION || "v21.0";
  return new GraphCampaignAdapter(resolved.token, ver);
}
