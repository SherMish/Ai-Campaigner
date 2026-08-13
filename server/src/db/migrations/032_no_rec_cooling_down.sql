-- AIC-77b: a 6th no-rec reason — `cooling_down`. After an engine-authored
-- action executes, the same class of change is suppressed for
-- RULE_THRESHOLDS.COOLDOWN_DAYS (default 7, resolvable per account like
-- every other threshold since AIC-77a) so the engine never recommends
-- against an outcome it hasn't had time to measure yet. Reported ONLY when a
-- rule actually would have fired and was suppressed — never a generic
-- placeholder when nothing was warranted anyway (that stays stable/collecting).
-- Widen the same CHECK migration 024 added, same pattern as migration 013
-- widening recommendations.type for pause_adset.
ALTER TABLE managed_campaigns DROP CONSTRAINT managed_campaigns_no_rec_reason_check;
ALTER TABLE managed_campaigns ADD CONSTRAINT managed_campaigns_no_rec_reason_check CHECK (no_rec_reason IN
  ('stable', 'collecting', 'budget_below_threshold', 'delivery_blocked', 'single_ad_set', 'cooling_down'));
