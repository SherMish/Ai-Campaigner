-- Ad-set metadata cache (AIC-37): name + targeting, refreshed by the engine tick
-- (piggybacking on the delivery-health read) so the customer surface can derive a
-- human audience label WITHOUT a live Meta call at render time — same philosophy
-- as insight_snapshots for performance data.
CREATE TABLE ad_set_meta (
  meta_ad_set_id TEXT PRIMARY KEY,
  campaign_id    UUID NOT NULL REFERENCES managed_campaigns(id) ON DELETE CASCADE,
  name           TEXT NOT NULL DEFAULT '',
  age_min        INTEGER,
  age_max        INTEGER,
  genders        TEXT,   -- 'all' | 'male' | 'female' (normalized from Meta's [1,2] array)
  geo_summary    TEXT,   -- short joined place names, e.g. "תל אביב, רמת גן"
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ad_set_meta_campaign_idx ON ad_set_meta (campaign_id);
