-- Launch gate (AIC-53): the customer's explicit approval to flip a
-- builder-created campaign from PAUSED to spending. NULL = not yet launched
-- (a brand-new builder campaign, review-approved but not yet activated on
-- Meta). Every EXISTING row is backfilled non-NULL here — those campaigns
-- were already active on Meta before this ticket existed, so they are
-- retroactively "already launched," not newly gated. Only a builder-created
-- row inserted AFTER this migration starts genuinely NULL.
ALTER TABLE managed_campaigns ADD COLUMN launch_approved_at TIMESTAMPTZ;
UPDATE managed_campaigns SET launch_approved_at = COALESCE(created_at, now());
