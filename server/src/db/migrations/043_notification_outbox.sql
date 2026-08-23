-- Ops notification relay (AIC-118): mark which rows have already been sent to
-- the Telegram ops channel.
--
-- WHY A COLUMN AND NOT A TIMESTAMP WATERMARK. The obvious design is one
-- "last_seen_at" row per source, polling for anything newer. It loses events:
-- a row's occurred_at is set when the INSERT runs, but the row only becomes
-- visible when its transaction COMMITS, so a row can appear with a timestamp
-- already behind the watermark and be skipped forever. Marking each row
-- individually has no such window — a late-committing row is simply still
-- unmarked on the next pass.
--
-- Both tables already carry everything an ops message needs (what changed, on
-- which campaign, by whom, and whether it failed), so the relay reads them
-- directly rather than duplicating writes into a queue of its own. That also
-- means every action type — including ones added later, and ones deliberately
-- HIDDEN from the customer's own feed like rollback_build — reaches the
-- channel without anyone remembering to wire it up.
ALTER TABLE action_history  ADD COLUMN notified_at TIMESTAMPTZ;
ALTER TABLE ops_queue_items ADD COLUMN notified_at TIMESTAMPTZ;

-- Partial indexes: the relay only ever asks for the unsent rows, which is a
-- tiny and roughly constant slice. A full index would grow with all of history
-- to answer a query that never looks at it.
CREATE INDEX action_history_unnotified_idx
  ON action_history (occurred_at) WHERE notified_at IS NULL;
CREATE INDEX ops_queue_unnotified_idx
  ON ops_queue_items (created_at) WHERE notified_at IS NULL;

-- Everything that already happened is marked as sent. Without this the first
-- tick after deploy would replay the entire history of both tables into the
-- channel — months of events, at which point nobody reads the channel again.
-- The relay has its own MAX_AGE guard for the same reason, but that guard
-- protects the steady state; this protects the one-time cutover.
UPDATE action_history  SET notified_at = now() WHERE notified_at IS NULL;
UPDATE ops_queue_items SET notified_at = now() WHERE notified_at IS NULL;
