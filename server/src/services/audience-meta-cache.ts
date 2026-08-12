import type pg from "pg";
import type { AdSetMeta } from "../meta/audience-label.js";

// Persist ad-set metadata (AIC-37) so the customer surface + explainer can derive
// a human audience label without a live Meta call. Upserted by the engine tick
// (piggybacking on the same per-campaign pass as delivery-health).
// status isn't persisted here (this cache backs the human-audience-label view,
// which never surfaces it) — narrowed so callers/tests don't need to supply
// a field this function ignores. AIC-63's live ad-set picker reads status
// fresh from Meta instead, since a cached value could be stale by the time
// a customer picks where to add an ad.
export async function upsertAdSetMeta(
  pool: pg.Pool,
  campaignId: string,
  adsets: Omit<AdSetMeta, "status">[],
): Promise<void> {
  for (const a of adsets) {
    await pool.query(
      `INSERT INTO ad_set_meta (meta_ad_set_id, campaign_id, name, age_min, age_max, genders, geo_summary, is_dynamic_creative, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
       ON CONFLICT (meta_ad_set_id) DO UPDATE SET
         campaign_id = EXCLUDED.campaign_id, name = EXCLUDED.name,
         age_min = EXCLUDED.age_min, age_max = EXCLUDED.age_max,
         genders = EXCLUDED.genders, geo_summary = EXCLUDED.geo_summary,
         is_dynamic_creative = EXCLUDED.is_dynamic_creative,
         updated_at = now()`,
      [a.adSetId, campaignId, a.name, a.ageMin, a.ageMax, a.genders, a.geoSummary, a.isDynamicCreative],
    );
  }
}

export interface StoredAdSetMeta {
  adSetId: string;
  name: string;
  ageMin: number | null;
  ageMax: number | null;
  genders: "all" | "male" | "female";
  geoSummary: string;
  isDynamicCreative: boolean;
}

export async function listAdSetMeta(pool: pg.Pool, campaignId: string): Promise<StoredAdSetMeta[]> {
  const { rows } = await pool.query<{
    meta_ad_set_id: string; name: string; age_min: number | null; age_max: number | null;
    genders: "all" | "male" | "female" | null; geo_summary: string | null; is_dynamic_creative: boolean;
  }>(`SELECT meta_ad_set_id, name, age_min, age_max, genders, geo_summary, is_dynamic_creative FROM ad_set_meta WHERE campaign_id = $1`, [campaignId]);
  return rows.map((r) => ({
    adSetId: r.meta_ad_set_id,
    name: r.name,
    ageMin: r.age_min,
    ageMax: r.age_max,
    genders: r.genders ?? "all",
    geoSummary: r.geo_summary ?? "",
    isDynamicCreative: r.is_dynamic_creative,
  }));
}
