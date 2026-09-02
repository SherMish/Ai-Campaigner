-- AIC-178 — catch an ad set that is ACTIVE and serving NOTHING.
--
-- Lived on 2026-09-02: a campaign ran all day with zero impressions while Meta
-- reported every object ACTIVE, issues_info empty, and our own delivery_ok
-- stayed true. Nothing was broken by any status we read — the ads simply never
-- served, and no check we had was looking at whether they actually did.
--
-- delivery-health asks Meta "is this delivering?" and believes the answer.
-- This asks our own measured insights "did anything actually happen?", which
-- is the question that would have caught it.
--
-- One row per watched object. `first_seen_at` is the grace anchor: a brand-new
-- ad set has legitimately served nothing yet (review, learning), so the silence
-- clock starts when we first SEE the object, not at epoch.
CREATE TABLE IF NOT EXISTS ad_serving_watch (
  meta_object_id TEXT PRIMARY KEY,
  campaign_id    UUID NOT NULL REFERENCES managed_campaigns(id) ON DELETE CASCADE,
  grain          TEXT NOT NULL CHECK (grain IN ('adset')),
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Last tick at which we observed impressions > 0. NULL = never, since we
  -- started watching.
  last_served_at TIMESTAMPTZ,
  -- Set when we raise the alert, cleared the moment it serves again — so one
  -- dark spell produces one message, not one per hourly tick.
  alerted_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ad_serving_watch_campaign_idx ON ad_serving_watch (campaign_id);

ALTER TABLE ops_queue_items DROP CONSTRAINT ops_queue_items_type_check;
ALTER TABLE ops_queue_items ADD CONSTRAINT ops_queue_items_type_check CHECK (type IN (
  'meta_connection_failure','campaign_not_delivering','campaign_rejected',
  'unusual_performance','recommendation_review','support_request',
  'missing_creative','account_restriction','campaign_tracking_broken',
  'campaign_cta_broken','ad_account_cannot_spend','lead_event_stopped',
  'ads_not_serving'));
