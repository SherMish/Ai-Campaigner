-- Add-to-existing-campaign (AIC-63): a created-but-not-yet-approved ad or ad
-- set added to a campaign that's already managed (not a first-time build —
-- that's managed_campaigns.launch_approved_at). Inserted only ONCE every
-- Meta create for the addition has succeeded (mirrors buildCampaignOnMeta's
-- "anchor only once complete" pattern) — the underlying creates are already
-- safe to retry via the outbox, so this table is purely the approval marker.
CREATE TABLE pending_additions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  campaign_id    UUID NOT NULL REFERENCES managed_campaigns(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('ad', 'ad_set')),
  -- Client-generated, stable across a resubmission of the same add attempt —
  -- same role as the outbox's idempotency key, but for the "insert the
  -- approval-pending row" step itself: without this, a double-submit whose
  -- underlying Meta creates all replay-as-already-succeeded (correctly, via
  -- the outbox) would still insert a SECOND pending row for the same objects.
  addition_key   TEXT NOT NULL,
  name           TEXT NOT NULL DEFAULT '',
  -- The ad set this addition affects: an EXISTING one (kind='ad') or the
  -- newly created one (kind='ad_set') — either way, this is what needs
  -- activating alongside meta_ad_ids for the campaign to actually deliver.
  meta_ad_set_id TEXT NOT NULL,
  meta_ad_ids    JSONB NOT NULL DEFAULT '[]'::jsonb,
  approved_at    TIMESTAMPTZ,
  UNIQUE (campaign_id, addition_key)
);

CREATE INDEX pending_additions_campaign_idx ON pending_additions (campaign_id);
