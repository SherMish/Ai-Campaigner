import type pg from "pg";
import type { RawAdMetaRow } from "../meta/ad-meta-types.js";

// Per-ad metadata cache. Exists because the customer's per-ad list is built
// from `insight_snapshots` — measured data — so an ad with no impressions yet
// is invisible. A customer who has just added an ad sees a success message and
// then a list without it (found live 2026-08-22).
//
// Same upsert+prune discipline as ad_set_meta (AIC-37/AIC-65). The prune is
// not optional: upsert-only leaves a deleted ad cached forever, which is the
// exact bug AIC-65 had to fix for ad sets after a dead one stayed visible.

export interface CachedAdMeta {
  adId: string;
  adSetId: string;
  name: string | null;
  effectiveStatus: string;
  createdTime: Date | null;
  // AIC-128: when Meta stopped reporting this ad — i.e. an operator archived or
  // deleted it. Null while it is still a live object. See the prune below.
  goneAt: Date | null;
}

export async function upsertAdMeta(
  pool: pg.Pool,
  campaignId: string,
  ads: readonly RawAdMetaRow[],
): Promise<void> {
  for (const a of ads) {
    await pool.query(
      `INSERT INTO ad_meta (meta_ad_id, campaign_id, meta_ad_set_id, name, effective_status, created_time, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6, now())
       ON CONFLICT (meta_ad_id) DO UPDATE SET
         campaign_id = EXCLUDED.campaign_id,
         meta_ad_set_id = EXCLUDED.meta_ad_set_id,
         name = EXCLUDED.name,
         effective_status = EXCLUDED.effective_status,
         created_time = COALESCE(ad_meta.created_time, EXCLUDED.created_time),
         -- Meta is reporting it again, so it is not gone. This is what makes
         -- the tombstone self-healing after a transient miss.
         gone_at = NULL,
         updated_at = now()`,
      [a.adId, campaignId, a.adSetId, a.name, a.effectiveStatus, a.createdTime],
    );
  }

  // Ads Meta no longer reports are TOMBSTONED, not deleted (AIC-128).
  //
  // AIC-65's rule still holds — a dead ad must not stay in the customer's list
  // — but it is now enforced by filtering on gone_at rather than by throwing
  // the row away. Deleting it destroyed the only evidence the ad was gone, so
  // the customer's panel (built from snapshots, which outlive the object) kept
  // rendering it with the stale status frozen in its last snapshot. Keeping the
  // tombstone is what lets the panel say "this one was archived at Meta"
  // instead of quietly showing a corpse as a live ad.
  //
  // Set once: `gone_at IS NULL` keeps the first observation's timestamp rather
  // than bumping it on every tick, so "when did this disappear" stays true.
  const keep = ads.map((a) => a.adId);
  await pool.query(
    keep.length > 0
      ? `UPDATE ad_meta SET gone_at = now()
          WHERE campaign_id = $1 AND gone_at IS NULL AND meta_ad_id <> ALL($2::text[])`
      : `UPDATE ad_meta SET gone_at = now() WHERE campaign_id = $1 AND gone_at IS NULL`,
    keep.length > 0 ? [campaignId, keep] : [campaignId],
  );
}

export async function listAdMeta(pool: pg.Pool, campaignId: string): Promise<CachedAdMeta[]> {
  const { rows } = await pool.query<{
    meta_ad_id: string;
    meta_ad_set_id: string;
    name: string | null;
    effective_status: string;
    created_time: Date | null;
    gone_at: Date | null;
  }>(
    `SELECT meta_ad_id, meta_ad_set_id, name, effective_status, created_time, gone_at
       FROM ad_meta WHERE campaign_id = $1`,
    [campaignId],
  );
  return rows.map((r) => ({
    adId: r.meta_ad_id,
    adSetId: r.meta_ad_set_id,
    name: r.name,
    effectiveStatus: r.effective_status,
    createdTime: r.created_time,
    goneAt: r.gone_at,
  }));
}

// Refresh one campaign's ad cache from Meta right now. Used both by the
// scheduled tick and immediately after a customer adds an ad — without the
// second, a just-created ad would not appear until the next tick (up to an
// hour), which is the same "the dashboard contradicts what we just told you"
// failure AIC-71 fixed for pause/resume and the launch flow.
export interface AdMetaReader {
  listAds(metaCampaignId: string): Promise<RawAdMetaRow[]>;
}

export async function refreshAdMetaNow(
  pool: pg.Pool,
  reader: AdMetaReader,
  campaignId: string,
  metaCampaignId: string,
): Promise<void> {
  const ads = await reader.listAds(metaCampaignId);
  await upsertAdMeta(pool, campaignId, ads);
}
