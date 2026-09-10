-- AIC-186 — the customer connects their own Meta account, instead of an
-- operator provisioning it by hand.
--
-- Two things need storing that never had a home before: the one-time state we
-- hand to Meta, and the token Meta hands back.

-- The OAuth state.
--
-- Our session is a JWT in an Authorization header, and a browser sends no
-- Authorization header on a top-level navigation. So neither the redirect out
-- nor Meta's callback back can identify the customer the usual way, and the
-- `state` parameter has to carry that identity itself.
--
-- A signature alone would make the state REPLAYABLE: anyone who captured a
-- callback URL could re-present it. This table is what makes it single-use —
-- `spent_at` is set inside the same transaction that reads it, so a second
-- callback with the same nonce finds it already spent and is refused.
--
-- Rows are small and short-lived; `expires_at` is what makes them so. There is
-- deliberately no ON DELETE CASCADE from app_users: an expired state is
-- garbage whoever it belonged to, and the sweeper does not need to care.
CREATE TABLE IF NOT EXISTS meta_oauth_states (
  nonce       TEXT PRIMARY KEY,
  user_id     UUID NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  spent_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS meta_oauth_states_expiry_idx
  ON meta_oauth_states (expires_at) WHERE spent_at IS NULL;

-- The token, and what it was granted over.
--
-- `access_token_encrypted` is AES-256-GCM ciphertext (see meta/token-crypto.ts),
-- never the raw token. A Meta system-user token is a live write credential for
-- someone else's ad account and it does not expire — the two properties that
-- make plaintext at rest indefensible here.
--
-- The granted_* arrays record what the customer actually chose in Meta's asset
-- picker. They are NOT the same as "what we manage": the customer may grant
-- four ad accounts and we still only ever operate the one they select. Storing
-- the grant separately from the selection is what lets the second question be
-- re-asked later without sending them back through consent.
ALTER TABLE meta_connections
  ADD COLUMN IF NOT EXISTS access_token_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS token_scopes           TEXT[],
  ADD COLUMN IF NOT EXISTS meta_user_id           TEXT,
  ADD COLUMN IF NOT EXISTS granted_business_ids   TEXT[],
  ADD COLUMN IF NOT EXISTS granted_ad_account_ids TEXT[],
  ADD COLUMN IF NOT EXISTS granted_page_ids       TEXT[],
  ADD COLUMN IF NOT EXISTS granted_instagram_ids  TEXT[],
  ADD COLUMN IF NOT EXISTS connected_via          TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS connected_at           TIMESTAMPTZ;

-- 'manual' is every row that predates this: an operator shared assets into our
-- portfolio and assigned them to the shared System User. Those rows have no
-- token of their own and must keep resolving to the env token, so the default
-- is the old world and 'oauth' is the opt-in.
ALTER TABLE meta_connections DROP CONSTRAINT IF EXISTS meta_connections_connected_via_check;
ALTER TABLE meta_connections ADD CONSTRAINT meta_connections_connected_via_check
  CHECK (connected_via IN ('manual', 'oauth'));

-- A row claiming to be an OAuth connection without a token is not a connection,
-- it is a half-finished callback. Refusing it in the schema means no read path
-- has to defend against the shape.
ALTER TABLE meta_connections DROP CONSTRAINT IF EXISTS meta_connections_oauth_needs_token_check;
ALTER TABLE meta_connections ADD CONSTRAINT meta_connections_oauth_needs_token_check
  CHECK (connected_via <> 'oauth' OR access_token_encrypted IS NOT NULL);
