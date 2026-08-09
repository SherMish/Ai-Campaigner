-- Recommendations oversight (AIC-46): let an operator flag a recommendation
-- for human review — orthogonal to the approve/dismiss/execute state machine
-- (AIC-8), which stays untouched. A flagged rec still runs its normal
-- lifecycle; the flag is a marker for the operator's own attention, not a gate.

ALTER TABLE recommendations
  ADD COLUMN flagged_for_review BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN flag_note          TEXT,
  ADD COLUMN flagged_by         UUID REFERENCES app_users(id) ON DELETE SET NULL,
  ADD COLUMN flagged_at         TIMESTAMPTZ;

CREATE INDEX recommendations_flagged_idx ON recommendations (flagged_for_review) WHERE flagged_for_review;
