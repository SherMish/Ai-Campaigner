-- AIC-188 — the customer's own website, asked for during onboarding.
--
-- Optional, and '' rather than NULL to match every other profile text column on
-- this table (offer, differentiators, geo_area…). One convention for "not
-- provided" means no read path has to handle two.
--
-- Worth having beyond the profile: it is the strongest single hint about what a
-- business actually sells, and the copy generator currently has nothing to go on
-- until a human fills in the profile by hand.
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS website_url TEXT NOT NULL DEFAULT '';
