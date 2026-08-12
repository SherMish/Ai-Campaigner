-- Live budget sync: the customer dashboard was showing agreed_budget_agorot
-- (a safety CEILING for the engine's own automated proposals, AIC-13) as if
-- it were "today's budget" — when a customer or operator changes the daily
-- budget directly on Meta, that number silently goes stale. The engine
-- already reads the live budget every generation tick (it needs it to
-- evaluate rules); this caches that read for display, mirroring
-- delivery_ok/delivery_reason (AIC-39) and no_rec_reason (AIC-64) — engine
-- writes every tick, UI reads, no live Meta call at render time.
ALTER TABLE managed_campaigns ADD COLUMN live_budget_agorot INTEGER;
ALTER TABLE managed_campaigns ADD COLUMN live_budget_checked_at TIMESTAMPTZ;
