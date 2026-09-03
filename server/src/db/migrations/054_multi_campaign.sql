-- AIC-186 — more than one managed campaign per customer.
--
-- `managed_campaigns.customer_id` carried a UNIQUE constraint, so a customer
-- could hold exactly one campaign. That was right for P0 (one WhatsApp
-- campaign per business) and is now the thing standing between a customer and
-- their own engagement campaign: Liam has both a leads and an engagement
-- campaign live on Meta, and the second could not be connected at all.
--
-- Dropping a UNIQUE constraint is one line and is NOT the work. Every customer
-- route resolves "the" campaign from the user with LIMIT 1, and each one now
-- has to know WHICH. The resolvers take an optional campaign id and fall back
-- to the single-campaign behaviour when it is absent, so nothing that worked
-- yesterday changes shape today.
--
-- The index is kept — every lookup is still by customer — it just stops being
-- unique.
ALTER TABLE managed_campaigns DROP CONSTRAINT managed_campaigns_customer_id_key;
CREATE INDEX IF NOT EXISTS managed_campaigns_customer_idx ON managed_campaigns (customer_id);

-- A campaign now records what it is FOR. Until now every managed campaign was
-- a WhatsApp leads campaign by construction, so the destination lived only in
-- the builder's request and was never persisted — which is why an adopted
-- campaign's type is currently unknowable after the fact.
--
-- Defaulting to 'whatsapp' is correct rather than convenient: every existing
-- row genuinely is one, and there is no ambiguity to preserve.
ALTER TABLE managed_campaigns
  ADD COLUMN IF NOT EXISTS destination TEXT NOT NULL DEFAULT 'whatsapp';

ALTER TABLE managed_campaigns DROP CONSTRAINT IF EXISTS managed_campaigns_destination_check;
ALTER TABLE managed_campaigns ADD CONSTRAINT managed_campaigns_destination_check
  CHECK (destination IN ('whatsapp', 'website', 'engagement'));

-- With customer_id no longer unique, "this customer already linked this Meta
-- campaign" needs its own guard — otherwise adopting the same campaign twice
-- silently creates a duplicate, and two rows for one Meta object is how the
-- dashboard starts double-counting spend.
--
-- Partial, on purpose: a connect-only provision writes a SHELL row with a NULL
-- meta_campaign_id (Branch A), and a customer may legitimately have one shell
-- waiting for the builder. NULLs are excluded so the shell never conflicts.
--
-- NOT unique on meta_campaign_id alone: two customers genuinely can point at
-- the same Meta campaign (it happened — the Pisga/Liam overlap on
-- 120249004871310352), and a global unique would have made that unfixable.
CREATE UNIQUE INDEX IF NOT EXISTS managed_campaigns_customer_meta_uniq
  ON managed_campaigns (customer_id, meta_campaign_id)
  WHERE meta_campaign_id IS NOT NULL;
