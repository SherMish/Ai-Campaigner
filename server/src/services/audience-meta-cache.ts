import type pg from "pg";
import type { AdSetMeta } from "../meta/audience-label.js";

// Persist ad-set metadata (AIC-37) so the customer surface + explainer can derive
// a human audience label without a live Meta call. Upserted by the engine tick
// (piggybacking on the same per-campaign pass as delivery-health).
export async function upsertAdSetMeta(
  pool: pg.Pool,
  campaignId: string,
  adsets: AdSetMeta[],
): Promise<void> {
  for (const a of adsets) {
    await pool.query(
      `INSERT INTO ad_set_meta (meta_ad_set_id, campaign_id, name, age_min, age_max, genders, geo_summary, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now())
       ON CONFLICT (meta_ad_set_id) DO UPDATE SET
         campaign_id = EXCLUDED.campaign_id, name = EXCLUDED.name,
         age_min = EXCLUDED.age_min, age_max = EXCLUDED.age_max,
         genders = EXCLUDED.genders, geo_summary = EXCLUDED.geo_summary,
         updated_at = now()`,
      [a.adSetId, campaignId, a.name, a.ageMin, a.ageMax, a.genders, a.geoSummary],
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
}

export async function listAdSetMeta(pool: pg.Pool, campaignId: string): Promise<StoredAdSetMeta[]> {
  const { rows } = await pool.query<{
    meta_ad_set_id: string; name: string; age_min: number | null; age_max: number | null;
    genders: "all" | "male" | "female" | null; geo_summary: string | null;
  }>(`SELECT meta_ad_set_id, name, age_min, age_max, genders, geo_summary FROM ad_set_meta WHERE campaign_id = $1`, [campaignId]);
  return rows.map((r) => ({
    adSetId: r.meta_ad_set_id,
    name: r.name,
    ageMin: r.age_min,
    ageMax: r.age_max,
    genders: r.genders ?? "all",
    geoSummary: r.geo_summary ?? "",
  }));
}
