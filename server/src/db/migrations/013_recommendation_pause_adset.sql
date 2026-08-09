-- Audience-aware rules (AIC-36): a new recommendation type `pause_adset` — pause
-- an underperforming audience (ad set). Under CBO the campaign budget then shifts
-- to the remaining ad set(s). Widen the recommendations.type CHECK to allow it.
ALTER TABLE recommendations DROP CONSTRAINT recommendations_type_check;
ALTER TABLE recommendations ADD CONSTRAINT recommendations_type_check CHECK (type IN
  ('pause_creative','pause_adset','increase_budget','decrease_budget','replace_creative','no_action'));
