-- P0 entities (4/6): insight_snapshots.
-- Normalized Meta Insights at four grains. Every recommendation and every
-- customer-facing number is downstream of this table (AIC-6).
--
-- lead  = onsite_conversion.messaging_conversation_started (Click-to-WhatsApp)
-- cpl   = spend / leads  (agorot; NULL when leads = 0)
-- impressions / link_clicks are kept to *explain* a recommendation later but
-- are internal-only and never surfaced to the customer (PRD §14).

CREATE TABLE insight_snapshots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  campaign_id     UUID NOT NULL REFERENCES managed_campaigns(id) ON DELETE CASCADE,
  grain           TEXT NOT NULL CHECK (grain IN ('campaign','adset','ad','creative')),
  meta_object_id  TEXT NOT NULL,          -- the Meta id at this grain
  parent_meta_id  TEXT,                   -- e.g. an ad's ad-set, for rollups
  creative_name   TEXT,                   -- label for the per-creative table
  period_start    DATE NOT NULL,
  period_end      DATE NOT NULL,
  spend_agorot    INTEGER NOT NULL DEFAULT 0,
  leads           INTEGER NOT NULL DEFAULT 0,
  cpl_agorot      INTEGER,                -- NULL when leads = 0
  impressions     BIGINT NOT NULL DEFAULT 0,   -- internal only
  link_clicks     BIGINT NOT NULL DEFAULT 0,   -- internal only
  delivery_status TEXT NOT NULL DEFAULT '',
  raw             JSONB NOT NULL DEFAULT '{}'::jsonb,  -- supporting numbers
  -- Idempotency: a re-run for the same object+window updates in place instead
  -- of duplicating (AIC-6 upserts on this key).
  UNIQUE (campaign_id, grain, meta_object_id, period_start, period_end)
);

CREATE INDEX insight_snapshots_lookup_idx
  ON insight_snapshots (campaign_id, grain, period_end DESC);
