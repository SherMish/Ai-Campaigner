-- No-recommendation reason (AIC-64): why the engine had nothing to propose this
-- tick, cached per campaign so the dashboard/ops console can show it without
-- re-running evaluation at render time. Mirrors delivery_ok/delivery_reason
-- (AIC-39, migration 014) — engine writes every generation tick, UI reads.
-- NULL when the latest tick produced an acting recommendation (nothing to
-- explain) or before the engine has ever run for this campaign.
ALTER TABLE managed_campaigns ADD COLUMN no_rec_reason TEXT
  CHECK (no_rec_reason IN ('stable', 'collecting', 'budget_below_threshold', 'delivery_blocked', 'single_ad_set'));
ALTER TABLE managed_campaigns ADD COLUMN no_rec_detail JSONB;
ALTER TABLE managed_campaigns ADD COLUMN no_rec_checked_at TIMESTAMPTZ;
