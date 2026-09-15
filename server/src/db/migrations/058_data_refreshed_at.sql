-- AIC-191 — when a campaign's data was last pulled from Meta.
--
-- Hourly polling is off; a campaign is refreshed when its dashboard is opened.
-- This is what stops every reload and every campaign switch from being a fresh
-- burst of Meta calls — which is the rate limit the change exists to escape,
-- merely moved from the scheduler to the customer's browser.
--
-- NULL means never refreshed on demand, which is the right first-load answer.
ALTER TABLE managed_campaigns
  ADD COLUMN IF NOT EXISTS data_refreshed_at TIMESTAMPTZ;
