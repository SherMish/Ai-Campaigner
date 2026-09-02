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

-- The FULL current set, taken from shared/src/domain.ts OPS_QUEUE_TYPE.
--
-- The first version of this migration copied the list out of migration 046 and
-- added one entry to it. That list was two behind: 047 added
-- leads_possibly_overcounted and 051 added business_profile_incomplete. Prod
-- holds live business_profile_incomplete rows, so the narrowed CHECK failed on
-- ATRewriteTable and the whole deploy rolled back.
--
-- Re-adding a CHECK means re-validating EVERY EXISTING ROW. The list must
-- therefore be the current one in full, never the previous migration's plus
-- yours — the comment in domain.ts says both sides enumerate the set, and this
-- is what it costs to forget.
ALTER TABLE ops_queue_items DROP CONSTRAINT ops_queue_items_type_check;
ALTER TABLE ops_queue_items ADD CONSTRAINT ops_queue_items_type_check CHECK (type IN (
  'meta_connection_failure','campaign_not_delivering','campaign_rejected',
  'unusual_performance','recommendation_review','support_request',
  'missing_creative','account_restriction','campaign_tracking_broken',
  'campaign_cta_broken','ad_account_cannot_spend','lead_event_stopped',
  'leads_possibly_overcounted','business_profile_incomplete',
  'ads_not_serving'));
