-- Per-AD metadata cache (found live 2026-08-22).
--
-- The bug: a customer added an ad from an existing post, got a success
-- confirmation, and the dashboard still showed only the old ads. Nothing had
-- failed — the ad was ACTIVE on Meta within seconds. But the customer-facing
-- per-ad list is built from `insight_snapshots`, i.e. ads that have MEASURED
-- DATA, and a brand-new ad has none: no impressions, no spend, no row.
--
-- So the list was silently showing "ads that have data" while the customer
-- read it as "my ads". Worse, a new ad sits at effective_status
-- PENDING_REVIEW for its first hours, and a REJECTED one would never gain
-- data at all — so waiting would not have fixed it either, and the customer
-- would be left believing the create had silently failed.
--
-- This cache lets that list show ads that EXIST, with their real state,
-- rather than only ads that have already been measured. Same shape and same
-- upsert+prune discipline as ad_set_meta (AIC-37/AIC-65) — including the
-- prune, without which a deleted ad stays visible forever.
CREATE TABLE ad_meta (
  meta_ad_id        TEXT PRIMARY KEY,
  campaign_id       UUID NOT NULL REFERENCES managed_campaigns(id) ON DELETE CASCADE,
  meta_ad_set_id    TEXT NOT NULL,
  name              TEXT,
  -- Meta's own effective_status, stored RAW rather than pre-classified: the
  -- set of values Meta can return is not ours to freeze, and a value we do
  -- not recognise must still be visible rather than silently dropped.
  effective_status  TEXT NOT NULL,
  created_time      TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ad_meta_campaign_idx ON ad_meta (campaign_id);
