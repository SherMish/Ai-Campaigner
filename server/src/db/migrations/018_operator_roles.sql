-- Operator accounts (AIC-47): the minimal role set needed for one concrete
-- gate — "only a full-admin can manage operators" — not a general RBAC
-- overhaul of the console (every other admin route stays gated on is_admin
-- alone, as before). full_admin can add/remove/promote operators; operator
-- has the same console access otherwise.

ALTER TABLE app_users
  ADD COLUMN admin_role TEXT NOT NULL DEFAULT 'operator'
    CHECK (admin_role IN ('full_admin', 'operator'));

-- Backfill: today's admin(s) become full_admin so nobody loses the ability to
-- manage operators the moment this ships.
UPDATE app_users SET admin_role = 'full_admin' WHERE is_admin = true;
