import type pg from "pg";
import type { ControlWriter } from "./types.js";

// The customer's "remove this ad" (AIC-128). Hidden on OUR side only — the ad
// stays exactly as it is on Meta.
//
// Meta's archive was the obvious mechanism and cannot be used: "An ARCHIVED
// object has only two fields you can change: name and status. You can also only
// change status to DELETED." There is no un-archive at Meta, through any API,
// so a remove built on it could never be undone — and the restore is the whole
// point of this feature. Meta's real ARCHIVED/DELETED remain operator-only.
//
// THREE INVARIANTS, and every one of them is about not breaking the numbers:
//
//   1. This never writes to Meta. Nothing about delivery, spend or reporting
//      changes because a customer hid a row.
//   2. This never touches ingestion. Every insight_snapshots row the ad ever
//      produced stays, so no total anywhere moves — not the campaign KPIs, not
//      the ad-set rows, not the admin fleet stats.
//   3. This is never read by the engine, the health checks or the ops console.
//      A hidden ad is still a real paused ad on Meta; letting a presentation
//      preference reach the decision layer would make the engine reason about
//      a world that doesn't exist. Hiding is a VIEW concern, full stop.
//
// The consequence of (2) is the thing that has to be surfaced rather than
// swallowed: an ad-set's spend/leads still include the hidden ad, so its
// creative rows no longer sum to its own total. campaign-audiences.ts reports
// that gap explicitly (hiddenCreativesCount / hiddenSpendAgorot / hiddenLeads).
// Silently letting the arithmetic stop adding up would be exactly the
// "looks-like-progress" dishonesty this product exists to avoid.

export type HideOutcome = "hidden" | "already_hidden" | "not_paused" | "not_found";
export type UnhideOutcome = "restored" | "not_hidden";

export interface HiddenAdRow {
  metaAdId: string;
  hiddenAt: Date;
  hiddenBy: string;
}

export async function listHiddenAdIds(pool: pg.Pool, campaignId: string): Promise<Set<string>> {
  const { rows } = await pool.query<{ meta_ad_id: string }>(
    `SELECT meta_ad_id FROM hidden_ads WHERE campaign_id = $1`,
    [campaignId],
  );
  return new Set(rows.map((r) => r.meta_ad_id));
}

export async function listHiddenAds(pool: pg.Pool, campaignId: string): Promise<HiddenAdRow[]> {
  const { rows } = await pool.query<{ meta_ad_id: string; hidden_at: Date; hidden_by: string }>(
    `SELECT meta_ad_id, hidden_at, hidden_by FROM hidden_ads
      WHERE campaign_id = $1 ORDER BY hidden_at DESC`,
    [campaignId],
  );
  return rows.map((r) => ({ metaAdId: r.meta_ad_id, hiddenAt: r.hidden_at, hiddenBy: r.hidden_by }));
}

/**
 * Hide one ad. PAUSE-FIRST IS ENFORCED HERE, not in the UI.
 *
 * A disabled button is a suggestion; this is the rule. Removing a running ad in
 * one click is the one genuinely costly mistake available on this surface — the
 * ad vanishes from view while it is still spending money on Meta, which is the
 * worst of both worlds: invisible AND live. Requiring PAUSED first means the
 * customer has already stopped the spend and seen it stop before they tidy the
 * row away.
 *
 * The status comes from a LIVE Meta read, never our cache: a stale "paused"
 * would let exactly the case this guards against slip through.
 */
export async function hideAd(deps: {
  pool: pg.Pool;
  writer: ControlWriter;
  campaignId: string;
  metaAdId: string;
  actorLabel: string;
}): Promise<HideOutcome> {
  const { pool, writer, campaignId, metaAdId, actorLabel } = deps;

  const status = (await writer.getAdStatus(metaAdId))?.toUpperCase() ?? null;
  if (status === null) return "not_found";
  // ARCHIVED/DELETED are allowed through: an operator may have archived it at
  // Meta, and the customer tidying the leftover row away is reasonable. Only a
  // still-ACTIVE ad is refused.
  if (status === "ACTIVE") return "not_paused";

  const { rowCount } = await pool.query(
    `INSERT INTO hidden_ads (meta_ad_id, campaign_id, hidden_by)
     VALUES ($1, $2, $3) ON CONFLICT (campaign_id, meta_ad_id) DO NOTHING`,
    [metaAdId, campaignId, actorLabel],
  );
  if (rowCount === 0) return "already_hidden";

  await logHide(pool, campaignId, metaAdId, actorLabel, "hide_ad");
  return "hidden";
}

/**
 * Restore a hidden ad to the customer's view.
 *
 * It comes back PAUSED — which is simply what it already is on Meta, since we
 * never changed it. Restoring does not resume spending, and the customer
 * resumes it explicitly afterwards if they want it running. That matches the
 * house invariant that nothing goes live without a deliberate act (AIC-50/53),
 * and it means restore is a genuinely safe button.
 */
export async function unhideAd(deps: {
  pool: pg.Pool;
  campaignId: string;
  metaAdId: string;
  actorLabel: string;
}): Promise<UnhideOutcome> {
  const { pool, campaignId, metaAdId, actorLabel } = deps;
  const { rowCount } = await pool.query(
    `DELETE FROM hidden_ads WHERE meta_ad_id = $1 AND campaign_id = $2`,
    [metaAdId, campaignId],
  );
  if (rowCount === 0) return "not_hidden";
  await logHide(pool, campaignId, metaAdId, actorLabel, "unhide_ad");
  return "restored";
}

// Same action_history discipline as every other manual control (AIC-66): the
// customer-visible history should be able to say "you removed this ad" and
// "you restored it". human_involved = true, no recommendation behind it.
//
// previous_state/new_state describe OUR visibility, not a Meta status — the
// Meta status is deliberately unchanged by this action, and claiming otherwise
// in the history would be a lie about what happened.
async function logHide(
  pool: pg.Pool,
  campaignId: string,
  metaAdId: string,
  actorLabel: string,
  actionType: "hide_ad" | "unhide_ad",
): Promise<void> {
  const hiding = actionType === "hide_ad";
  await pool.query(
    `INSERT INTO action_history
       (campaign_id, recommendation_id, what, action_type, target_meta_id,
        previous_state, new_state, why, approved_by, human_involved, result)
     VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, true, 'success')`,
    [
      campaignId,
      `מודעה ${metaAdId}`,
      actionType,
      metaAdId,
      JSON.stringify({ hidden: hiding ? false : true }),
      JSON.stringify({ hidden: hiding }),
      hiding ? "הסרה מהתצוגה על ידי הלקוח (המודעה נשארה ב-Meta)" : "שחזור לתצוגה על ידי הלקוח",
      actorLabel,
    ],
  );
}
