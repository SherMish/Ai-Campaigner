-- P0 entities (1/6): customers + subscriptions.
-- Money is always integer agorot. Enum-like columns are TEXT + CHECK, mirrored
-- in shared/src/domain.ts.

-- Shared trigger to keep updated_at honest without the app having to remember.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE customers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  business_name     TEXT NOT NULL,
  category          TEXT NOT NULL DEFAULT '',   -- beautician, fitness, tutor…
  main_service      TEXT NOT NULL DEFAULT '',
  geo_area          TEXT NOT NULL DEFAULT '',   -- service area (free text in P0)
  primary_customer  TEXT NOT NULL DEFAULT '',   -- who their customer is
  offer             TEXT NOT NULL DEFAULT '',
  contact_name      TEXT NOT NULL DEFAULT '',
  contact_phone     TEXT NOT NULL DEFAULT '',
  contact_email     TEXT NOT NULL DEFAULT '',
  is_test           BOOLEAN NOT NULL DEFAULT false,  -- dogfood/internal (Pisga)
  onboarding_status TEXT NOT NULL DEFAULT 'call_scheduled'
    CHECK (onboarding_status IN
      ('call_scheduled','meta_connection_required','campaign_under_review','ready'))
);

CREATE TRIGGER customers_set_updated_at
  BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE subscriptions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  customer_id           UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  plan                  TEXT NOT NULL DEFAULT 'p0_standard',
  setup_paid            BOOLEAN NOT NULL DEFAULT false,
  setup_paid_at         TIMESTAMPTZ,
  setup_amount_agorot   INTEGER NOT NULL DEFAULT 29900,   -- ₪299
  monthly_amount_agorot INTEGER NOT NULL DEFAULT 29900,   -- ₪299/mo
  status                TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','active','lapsed','canceled')),
  next_charge_date      DATE,
  UNIQUE (customer_id)   -- one subscription per customer in P0
);

CREATE TRIGGER subscriptions_set_updated_at
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
