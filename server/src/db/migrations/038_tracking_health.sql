-- AIC-88: cache whether a campaign's DECLARED lead definition
-- (managed_campaigns.lead_event_types, AIC-87) actually matches what its ad
-- sets are configured on Meta to optimize for. A mismatch means every real
-- conversion counts as zero — a working campaign rendered as a failing one,
-- and an engine confidently reasoning over a number that is structurally wrong.
--
-- Mirrors the delivery-health trio (migration 014) deliberately: same
-- ok/reason/checked_at shape, same per-tick cache, same ops-item escalation.
--
-- `tracking_ok` defaults TRUE so every existing campaign starts unflagged and
-- only a real, positively-detected mismatch ever flips it. NULLABLE, unlike
-- delivery_ok — the summariser is genuinely three-valued (ok/broken/unknown)
-- and "we could not determine this" must be storable as its own state rather
-- than silently collapsing into "fine". `tracking_checked_at` advances on
-- every check including unknown ones, so staleness is visible separately from
-- verdict.
ALTER TABLE managed_campaigns
  ADD COLUMN tracking_ok BOOLEAN DEFAULT true,
  ADD COLUMN tracking_reason TEXT,
  ADD COLUMN tracking_detail JSONB,
  ADD COLUMN tracking_checked_at TIMESTAMPTZ;

-- A new ops-queue type. BOTH this CHECK and OPS_QUEUE_TYPE in
-- shared/src/domain.ts enumerate the allowed set — missing either one throws
-- at runtime inside a swallowing try/catch, which is exactly how a silent
-- failure gets shipped. Same drop/re-add pattern as migrations 013/024/032/035.
-- (Note migration 007 declared this constraint inline, so Postgres auto-named
-- it `ops_queue_items_type_check`; confirmed against the live DB.)
ALTER TABLE ops_queue_items DROP CONSTRAINT ops_queue_items_type_check;
ALTER TABLE ops_queue_items ADD CONSTRAINT ops_queue_items_type_check CHECK (type IN (
  'meta_connection_failure','campaign_not_delivering','campaign_rejected',
  'unusual_performance','recommendation_review','support_request',
  'missing_creative','account_restriction','campaign_tracking_broken'));
