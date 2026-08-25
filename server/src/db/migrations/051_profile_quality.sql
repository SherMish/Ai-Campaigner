-- AIC-132: is the business profile good enough to advertise from?
--
-- The only health check whose subject is OUR OWN homework rather than Meta's
-- data — which is why it lives on `customers` and not on `managed_campaigns`.
-- A business is described once; every campaign it ever runs inherits the same
-- answer, and storing it per campaign would let the copies disagree.
--
-- Defaults to NULL rather than true: unlike cta_ok/account_ok, "not checked
-- yet" here is genuinely unknown, and defaulting to `true` would silently
-- declare every existing customer fine on the day this shipped.
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS profile_ok BOOLEAN,
  ADD COLUMN IF NOT EXISTS profile_state TEXT,
  ADD COLUMN IF NOT EXISTS profile_reason TEXT,
  ADD COLUMN IF NOT EXISTS profile_detail JSONB,
  ADD COLUMN IF NOT EXISTS profile_checked_at TIMESTAMPTZ;

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_profile_state_check;
ALTER TABLE customers ADD CONSTRAINT customers_profile_state_check
  CHECK (profile_state IS NULL OR profile_state IN ('ok','thin','broken'));

-- The engine must be able to say "I have nothing to propose because nobody
-- told me what this business sells" — which is NOT `collecting`. "Still
-- gathering data" is false: the missing data was never Meta's to give, it is
-- ours, and reporting it as a waiting-on-Meta state sends an operator to look
-- in the wrong place.
ALTER TABLE managed_campaigns DROP CONSTRAINT IF EXISTS managed_campaigns_no_rec_reason_check;
ALTER TABLE managed_campaigns ADD CONSTRAINT managed_campaigns_no_rec_reason_check
  CHECK (no_rec_reason IN (
    'stable','collecting','budget_below_threshold','delivery_blocked',
    'no_comparable_audiences','no_comparable_creatives',
    'below_object_evidence_floor','cooling_down','tracking_broken','cta_broken',
    'account_cannot_spend','lead_event_stopped','profile_incomplete'
  ));

-- Ops item type, widened in the SAME migration as the reason it enables —
-- migration 042 is the record of what happens when those drift apart.
ALTER TABLE ops_queue_items DROP CONSTRAINT IF EXISTS ops_queue_items_type_check;
ALTER TABLE ops_queue_items ADD CONSTRAINT ops_queue_items_type_check CHECK (type IN (
  'meta_connection_failure','campaign_not_delivering','campaign_rejected',
  'unusual_performance','recommendation_review','support_request',
  'missing_creative','account_restriction','campaign_tracking_broken',
  'campaign_cta_broken','ad_account_cannot_spend','lead_event_stopped',
  'leads_possibly_overcounted','business_profile_incomplete'));
