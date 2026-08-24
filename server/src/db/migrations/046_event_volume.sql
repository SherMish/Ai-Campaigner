-- AIC-91: cache whether a campaign's LEAD EVENT is still firing on the pixel.
--
-- The gap AIC-88 (tracking-health) explicitly left open. That check compares the
-- declared lead definition against the ad sets' Meta config — it catches a WRONG
-- or MISSING lead type, and cannot catch a CORRECTLY declared one whose event
-- silently stopped: a deploy that dropped the pixel call from the thank-you
-- page, a consent-banner change, a broken form.
--
-- Fourth in the same family (038 tracking, 044 CTA, 045 account). Same
-- ok/reason/detail/checked_at quartet, same per-tick cache, same escalation.
ALTER TABLE managed_campaigns
  ADD COLUMN lead_event_ok BOOLEAN DEFAULT true,
  ADD COLUMN lead_event_reason TEXT,
  ADD COLUMN lead_event_detail JSONB,
  ADD COLUMN lead_event_checked_at TIMESTAMPTZ;

ALTER TABLE ops_queue_items DROP CONSTRAINT ops_queue_items_type_check;
ALTER TABLE ops_queue_items ADD CONSTRAINT ops_queue_items_type_check CHECK (type IN (
  'meta_connection_failure','campaign_not_delivering','campaign_rejected',
  'unusual_performance','recommendation_review','support_request',
  'missing_creative','account_restriction','campaign_tracking_broken',
  'campaign_cta_broken','ad_account_cannot_spend','lead_event_stopped'));

ALTER TABLE managed_campaigns DROP CONSTRAINT IF EXISTS managed_campaigns_no_rec_reason_check;
ALTER TABLE managed_campaigns ADD CONSTRAINT managed_campaigns_no_rec_reason_check
  CHECK (no_rec_reason IN (
    'stable','collecting','budget_below_threshold','delivery_blocked',
    'no_comparable_audiences','no_comparable_creatives',
    'below_object_evidence_floor','cooling_down','tracking_broken','cta_broken',
    'account_cannot_spend','lead_event_stopped'
  ));
