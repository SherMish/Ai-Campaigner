-- Customer auth (AIC-21): the person who logs in. Separate from `customers` (the
-- business); linked once onboarding associates them. Email is case-insensitive
-- unique. Passwords are bcrypt hashes — never plaintext.

CREATE TABLE app_users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  customer_id   UUID REFERENCES customers(id) ON DELETE SET NULL
);

-- Case-insensitive unique email.
CREATE UNIQUE INDEX app_users_email_lower_idx ON app_users (lower(email));

CREATE TRIGGER app_users_set_updated_at
  BEFORE UPDATE ON app_users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
