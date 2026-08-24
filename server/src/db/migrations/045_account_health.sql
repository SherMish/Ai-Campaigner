-- AIC-72: cache whether the AD ACCOUNT itself can spend.
--
-- The failure: an account-level billing or policy problem — declined card,
-- unsettled balance, risk review, disabled account, or simply no payment method
-- at all. Every object-level check stays green (campaign ACTIVE, ad sets ACTIVE,
-- ads ACTIVE, delivery-health content) while nothing delivers, because the
-- ACCOUNT cannot pay. Insights just go quiet, which is indistinguishable from a
-- bad week until someone opens Ads Manager.
--
-- Third variant of the same shape as migrations 038 (tracking) and 044 (CTA):
-- every signal we had read healthy while the campaign was worthless. Same
-- ok/reason/detail/checked_at quartet, same per-tick cache, same escalation.
--
-- Lives on meta_connections, NOT managed_campaigns: the ad account belongs to
-- the connection, and one account can back several campaigns. Caching it
-- per-campaign would store the same fact N times and let the copies disagree.
ALTER TABLE meta_connections
  ADD COLUMN account_ok BOOLEAN DEFAULT true,
  ADD COLUMN account_reason TEXT,
  ADD COLUMN account_detail JSONB,
  ADD COLUMN account_checked_at TIMESTAMPTZ;

-- New ops-queue type. BOTH this CHECK and OPS_QUEUE_TYPE in shared/src/domain.ts
-- enumerate the allowed set — missing either throws at runtime inside a
-- swallowing try/catch (migration 042 is the record of that shipping).
ALTER TABLE ops_queue_items DROP CONSTRAINT ops_queue_items_type_check;
ALTER TABLE ops_queue_items ADD CONSTRAINT ops_queue_items_type_check CHECK (type IN (
  'meta_connection_failure','campaign_not_delivering','campaign_rejected',
  'unusual_performance','recommendation_review','support_request',
  'missing_creative','account_restriction','campaign_tracking_broken',
  'campaign_cta_broken','ad_account_cannot_spend'));

-- ...and the no_rec_reason CHECK widened in the SAME migration as the reason it
-- enables, for the same reason 044 did it.
ALTER TABLE managed_campaigns DROP CONSTRAINT IF EXISTS managed_campaigns_no_rec_reason_check;
ALTER TABLE managed_campaigns ADD CONSTRAINT managed_campaigns_no_rec_reason_check
  CHECK (no_rec_reason IN (
    'stable','collecting','budget_below_threshold','delivery_blocked',
    'no_comparable_audiences','no_comparable_creatives',
    'below_object_evidence_floor','cooling_down','tracking_broken','cta_broken',
    'account_cannot_spend'
  ));
