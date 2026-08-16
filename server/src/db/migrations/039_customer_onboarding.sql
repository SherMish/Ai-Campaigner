-- AIC-101: per-customer onboarding wizard state.
--
-- Two jobs, both learned from how onboarding actually failed:
--
-- 1. RESUMABLE. The wizard is driven live on a phone call, and calls get
--    interrupted — the customer has to find their password, or fetch whoever
--    actually has admin on the Business Portfolio. Losing the operator's
--    place because a tab closed makes the tool worse than the markdown file
--    it replaces.
--
-- 2. TRACEABLE. Every layer check records its verdict AND when it passed, so
--    a connection that breaks in three weeks can be traced back to what was
--    genuinely verified at onboarding versus what was assumed. The whole
--    class of bug this feature exists to prevent (a Business Settings UI that
--    looks correct over a backend with zero access) is invisible precisely
--    because nobody wrote down what was actually checked.
--
-- `checks` is JSONB keyed by check id (e.g. "page", "ad_account", "token"),
-- each holding { ok, layer, diagnosis, detail, at }. JSONB rather than a
-- column per check because the set of checks is a product decision that will
-- move, and a migration per new check would guarantee the schema lags the
-- wizard. The classifier's verdict shape (meta/access-layers.ts) is the
-- contract; this column stores it verbatim.
--
-- One row per customer: this is current state, not an event log. Action
-- history that genuinely needs an audit trail already has one
-- (admin_audit_log), and duplicating it here would create a second, weaker
-- copy of the same record.
CREATE TABLE customer_onboarding (
  customer_id  UUID PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  -- 1-indexed to match the operator-facing step numbering exactly; an
  -- off-by-one between the DB and the script the operator is reading aloud is
  -- the kind of confusion this feature exists to remove.
  current_step INT NOT NULL DEFAULT 1,
  checks       JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set only when the wizard genuinely reaches a verified connection, so
  -- "onboarded" is never inferred from the presence of rows someone created
  -- by hand.
  completed_at TIMESTAMPTZ
);
