-- Reliable Meta writes (AIC-13). A durable queue of intended mutations with a
-- unique idempotency key per intended change, so a lost API response on retry
-- can't double-apply (double budget-bump / double pause). Only absolute-set,
-- naturally-idempotent operations are enqueued (set_daily_budget, pause_ad), so
-- re-applying the same row reaches the same end state.

CREATE TABLE meta_write_outbox (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key   TEXT UNIQUE NOT NULL,   -- deterministic per intended change
  campaign_id       UUID NOT NULL REFERENCES managed_campaigns(id) ON DELETE CASCADE,
  recommendation_id UUID REFERENCES recommendations(id) ON DELETE SET NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('set_daily_budget','pause_ad')),
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  status            TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','in_progress','succeeded','failed')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER meta_write_outbox_set_updated_at
  BEFORE UPDATE ON meta_write_outbox
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Drain index: only rows still eligible to run.
CREATE INDEX meta_write_outbox_drain_idx
  ON meta_write_outbox (next_attempt_at)
  WHERE status = 'pending';
