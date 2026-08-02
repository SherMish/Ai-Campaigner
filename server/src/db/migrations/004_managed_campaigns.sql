-- P0 entities (3/6): managed_campaigns.
-- The one campaign we manage per customer in P0. Budget in agorot.
-- automation_enabled is the per-account emergency brake (AIC-14).

CREATE TABLE managed_campaigns (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  customer_id          UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  ad_account_id        UUID NOT NULL REFERENCES ad_accounts(id) ON DELETE CASCADE,
  meta_campaign_id     TEXT,   -- the Meta campaign object id (null until linked)
  name                 TEXT NOT NULL DEFAULT '',
  status               TEXT NOT NULL DEFAULT 'under_review'
    CHECK (status IN
      ('under_review','active','paused','needs_attention','connection_problem','unmanaged')),
  objective            TEXT NOT NULL DEFAULT 'leads',   -- P0 = leads / WhatsApp
  whatsapp_destination TEXT NOT NULL DEFAULT '',
  agreed_budget_agorot INTEGER NOT NULL DEFAULT 0,
  budget_period        TEXT NOT NULL DEFAULT 'daily'
    CHECK (budget_period IN ('daily','monthly')),
  automation_enabled   BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (customer_id)   -- one managed campaign per customer in P0
);

CREATE TRIGGER managed_campaigns_set_updated_at
  BEFORE UPDATE ON managed_campaigns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX managed_campaigns_status_idx ON managed_campaigns (status);
