-- AIC-71: "פעיל" / "מודעות פעילות" were derived from managed_campaigns.status (an
-- operator DB flag meaning "we manage this," unrelated to real Meta delivery)
-- and historical insight_snapshots spend — a campaign whose only ad set the
-- customer paused via AIC-66 still read "active" with "1 active ad." `delivering`
-- and `delivering_ad_count` are computed the same tick as delivery_ok/delivery_reason
-- (AIC-39, delivery_checked_at reused) — no new Meta read, the ad-set/ad status
-- is already fetched there — and reflect whether anything can currently show a
-- person a page, not just whether nothing is broken. Default true/null until the
-- first tick classifies a real campaign, mirroring delivery_ok/live_budget_agorot.
ALTER TABLE managed_campaigns ADD COLUMN delivering BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE managed_campaigns ADD COLUMN delivering_ad_count INTEGER;
