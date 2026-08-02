-- Ops console (P0.4). Triage fields on the needs-attention queue (AIC-17) and the
-- first-campaign review record (AIC-18).

ALTER TABLE ops_queue_items ADD COLUMN claimed_by      TEXT;
ALTER TABLE ops_queue_items ADD COLUMN resolution_note TEXT;

CREATE TABLE campaign_reviews (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  campaign_id          UUID NOT NULL REFERENCES managed_campaigns(id) ON DELETE CASCADE,
  reviewer             TEXT NOT NULL,
  outcome              TEXT NOT NULL
    CHECK (outcome IN ('approved','changes_requested','unsupported')),
  checklist            JSONB NOT NULL DEFAULT '{}'::jsonb,  -- §11 checklist results
  notes                TEXT NOT NULL DEFAULT '',
  -- For changes_requested: NULL = awaiting customer, true/false = their decision.
  customer_approved    BOOLEAN,
  customer_approved_at TIMESTAMPTZ
);

CREATE INDEX campaign_reviews_campaign_idx ON campaign_reviews (campaign_id, created_at DESC);
