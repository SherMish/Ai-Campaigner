-- AIC-67: replace the cumulative-weekly single value with an incremental
-- delta-review log. The old model asked "of your N leads this week, how many
-- were relevant?" as one editable number with NO memory of what was already
-- reviewed — a customer answering twice in the same week (leads grew from 2
-- to 5) had to remember they'd already counted the first 2, or double-count.
--
-- lead_quality_reviews is an append-only event log: each row is one review
-- action, covering exactly the leads that were NEW since the previous
-- review (leads_delta), with how many of THOSE were relevant
-- (relevant_delta). The all-time watermark (how many leads have ever been
-- reviewed, how many were relevant) is SUM() over this table — cheap, since
-- there are only ever a handful of review events per campaign lifetime, not
-- one row per lead. Re-rating the same leads is structurally impossible: the
-- next review's delta is always computed server-side as
-- max(0, leads-to-date - SUM(leads_delta so far)), never client-supplied.
CREATE TABLE lead_quality_reviews (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id    UUID NOT NULL REFERENCES managed_campaigns(id) ON DELETE CASCADE,
  reviewed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  leads_delta    INTEGER NOT NULL CHECK (leads_delta > 0),
  relevant_delta INTEGER NOT NULL CHECK (relevant_delta >= 0 AND relevant_delta <= leads_delta)
);

CREATE INDEX lead_quality_reviews_campaign_idx ON lead_quality_reviews (campaign_id, reviewed_at);

-- Carry existing per-week answers forward as the initial watermark (no data
-- loss) — one backfill row per campaign that already had at least one
-- lead_quality_feedback entry, summing everything ever reported. Without
-- this, the very first post-migration prompt would re-ask about leads the
-- customer already rated in the old weekly form.
INSERT INTO lead_quality_reviews (campaign_id, reviewed_at, leads_delta, relevant_delta)
SELECT campaign_id, now(), SUM(leads_reported), LEAST(SUM(relevant_count), SUM(leads_reported))
FROM lead_quality_feedback
GROUP BY campaign_id
HAVING SUM(leads_reported) > 0;
