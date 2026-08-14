-- AIC-85: "stable" was a dishonest catch-all standing in for three different
-- situations — genuinely nothing to flag, nothing comparable to evaluate at
-- all, and comparable objects that just haven't cleared the spend gate yet.
-- Widen the CHECK to distinguish them, same drop/re-add pattern as
-- migrations 013/024/032.
--
-- Renames `single_ad_set` -> `no_comparable_audiences` (fixes the actual bug:
-- the old check counted raw ad-set presence, which let a dormant ad set
-- silently count as "comparable" and fall through to `stable`; the new
-- reason is backed by comparableAdsets(), which excludes dormant objects by
-- share of campaign spend). Safe with no data migration: no_rec_reason is
-- overwritten every engine tick, not a historical record, and both the ops
-- and customer renderers already fall back gracefully on an unrecognized
-- string in the meantime.
ALTER TABLE managed_campaigns DROP CONSTRAINT managed_campaigns_no_rec_reason_check;
ALTER TABLE managed_campaigns ADD CONSTRAINT managed_campaigns_no_rec_reason_check CHECK (no_rec_reason IN
  ('stable', 'collecting', 'budget_below_threshold', 'delivery_blocked', 'no_comparable_audiences',
   'cooling_down', 'below_object_evidence_floor', 'no_comparable_creatives'));
