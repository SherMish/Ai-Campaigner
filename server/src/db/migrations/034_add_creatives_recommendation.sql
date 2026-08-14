-- AIC-86: a new recommendation type, `add_creatives_for_comparison` — advisory
-- only, never a Meta write. Fires when the campaign has fewer than 2 real
-- (non-dormant) creatives to compare, so pause_creative/replace_creative have
-- nothing to judge against regardless of spend or thresholds. The CTA routes
-- to the existing add-ad flow (AIC-63), not the approve/execute pipeline.
-- Widen the recommendations.type CHECK — same drop/re-add pattern as
-- migration 013 (pause_adset).
ALTER TABLE recommendations DROP CONSTRAINT recommendations_type_check;
ALTER TABLE recommendations ADD CONSTRAINT recommendations_type_check CHECK (type IN
  ('pause_creative','pause_adset','increase_budget','decrease_budget','replace_creative',
   'no_action','add_creatives_for_comparison'));
