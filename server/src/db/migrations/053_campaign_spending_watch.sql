-- AIC-182 — the campaign-wide "nothing is spending" watch.
--
-- Lived on 2026-09-02: the customer's credit card was declining charges. Meta
-- kept reporting account_status = 1 (ACTIVE) and disable_reason = 0 for the
-- entire outage, so AIC-72's account-health check — which exists for exactly
-- this failure — never fired. Meta only moves that status after its own
-- billing retry cycle, which lagged well past the 19 hours of dark delivery.
--
-- The config read cannot catch a declined card. What can is noticing that a
-- LIVE campaign with active ad sets is spending nothing, fast, and handing the
-- operator the account state so the obvious cause can be ruled in or out in
-- seconds rather than an hour of Graph probing.
--
-- Campaign grain gets a 3-hour fuse where an individual ad set gets 12: one
-- quiet ad set is ordinary (auction luck, a small audience), but a whole
-- campaign with an active ad set spending nothing almost never is.
ALTER TABLE ad_serving_watch DROP CONSTRAINT ad_serving_watch_grain_check;
ALTER TABLE ad_serving_watch ADD CONSTRAINT ad_serving_watch_grain_check
  CHECK (grain IN ('adset', 'campaign'));

-- The FULL current set from shared/src/domain.ts OPS_QUEUE_TYPE. Re-adding a
-- CHECK re-validates every existing row, so this must be the whole list and
-- never the previous migration's plus one (AIC-181, learned the hard way).
ALTER TABLE ops_queue_items DROP CONSTRAINT ops_queue_items_type_check;
ALTER TABLE ops_queue_items ADD CONSTRAINT ops_queue_items_type_check CHECK (type IN (
  'meta_connection_failure','campaign_not_delivering','campaign_rejected',
  'unusual_performance','recommendation_review','support_request',
  'missing_creative','account_restriction','campaign_tracking_broken',
  'campaign_cta_broken','ad_account_cannot_spend','lead_event_stopped',
  'leads_possibly_overcounted','business_profile_incomplete',
  'ads_not_serving','campaign_not_spending'));
