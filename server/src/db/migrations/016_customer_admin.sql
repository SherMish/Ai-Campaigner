-- Customer lifecycle (soft-deactivate) + admin action audit log (AIC-44).
--
-- Deactivate is reversible: is_active flips back, deactivated_at clears. Hard
-- delete is a real DELETE (customers cascades to subscriptions/meta_connections/
-- managed_campaigns/... — see migrations 002-015); the audit row is the only
-- thing that outlives it, so entity_id here is deliberately NOT a foreign key.

ALTER TABLE customers
  ADD COLUMN is_active      BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN deactivated_at TIMESTAMPTZ;

CREATE TABLE admin_audit_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
  actor_label   TEXT NOT NULL DEFAULT '',   -- snapshot (email) — survives actor deletion
  action        TEXT NOT NULL,              -- 'customer.create' | 'customer.edit' | 'customer.deactivate' | 'customer.reactivate' | 'customer.delete' (AIC-47 adds more)
  entity_type   TEXT NOT NULL,              -- 'customer' for now
  entity_id     UUID,                       -- no FK: a hard-deleted entity must still be legible in the log
  entity_label  TEXT NOT NULL DEFAULT '',   -- e.g. business_name, so entries read without a join
  before_state  JSONB,
  after_state   JSONB,
  detail        TEXT NOT NULL DEFAULT ''
);

CREATE INDEX admin_audit_log_entity_idx  ON admin_audit_log (entity_type, entity_id);
CREATE INDEX admin_audit_log_actor_idx   ON admin_audit_log (actor_user_id);
CREATE INDEX admin_audit_log_created_idx ON admin_audit_log (created_at DESC);
