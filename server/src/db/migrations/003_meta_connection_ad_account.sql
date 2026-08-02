-- P0 entities (2/6): meta_connections + ad_accounts.
-- meta_connections is audit-critical: it records whether we can operate a
-- customer's assets. access_health drives the execution-halt safety rule (P0.3).

CREATE TABLE meta_connections (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  customer_id           UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  business_portfolio_id TEXT NOT NULL DEFAULT '',  -- customer's BM id (partner)
  system_user_id        TEXT NOT NULL DEFAULT '',  -- our System User operating it
  page_id               TEXT,                       -- shared Page (for creatives)
  instagram_id          TEXT,                       -- shared IG (for creatives)
  -- Per-asset grant detail (ad_account / page / instagram → granted?/scopes),
  -- kept as JSONB so the shape can grow without a migration.
  asset_grants          JSONB NOT NULL DEFAULT '{}'::jsonb,
  access_health         TEXT NOT NULL DEFAULT 'needs_reconnect'
    CHECK (access_health IN ('ok','revoked','invalid','needs_reconnect')),
  last_verified_at      TIMESTAMPTZ,
  UNIQUE (customer_id)   -- one connection per customer in P0
);

CREATE TRIGGER meta_connections_set_updated_at
  BEFORE UPDATE ON meta_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE ad_accounts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  connection_id      UUID NOT NULL REFERENCES meta_connections(id) ON DELETE CASCADE,
  meta_ad_account_id TEXT NOT NULL,        -- e.g. act_123456789
  name               TEXT NOT NULL DEFAULT '',
  currency           TEXT NOT NULL DEFAULT 'ILS',
  timezone           TEXT NOT NULL DEFAULT 'Asia/Jerusalem',
  UNIQUE (meta_ad_account_id)
);

CREATE INDEX ad_accounts_connection_idx ON ad_accounts (connection_id);
