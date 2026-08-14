-- AIC-76: did the recommendation actually help? One outcome row per EXECUTED
-- recommendation, comparing a fixed before-window against a fixed after-window
-- anchored on executed_at.
--
-- The first engine-computed TABLE in this schema. Every prior computed cache
-- (delivery_ok, no_rec_reason, live_budget_agorot, leads_to_date, spend_to_date)
-- is a scalar column on managed_campaigns — fine for "current state", useless
-- for "one record per past event". Modeled on lead_quality_reviews (027), the
-- closest structural precedent: an append-only derived log keyed to an entity.
--
-- recommendation_id is UNIQUE on purpose: an outcome is measured ONCE, at the
-- defined window. Meta revises attribution for ~45 days, so re-measuring later
-- would silently rewrite history with different numbers. The verdict is "what
-- the defined window showed", not "what we believe today".
--
-- Attribution is CORRELATION, never causation — Meta's own optimisation,
-- seasonality, and competitor activity all move CPL. Nothing built on this
-- table may claim our change caused the delta. See
-- docs/features/outcome-measurement.md.
CREATE TABLE recommendation_outcomes (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  recommendation_id  UUID NOT NULL UNIQUE REFERENCES recommendations(id) ON DELETE CASCADE,
  campaign_id        UUID NOT NULL REFERENCES managed_campaigns(id) ON DELETE CASCADE,
  measured_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The two windows actually compared, stored so a verdict can always be
  -- re-derived and audited against the exact days it was computed from.
  -- The execution DAY itself is in neither window — the change landed
  -- mid-day, so it is contaminated by construction (same "complete days
  -- only" discipline the engine's evidence gates already follow).
  before_start       DATE NOT NULL,
  before_end         DATE NOT NULL,
  after_start        DATE NOT NULL,
  after_end          DATE NOT NULL,

  -- Campaign-grain features from the AIC-75 feature layer — IDENTICAL
  -- definitions on both sides, which is the reason the feature layer had to
  -- land first. Shape: { spendAgorot, leads, cplAgorot, daysActive }.
  -- cplAgorot is null-honest (null when leads = 0), never a fabricated 0/∞.
  before_features    JSONB NOT NULL,
  after_features     JSONB NOT NULL,

  -- The RAW movement, always stored even when the verdict buckets it
  -- `neutral`. The bucket is a view; this is the data. A real −11% CPL move
  -- stays visible as "neutral (−11%)", and re-bucketing later (once real
  -- outcomes justify a different band) is a recomputation over these
  -- numbers, not a re-collection. Shape: { cplPct, leadsPct, spendPct } —
  -- each null when the prior value was 0 (deltaPct's honest "no comparison").
  delta              JSONB NOT NULL,

  verdict            TEXT NOT NULL CHECK (verdict IN (
    'improved',           -- CPL down >= the materiality band
    'degraded',           -- CPL up   >= the materiality band
    'neutral',            -- moved, but inside the band (delta still stored)
    'confounded',         -- another change landed in the window; not scored
    'insufficient_data',  -- the window couldn't support a comparison at all
    'not_measurable'      -- no Meta write happened (replace_creative today)
  )),

  -- What made it `confounded`, with timestamps, so an operator can judge
  -- rather than trust an opaque flag. Null unless verdict = 'confounded'.
  confound_detail    JSONB,

  -- AIC-67 lead-quality reviews falling in each window. Recorded, NEVER a
  -- verdict input: lead_quality_reviews.reviewed_at is when the CUSTOMER
  -- reviewed, and leads_delta covers everything since their previous review,
  -- so a review inside the after-window may describe leads from before
  -- execution. Honest to record, dishonest to score. Null when no reviews.
  lead_quality_before JSONB,
  lead_quality_after  JSONB
);

CREATE INDEX recommendation_outcomes_campaign_idx
  ON recommendation_outcomes (campaign_id, measured_at DESC);
