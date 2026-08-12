-- The customer's "all time" range (the new day/week/month/all-time switcher)
-- needs lifetime SPEND alongside the lifetime leads added in migration 028.
-- Both come from the same single Meta call (date_preset=maximum) each
-- generation tick.
--
-- Why not sum the per-day snapshot rows: those are only ingested for
-- DAILY_LOOKBACK_DAYS (45), so they cannot answer "all time" for an older
-- campaign — and the older rolling-window rows OVERLAP, so summing those
-- double-counts (the real bug that made 1 lead read as 3).
ALTER TABLE managed_campaigns ADD COLUMN spend_to_date INTEGER;
