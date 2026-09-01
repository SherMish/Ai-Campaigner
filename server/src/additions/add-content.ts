import type pg from "pg";
import { FIXED_DESTINATION } from "@aic/shared";
import { markCreativesAttached } from "../services/creative-reaper.js";
import { WriteOutbox, builderKey } from "../execution/write-outbox.js";
import { asCreatingWriter } from "../builder/campaign-create.js";
import { adName, nextAdIndex } from "../meta/naming.js";
import type { BuilderWriter, CreateAdSetTargeting } from "../builder/types.js";
import { approveAddition, type ApproveResult } from "./approve.js";
import { refreshAdMetaNow, type AdMetaReader } from "../services/ad-meta-cache.js";
import type { AdditionWriter } from "./types.js";

// Adding content to a campaign we ALREADY manage (AIC-63) — the everyday
// action, distinct from the first-time builder (AIC-49-53). Reuses
// createAdSet/createAd unchanged (always PAUSED — AIC-50's hard rule), just
// anchored to a real, existing meta_campaign_id instead of a freshly-created
// shell. The underlying creates are idempotent via the SAME outbox as the
// builder; pending_additions is inserted only once every create for this
// addition has succeeded — same "anchor only once complete" discipline as
// buildCampaignOnMeta.
//
// AIC-106: creating something new no longer waits for an approval click.
// Meta objects are still CREATED paused (AIC-50's adapter-level hard rule is
// untouched), then activated immediately in the same request via the
// existing `approveAddition` path — so the read→write→read-back-verify→log
// discipline and the action_history trail are exactly as before, just not
// gated behind a second human step. Approvals now live only in the
// recommendation engine, which changes things that are ALREADY RUNNING;
// creating new content is not that.
//
// Why this carries no spend risk: budget is campaign-level (CBO —
// `builder/types.ts`: "P0 never sets an ad-set-level budget"), and neither
// AddAdInput nor AddAdSetInput has a budget field. New ads/ad sets deliver
// WITHIN the campaign's existing daily budget; they cannot raise it. The
// create-path budget ceiling gap (AIC-106) is specific to campaign creation,
// which is a different entry point than this one.

export interface AddAdInput {
  localCampaignId: string;
  metaAdAccountId: string;
  // Needed to refresh the per-ad cache in-request after the add — see the
  // refreshAdMetaNow call below for why that matters to the customer.
  metaCampaignId: string;
  metaAdSetId: string; // an EXISTING ad set — caller must verify ownership first
  // AIC-171: the Page this customer is connected to, compared against the ad
  // set's own promoted Page before writing anything.
  pageId: string;
  name: string;
  creativeId: string;
  // AIC-137: who is doing this — 'customer' from their own dashboard,
  // 'operator' when we act for them. Drives the action-history attribution.
  actor: string;
  additionKey: string; // client-generated, stable across a resubmission of this same attempt
}

export interface AddAdSetInput {
  localCampaignId: string;
  metaAdAccountId: string;
  metaCampaignId: string;
  pageId: string;
  name: string;
  targeting: CreateAdSetTargeting;
  ads: Array<{ clientKey: string; name: string; creativeId: string }>;
  actor: string;
  additionKey: string;
}

export interface AddResult {
  additionId: string;
  metaAdSetId: string;
  metaAdIds: string[];
  // AIC-106: the outcome of the immediate activation that now follows every
  // create. `"approved"` = live on Meta. Anything else means the objects
  // exist but are still PAUSED — reported honestly rather than swallowed,
  // since "we made it but it isn't running" is a materially different state
  // for the customer than "done".
  activation: ApproveResult;
}

// AIC-137, found live: every addition read "בוצע על ידינו" — us — for ads the
// CUSTOMER had just added from their own dashboard. approved_by was written
// NULL, and actorOf() reads NULL-with-human_involved as "a human did it and it
// wasn't the customer's dashboard", which is the right default and the wrong
// answer here. This IS the customer's dashboard.
//
// Threaded as a parameter rather than hardcoded to 'customer': today the only
// caller is the customer's own route, and hardcoding would silently mislabel
// the first operator-side caller that appears — the same shape of bug, just
// pointing the other way.
async function logAdd(
  pool: pg.Pool,
  campaignId: string,
  actionType: string,
  targetMetaId: string,
  what: string,
  approvedBy: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO action_history
       (campaign_id, recommendation_id, what, action_type, target_meta_id,
        previous_state, new_state, why, approved_by, human_involved, result)
     VALUES ($1, NULL, $2, $3, $4, '{}'::jsonb, $5, $6, $7, true, 'success')`,
    [campaignId, what, actionType, targetMetaId, JSON.stringify({ metaId: targetMetaId }), "add to existing campaign (AIC-63)", approvedBy],
  );
}

// Insert the pending-approval row idempotently — a resubmitted addition
// (all its underlying creates replaying as already-succeeded via the outbox)
// must not produce a second "awaiting approval" entry for the same objects.
async function recordPending(
  pool: pg.Pool,
  campaignId: string,
  additionKey: string,
  kind: "ad" | "ad_set",
  name: string,
  metaAdSetId: string,
  metaAdIds: string[],
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO pending_additions (campaign_id, kind, addition_key, name, meta_ad_set_id, meta_ad_ids)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (campaign_id, addition_key) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [campaignId, kind, additionKey, name, metaAdSetId, JSON.stringify(metaAdIds)],
  );
  return rows[0].id;
}

/**
 * AIC-171 — the target ad set promotes a different Facebook Page than the one
 * this customer is connected to.
 *
 * An adopted campaign can hold ad sets belonging to Pages we have no role on.
 * Meta refuses the ad ("Pages Don't Match", subcode 1885029) and we cannot
 * satisfy it by using the ad set's own Page either — our System User cannot
 * post as it. So nothing we build can ever land there, and this is a refusal
 * rather than a failure.
 *
 * Named so the route can answer 409 with copy the customer can act on. Found
 * live only after someone had written four ads and pressed submit.
 */
export class AdSetPageMismatchError extends Error {
  constructor(public readonly adSetPageId: string, public readonly connectedPageId: string) {
    super(`ad set promotes page ${adSetPageId}, but this customer is connected to page ${connectedPageId}`);
    this.name = "AdSetPageMismatchError";
  }
}

export async function addAdToExistingCampaign(
  pool: pg.Pool,
  writer: BuilderWriter & AdditionWriter & AdMetaReader,
  input: AddAdInput,
): Promise<AddResult> {
  const outbox = new WriteOutbox(pool);
  const creator = asCreatingWriter(writer);

  // AIC-171: the picker disables these, but the picker is a courtesy — this is
  // the guarantee. Checked before any Meta write, so the refusal names the
  // reason instead of arriving as Meta's "Pages Don't Match" inside a 502.
  const target = (await writer.getAdSetMeta(input.metaCampaignId)).find((a) => a.adSetId === input.metaAdSetId);
  if (target?.promotedPageId && target.promotedPageId !== input.pageId) {
    throw new AdSetPageMismatchError(target.promotedPageId, input.pageId);
  }

  // AIC-154 — THE COLLISION THIS FIXES. The name used to come from the
  // client, where it was `מודעה ${i}` counted per DRAFTING SESSION: adding one
  // ad to an ad set that already had "מודעה 1" produced a second "מודעה 1".
  // Two ads with one name are indistinguishable wherever the name is what
  // identifies them — the Telegram digest falls through to it for post-based
  // ads, which have neither headline nor primary text.
  //
  // Read from META, not from anything we store: an ad added through Ads
  // Manager between two of our calls exists and would otherwise be invisible
  // to the count. Isolated, because a naming read must never be the reason an
  // add fails — on a failed read we fall back to the client's label, which is
  // the behaviour that shipped for months.
  let name = input.name;
  try {
    const existing = await writer.listAds(input.metaCampaignId);
    name = adName(nextAdIndex(existing.filter((a) => a.adSetId === input.metaAdSetId).map((a) => a.name)));
  } catch (e) {
    console.warn(`[additions] could not read existing ad names for numbering — ${(e as Error).message}`);
  }

  const metaAdId = await outbox.applyIdempotent(
    {
      idempotencyKey: builderKey(input.localCampaignId, "create_ad", `add-${input.additionKey}`),
      campaignId: input.localCampaignId,
      recommendationId: null,
      kind: "create_ad",
      payload: {
        adAccountId: input.metaAdAccountId,
        metaAdSetId: input.metaAdSetId,
        name,
        creativeId: input.creativeId,
      },
    },
    creator,
  );
  // AIC-131: the creative is now an ad, so it is finished business and must
  // never be reaped. This is an OPTIMISATION, not the safety mechanism — the
  // reaper re-checks against Meta before deleting anything and would find it in
  // use regardless. What it buys is that the common path settles immediately
  // instead of sitting as a candidate until the next reap.
  await markCreativesAttached(pool, [input.creativeId]);
  await logAdd(pool, input.localCampaignId, "create_ad", metaAdId, `added ad "${name}" (paused) to an existing ad set`, input.actor);

  const additionId = await recordPending(pool, input.localCampaignId, input.additionKey, "ad", name, input.metaAdSetId, [metaAdId]);
  // Activate immediately (AIC-106). Note this activates the AD only — never
  // its parent ad set, which may be deliberately paused; approveAddition's
  // kind='ad' branch already encodes that.
  const activation = await approveAddition(pool, writer, additionId, input.localCampaignId);

  // Refresh the per-ad cache in-request (2026-08-22, found live). Without it
  // the customer sees a success confirmation and then a dashboard that still
  // lists only their old ads, because the per-ad list is insight-derived and
  // a new ad has no impressions yet — it would not appear until the next tick
  // (up to an hour), and a REJECTED ad would never appear at all.
  //
  // Same refresh-in-request shape AIC-71 applied to manual pause/resume and
  // the launch flow, for the same reason: the dashboard must not contradict
  // what we just told the customer. Isolated — the ad is already live on
  // Meta, so a cache-refresh failure must never turn a successful add into a
  // reported failure.
  try {
    await refreshAdMetaNow(pool, writer, input.localCampaignId, input.metaCampaignId);
  } catch (e) {
    console.error(`[additions] ad-meta refresh failed after add — ${(e as Error).message}`);
  }

  return { additionId, metaAdSetId: input.metaAdSetId, metaAdIds: [metaAdId], activation };
}

export async function addAdSetToExistingCampaign(
  pool: pg.Pool,
  writer: BuilderWriter & AdditionWriter,
  input: AddAdSetInput,
): Promise<AddResult> {
  const outbox = new WriteOutbox(pool);
  const creator = asCreatingWriter(writer);

  const metaAdSetId = await outbox.applyIdempotent(
    {
      idempotencyKey: builderKey(input.localCampaignId, "create_ad_set", `add-${input.additionKey}`),
      campaignId: input.localCampaignId,
      recommendationId: null,
      kind: "create_ad_set",
      payload: {
        adAccountId: input.metaAdAccountId,
        metaCampaignId: input.metaCampaignId,
        name: input.name,
        targeting: input.targeting,
        pageId: input.pageId,
        // The refusal guard (routes/additions.ts) already confirmed this
        // campaign can accept WhatsApp writes before this function is ever
        // reached — FIXED_DESTINATION is the only value that gets here.
        destination: FIXED_DESTINATION,
      },
    },
    creator,
  );
  await logAdd(pool, input.localCampaignId, "create_ad_set", metaAdSetId, `added ad set "${input.name}" (paused)`, input.actor);

  const metaAdIds: string[] = [];
  // A brand-new ad set holds nothing, so position is the index (AIC-154). The
  // ad SET keeps the name the customer typed — that one they chose.
  let adIndex = 0;
  for (const ad of input.ads) {
    adIndex += 1;
    const thisAdName = adName(adIndex);
    const metaAdId = await outbox.applyIdempotent(
      {
        idempotencyKey: builderKey(input.localCampaignId, "create_ad", `add-${input.additionKey}-${ad.clientKey}`),
        campaignId: input.localCampaignId,
        recommendationId: null,
        kind: "create_ad",
        payload: {
          adAccountId: input.metaAdAccountId,
          metaAdSetId,
          name: thisAdName,
          creativeId: ad.creativeId,
        },
      },
      creator,
    );
    await logAdd(pool, input.localCampaignId, "create_ad", metaAdId, `added ad "${thisAdName}" (paused)`, input.actor);
    metaAdIds.push(metaAdId);
  }

  const additionId = await recordPending(pool, input.localCampaignId, input.additionKey, "ad_set", input.name, metaAdSetId, metaAdIds);
  // Activates the new ad set AND every ad under it (approveAddition's
  // kind='ad_set' branch) — a live ad set with paused ads would spend nothing.
  const activation = await approveAddition(pool, writer, additionId, input.localCampaignId);
  return { additionId, metaAdSetId, metaAdIds, activation };
}
