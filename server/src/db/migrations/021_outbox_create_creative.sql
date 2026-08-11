-- Widen the outbox (AIC-13, extended by AIC-50) for AIC-51's creative-creation
-- step (createCreativeFromUpload / createCreativeFromExistingPost) — same
-- idempotency reasoning as the campaign/ad-set/ad creates: a customer
-- resubmitting the creative step must never create a second ad creative.
ALTER TABLE meta_write_outbox DROP CONSTRAINT meta_write_outbox_kind_check;
ALTER TABLE meta_write_outbox ADD CONSTRAINT meta_write_outbox_kind_check
  CHECK (kind IN ('set_daily_budget', 'pause_ad', 'create_campaign', 'create_ad_set', 'create_ad', 'create_creative'));
