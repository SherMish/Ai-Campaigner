import type pg from "pg";
import { WriteOutbox, builderKey, type WriteKind, type CreatingWriter } from "../execution/write-outbox.js";
import type { BuilderWriter, CreateAdSetTargeting } from "./types.js";

// The builder's idempotent multi-step create (AIC-50): campaign → ad set(s) →
// ad(s), always PAUSED. Every step goes through WriteOutbox.applyIdempotent,
// so a crash mid-build, a request timeout, or a plain retry is always safe to
// resume — re-calling buildCampaignOnMeta with the SAME localCampaignId and
// the SAME clientKeys skips every already-succeeded step (reading its
// remembered real Meta id back from the outbox) and continues from the first
// one that hasn't landed yet. This IS the partial-failure story: an already-
// created PAUSED object from a failed attempt is never an orphan to clean up
// — it's exactly the resume point the next call expects to find.

export interface BuilderAdSpec {
  clientKey: string; // stable across a resubmission, e.g. "adset-1-ad-1"
  name: string;
  creativeId: string;
}

export interface BuilderAdSetSpec {
  clientKey: string; // e.g. "adset-1"
  name: string;
  targeting: CreateAdSetTargeting;
  ads: BuilderAdSpec[];
}

export interface BuildCampaignInput {
  localCampaignId: string; // the managed_campaigns shell row (see startBuilderCampaign)
  adAccountId: string; // "act_..."
  pageId: string;
  name: string;
  dailyBudgetAgorot: number;
  specialAdCategories: string[]; // [] for none
  bidStrategy: string;
  whatsappDestination: string; // stored on the campaign row for the customer app to display
  adSets: BuilderAdSetSpec[];
}

export interface BuildCampaignResult {
  metaCampaignId: string;
  adSets: Array<{ clientKey: string; metaAdSetId: string; ads: Array<{ clientKey: string; metaAdId: string }> }>;
}

// Adapts the typed BuilderWriter (what GraphCampaignAdapter implements) to the
// outbox's generic (kind, payload) shape — kept here rather than in
// write-outbox.ts so execution/ never needs to import builder/ types. Exported
// so AIC-63's add-to-existing-campaign orchestration can reuse it unchanged —
// creating an ad set/ad under an existing campaign is the identical write,
// just anchored to a real meta_campaign_id instead of a freshly-created one.
export function asCreatingWriter(writer: BuilderWriter): CreatingWriter {
  return {
    async create(kind: WriteKind, payload: Record<string, unknown>): Promise<{ metaId: string }> {
      switch (kind) {
        case "create_campaign":
          return { metaId: await writer.createCampaign(payload as never) };
        case "create_ad_set":
          return { metaId: await writer.createAdSet(payload as never) };
        case "create_ad":
          return { metaId: await writer.createAd(payload as never) };
        default:
          throw new Error(`asCreatingWriter: unsupported kind ${kind}`);
      }
    },
  };
}

async function logCreate(
  pool: pg.Pool,
  campaignId: string,
  actionType: WriteKind,
  targetMetaId: string,
  what: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO action_history
       (campaign_id, recommendation_id, what, action_type, target_meta_id,
        previous_state, new_state, why, approved_by, human_involved, result)
     VALUES ($1, NULL, $2, $3, $4, '{}'::jsonb, $5, $6, NULL, true, 'success')`,
    [campaignId, what, actionType, targetMetaId, JSON.stringify({ metaId: targetMetaId }), "campaign builder (AIC-50)"],
  );
}

// Create (or reuse) the local shell row a build anchors to. `startBuilderCampaign`
// is itself idempotent: a customer resuming an interrupted build finds their
// existing not-yet-linked row rather than erroring on the UNIQUE(customer_id)
// constraint (P0: one managed campaign per customer).
export async function startBuilderCampaign(
  pool: pg.Pool,
  customerId: string,
  adAccountId: string,
): Promise<{ id: string }> {
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM managed_campaigns WHERE customer_id = $1 AND meta_campaign_id IS NULL`,
    [customerId],
  );
  if (existing.rows[0]) return existing.rows[0];

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO managed_campaigns (customer_id, ad_account_id, status) VALUES ($1, $2, 'under_review') RETURNING id`,
    [customerId, adAccountId],
  );
  return rows[0];
}

export async function buildCampaignOnMeta(
  pool: pg.Pool,
  writer: BuilderWriter,
  input: BuildCampaignInput,
): Promise<BuildCampaignResult> {
  const outbox = new WriteOutbox(pool);
  const creator = asCreatingWriter(writer);

  const metaCampaignId = await outbox.applyIdempotent(
    {
      idempotencyKey: builderKey(input.localCampaignId, "create_campaign", "campaign"),
      campaignId: input.localCampaignId,
      recommendationId: null,
      kind: "create_campaign",
      payload: {
        adAccountId: input.adAccountId,
        name: input.name,
        dailyBudgetAgorot: input.dailyBudgetAgorot,
        specialAdCategories: input.specialAdCategories,
        bidStrategy: input.bidStrategy,
      },
    },
    creator,
  );
  await logCreate(pool, input.localCampaignId, "create_campaign", metaCampaignId, `created campaign "${input.name}" (paused)`);

  const adSetResults: BuildCampaignResult["adSets"] = [];
  for (const as of input.adSets) {
    const metaAdSetId = await outbox.applyIdempotent(
      {
        idempotencyKey: builderKey(input.localCampaignId, "create_ad_set", as.clientKey),
        campaignId: input.localCampaignId,
        recommendationId: null,
        kind: "create_ad_set",
        payload: {
          adAccountId: input.adAccountId,
          metaCampaignId,
          name: as.name,
          targeting: as.targeting,
          pageId: input.pageId,
        },
      },
      creator,
    );
    await logCreate(pool, input.localCampaignId, "create_ad_set", metaAdSetId, `created ad set "${as.name}" (paused)`);

    const adResults: Array<{ clientKey: string; metaAdId: string }> = [];
    for (const ad of as.ads) {
      const metaAdId = await outbox.applyIdempotent(
        {
          idempotencyKey: builderKey(input.localCampaignId, "create_ad", ad.clientKey),
          campaignId: input.localCampaignId,
          recommendationId: null,
          kind: "create_ad",
          payload: {
            adAccountId: input.adAccountId,
            metaAdSetId,
            name: ad.name,
            creativeId: ad.creativeId,
          },
        },
        creator,
      );
      await logCreate(pool, input.localCampaignId, "create_ad", metaAdId, `created ad "${ad.name}" (paused)`);
      adResults.push({ clientKey: ad.clientKey, metaAdId });
    }
    adSetResults.push({ clientKey: as.clientKey, metaAdSetId, ads: adResults });
  }

  // Every step landed — link the local shell row to its real Meta campaign.
  // Until this UPDATE, the row is deliberately NOT visible as "managed" to
  // the engine (listEligibleForGeneration requires meta_campaign_id NOT NULL).
  await pool.query(
    `UPDATE managed_campaigns
     SET meta_campaign_id = $2, name = $3, objective = 'leads',
         whatsapp_destination = $4, agreed_budget_agorot = $5, budget_period = 'daily'
     WHERE id = $1`,
    [input.localCampaignId, metaCampaignId, input.name, input.whatsappDestination, input.dailyBudgetAgorot],
  );

  return { metaCampaignId, adSets: adSetResults };
}
