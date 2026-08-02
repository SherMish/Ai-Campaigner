-- P0 entities (6/6): lead_quality_feedback + ops_queue_items.
-- lead_quality_feedback is the weekly, campaign-level signal (PRD §20) — no
-- individual-lead tracking. ops_queue_items is the operator's needs-attention
-- worklist (PRD §23) that makes one operator able to supervise many accounts.

CREATE TABLE lead_quality_feedback (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  campaign_id    UUID NOT NULL REFERENCES managed_campaigns(id) ON DELETE CASCADE,
  week_start     DATE NOT NULL,
  leads_reported INTEGER NOT NULL DEFAULT 0,   -- "היו לך 12 פניות השבוע"
  relevant_count INTEGER NOT NULL DEFAULT 0,   -- how many were relevant
  customers_won  INTEGER,                        -- optional (PRD §20)
  UNIQUE (campaign_id, week_start)
);

CREATE TABLE ops_queue_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  customer_id   UUID REFERENCES customers(id) ON DELETE CASCADE,
  campaign_id   UUID REFERENCES managed_campaigns(id) ON DELETE CASCADE,
  type          TEXT NOT NULL CHECK (type IN (
    'meta_connection_failure','campaign_not_delivering','campaign_rejected',
    'unusual_performance','recommendation_review','support_request',
    'missing_creative','account_restriction')),
  severity      TEXT NOT NULL DEFAULT 'medium'
    CHECK (severity IN ('low','medium','high')),
  status        TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','in_progress','resolved')),
  detail        TEXT NOT NULL DEFAULT '',
  linked_entity TEXT   -- optional free-form reference
);

CREATE TRIGGER ops_queue_items_set_updated_at
  BEFORE UPDATE ON ops_queue_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX ops_queue_open_idx
  ON ops_queue_items (status, severity) WHERE status <> 'resolved';
