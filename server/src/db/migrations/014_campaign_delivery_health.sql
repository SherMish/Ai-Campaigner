-- Ad-set delivery health (AIC-39). Cached per campaign from effective_status +
-- issues_info so the customer dashboard can show "needs attention" and the engine
-- knows which ad sets are errored — without a live Meta call at render time.
-- Kept separate from `status` so a delivery problem surfaces to the customer
-- WITHOUT stopping the engine from optimizing the campaign's healthy ad sets.
ALTER TABLE managed_campaigns ADD COLUMN delivery_ok BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE managed_campaigns ADD COLUMN delivery_reason TEXT;
ALTER TABLE managed_campaigns ADD COLUMN delivery_checked_at TIMESTAMPTZ;
