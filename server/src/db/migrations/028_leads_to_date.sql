-- AIC-67 follow-up (real bug, found live the same day): the lead-quality
-- watermark's "leads to date" was computed as SUM(leads) across ALL
-- insight_snapshots campaign-grain rows for a campaign. Those rows are NOT
-- disjoint — the ingestion tick writes a new OVERLAPPING rolling-7-day
-- window snapshot every day (today-7..today-1, shifting by one day per
-- tick), so the same real leads get re-reported in multiple rows. Summing
-- them multiplies real leads by however many overlapping snapshots exist —
-- confirmed live: 1 real lead read as "3 to review" after 3 daily ticks.
--
-- Fixed the same way delivery_ok/live_budget_agorot/delivering already are:
-- fetch the true figure once per generation tick (a single Meta Insights
-- call with date_preset=maximum — a real non-overlapping lifetime total,
-- verified against the live account) and cache it here. No new per-request
-- Meta call; UI reads only ever read this column.
ALTER TABLE managed_campaigns ADD COLUMN leads_to_date INTEGER;
ALTER TABLE managed_campaigns ADD COLUMN leads_to_date_checked_at TIMESTAMPTZ;
