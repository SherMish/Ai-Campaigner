import type pg from "pg";
import { FIXED_DESTINATION } from "@aic/shared";
import { WriteOutbox, builderKey } from "../execution/write-outbox.js";
import { asCreatingWriter } from "../builder/campaign-create.js";
import type { BuilderWriter, CreateAdSetTargeting } from "../builder/types.js";

// Adding content to a campaign we ALREADY manage (AIC-63) — the everyday
// action, distinct from the first-time builder (AIC-49-53). Reuses
// createAdSet/createAd unchanged (always PAUSED — AIC-50's hard rule), just
// anchored to a real, existing meta_campaign_id instead of a freshly-created
// shell. The underlying creates are idempotent via the SAME outbox as the
// builder; pending_additions is purely the "created, not yet approved"
// marker, inserted only once every create for this addition has succeeded —
// same "anchor only once complete" discipline as buildCampaignOnMeta.

export interface AddAdInput {
  localCampaignId: string;
  metaAdAccountId: string;
  metaAdSetId: string; // an EXISTING ad set — caller must verify ownership first
  name: string;
  creativeId: string;
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
  additionKey: string;
}

export interface AddResult {
  additionId: string;
  metaAdSetId: string;
  metaAdIds: string[];
}

async function logAdd(pool: pg.Pool, campaignId: string, actionType: string, targetMetaId: string, what: string): Promise<void> {
  await pool.query(
    `INSERT INTO action_history
       (campaign_id, recommendation_id, what, action_type, target_meta_id,
        previous_state, new_state, why, approved_by, human_involved, result)
     VALUES ($1, NULL, $2, $3, $4, '{}'::jsonb, $5, $6, NULL, true, 'success')`,
    [campaignId, what, actionType, targetMetaId, JSON.stringify({ metaId: targetMetaId }), "add to existing campaign (AIC-63)"],
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

export async function addAdToExistingCampaign(pool: pg.Pool, writer: BuilderWriter, input: AddAdInput): Promise<AddResult> {
  const outbox = new WriteOutbox(pool);
  const creator = asCreatingWriter(writer);

  const metaAdId = await outbox.applyIdempotent(
    {
      idempotencyKey: builderKey(input.localCampaignId, "create_ad", `add-${input.additionKey}`),
      campaignId: input.localCampaignId,
      recommendationId: null,
      kind: "create_ad",
      payload: {
        adAccountId: input.metaAdAccountId,
        metaAdSetId: input.metaAdSetId,
        name: input.name,
        creativeId: input.creativeId,
      },
    },
    creator,
  );
  await logAdd(pool, input.localCampaignId, "create_ad", metaAdId, `added ad "${input.name}" (paused) to an existing ad set`);

  const additionId = await recordPending(pool, input.localCampaignId, input.additionKey, "ad", input.name, input.metaAdSetId, [metaAdId]);
  return { additionId, metaAdSetId: input.metaAdSetId, metaAdIds: [metaAdId] };
}

export async function addAdSetToExistingCampaign(pool: pg.Pool, writer: BuilderWriter, input: AddAdSetInput): Promise<AddResult> {
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
  await logAdd(pool, input.localCampaignId, "create_ad_set", metaAdSetId, `added ad set "${input.name}" (paused)`);

  const metaAdIds: string[] = [];
  for (const ad of input.ads) {
    const metaAdId = await outbox.applyIdempotent(
      {
        idempotencyKey: builderKey(input.localCampaignId, "create_ad", `add-${input.additionKey}-${ad.clientKey}`),
        campaignId: input.localCampaignId,
        recommendationId: null,
        kind: "create_ad",
        payload: {
          adAccountId: input.metaAdAccountId,
          metaAdSetId,
          name: ad.name,
          creativeId: ad.creativeId,
        },
      },
      creator,
    );
    await logAdd(pool, input.localCampaignId, "create_ad", metaAdId, `added ad "${ad.name}" (paused)`);
    metaAdIds.push(metaAdId);
  }

  const additionId = await recordPending(pool, input.localCampaignId, input.additionKey, "ad_set", input.name, metaAdSetId, metaAdIds);
  return { additionId, metaAdSetId, metaAdIds };
}
