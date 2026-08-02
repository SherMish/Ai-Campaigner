-- P0 entities (5/6): recommendations + action_history.
-- recommendations is refined by the engine tickets (P0.2); created here so
-- downstream code builds against a stable table. action_history is the
-- append-only audit log (PRD §23): what / previous / new / why / who / human /
-- when. Never UPDATE action_history — insert a new row.

CREATE TABLE recommendations (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  campaign_id              UUID NOT NULL REFERENCES managed_campaigns(id) ON DELETE CASCADE,
  type                     TEXT NOT NULL CHECK (type IN
    ('pause_creative','increase_budget','decrease_budget','replace_creative','no_action')),
  state                    TEXT NOT NULL DEFAULT 'proposed' CHECK (state IN
    ('proposed','approved','executing','executed','failed','dismissed','expired')),
  target_meta_id           TEXT,     -- the object the action would touch
  evidence                 JSONB NOT NULL DEFAULT '{}'::jsonb,  -- justifying numbers
  current_budget_agorot    INTEGER,
  proposed_budget_agorot   INTEGER,
  max_spend_impact_agorot  INTEGER,  -- "מה תהיה ההשפעה המקסימלית על ההוצאה"
  rationale                TEXT NOT NULL DEFAULT '',   -- internal structured reason
  expires_at               TIMESTAMPTZ,
  approved_by              TEXT,      -- customer id / operator
  approved_at              TIMESTAMPTZ,
  executed_at              TIMESTAMPTZ
);

CREATE TRIGGER recommendations_set_updated_at
  BEFORE UPDATE ON recommendations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX recommendations_campaign_state_idx
  ON recommendations (campaign_id, state);

CREATE TABLE action_history (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  campaign_id       UUID NOT NULL REFERENCES managed_campaigns(id) ON DELETE CASCADE,
  recommendation_id UUID REFERENCES recommendations(id) ON DELETE SET NULL,
  what              TEXT NOT NULL,                        -- the change, described
  action_type       TEXT NOT NULL,                        -- pause_creative / …
  target_meta_id    TEXT,
  previous_state    JSONB NOT NULL DEFAULT '{}'::jsonb,
  new_state         JSONB NOT NULL DEFAULT '{}'::jsonb,
  why               TEXT NOT NULL DEFAULT '',
  approved_by       TEXT,                                 -- who approved
  human_involved    BOOLEAN NOT NULL DEFAULT false,
  result            TEXT NOT NULL DEFAULT 'success'
    CHECK (result IN ('success','failed'))
);

CREATE INDEX action_history_campaign_idx
  ON action_history (campaign_id, occurred_at DESC);
