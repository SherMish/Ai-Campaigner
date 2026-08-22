-- `tracking_broken` was added as a NoActionReason (AIC-88) and wired all the
-- way through: classifyNoAction returns it, the customer surface has copy for
-- it, the ops console has an operator label for it. But the CHECK constraint
-- on managed_campaigns.no_rec_reason was never widened to accept it — the
-- last widening (035) predates the reason.
--
-- The failure was invisible by construction: recordNoRecReason's write is
-- wrapped in a try/catch that logs and continues (generation.ts), so every
-- attempt to cache this reason raised a constraint violation, was swallowed,
-- and the column simply stayed stale. A campaign whose tracking is broken has
-- therefore never been able to SAY so on the dashboard.
--
-- docs/RULES.md warns about exactly this class of silent failure. It had
-- already happened.
--
-- Verified against the live database before writing this: the constraint's
-- array contained 8 values, without 'tracking_broken'.
ALTER TABLE managed_campaigns DROP CONSTRAINT IF EXISTS managed_campaigns_no_rec_reason_check;
ALTER TABLE managed_campaigns ADD CONSTRAINT managed_campaigns_no_rec_reason_check
  CHECK (no_rec_reason IN (
    'stable',
    'collecting',
    'budget_below_threshold',
    'delivery_blocked',
    'no_comparable_audiences',
    'no_comparable_creatives',
    'below_object_evidence_floor',
    'cooling_down',
    'tracking_broken'
  ));
