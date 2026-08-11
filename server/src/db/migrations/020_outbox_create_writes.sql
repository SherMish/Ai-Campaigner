-- Extend the reliable-writes outbox (AIC-13) for the builder's create-writes
-- (AIC-50). Same idempotency mechanism (a UNIQUE idempotency_key per intended
-- object) — a create is naturally NOT idempotent on its own (calling
-- POST /campaigns twice makes two campaigns), so the outbox row is what makes
-- "the builder died mid-create, or the request retried" safe: re-running with
-- the same key finds the already-succeeded row and skips re-creating.
--
-- `result` carries the created object's real Meta id once a create_* row
-- succeeds — nothing else needs it (set_daily_budget/pause_ad have no result
-- to remember), so it's nullable.
ALTER TABLE meta_write_outbox DROP CONSTRAINT meta_write_outbox_kind_check;
ALTER TABLE meta_write_outbox ADD CONSTRAINT meta_write_outbox_kind_check
  CHECK (kind IN ('set_daily_budget', 'pause_ad', 'create_campaign', 'create_ad_set', 'create_ad'));

ALTER TABLE meta_write_outbox ADD COLUMN result JSONB;
