-- AIC-77a: per-account overrides for the recommendation engine's thresholds
-- (server/src/recommendations/rules.ts's RULE_THRESHOLDS). Sparse — only the
-- keys an operator explicitly overrode are present; every other key resolves
-- to a budget-relative formula (for the two minimum-evidence spend gates) or
-- the flat global default. Shape validated in app code (customer-admin.ts),
-- not here — matching every other JSONB column in this schema (asset_grants,
-- evidence, previous_state/new_state, no_rec_detail): none are DB-validated.
ALTER TABLE managed_campaigns ADD COLUMN threshold_overrides JSONB NOT NULL DEFAULT '{}'::jsonb;
