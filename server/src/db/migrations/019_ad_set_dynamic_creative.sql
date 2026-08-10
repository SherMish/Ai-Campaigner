-- Dynamic/Advantage+ creative flag on the ad-set metadata cache (AIC-36). Meta
-- doesn't expose reliable per-asset CPL for an ad set running dynamic creative
-- (it mixes multiple images/videos/bodies per impression) — the rules use this
-- to skip pause_weak_creative's peer comparison for that ad set, without
-- affecting the audience-level (pause_underperforming_audience) rule.
ALTER TABLE ad_set_meta
  ADD COLUMN is_dynamic_creative BOOLEAN NOT NULL DEFAULT false;
