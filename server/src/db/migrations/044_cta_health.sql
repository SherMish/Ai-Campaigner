-- AIC-128: cache whether every ad's CREATIVE actually carries the destination
-- its AD SET promises.
--
-- The failure, found live: a Click-to-WhatsApp campaign whose ad sets were
-- correctly destination_type=WHATSAPP, whose creatives reported
-- call_to_action_type=WHATSAPP_MESSAGE — and whose call_to_action was
-- {type} with NO value, so no phone number. Meta DERIVES that type from the ad
-- set, so every surface said the ad was fine; with no number there is nothing
-- for a tap to open and Meta renders a dead generic button. Delivery-health
-- said delivering, tracking-health said the lead definition matched, Insights
-- showed real spend. Every signal green, every click wasted. The customer
-- found it before we did.
--
-- Mirrors the tracking-health quartet (migration 038) exactly: same
-- ok/reason/detail/checked_at shape, same per-tick cache, same ops escalation.
--
-- `cta_ok` defaults TRUE so existing campaigns start unflagged and only a
-- positively-detected break flips it. NULLABLE, like tracking_ok: the
-- summariser is four-valued (ok/broken/unknown/not_applicable) and "we could
-- not determine this" must be storable rather than collapsing into "fine".
-- `cta_checked_at` advances on every check including inconclusive ones, so
-- staleness is visible separately from the verdict.
ALTER TABLE managed_campaigns
  ADD COLUMN cta_ok BOOLEAN DEFAULT true,
  ADD COLUMN cta_reason TEXT,
  ADD COLUMN cta_detail JSONB,
  ADD COLUMN cta_checked_at TIMESTAMPTZ;

-- New ops-queue type. BOTH this CHECK and OPS_QUEUE_TYPE in
-- shared/src/domain.ts enumerate the allowed set — missing either throws at
-- runtime inside a swallowing try/catch, which is exactly how a silent failure
-- ships (migration 042 is the record of that happening).
ALTER TABLE ops_queue_items DROP CONSTRAINT ops_queue_items_type_check;
ALTER TABLE ops_queue_items ADD CONSTRAINT ops_queue_items_type_check CHECK (type IN (
  'meta_connection_failure','campaign_not_delivering','campaign_rejected',
  'unusual_performance','recommendation_review','support_request',
  'missing_creative','account_restriction','campaign_tracking_broken',
  'campaign_cta_broken'));

-- ...and the no_rec_reason CHECK, widened in the SAME migration as the reason
-- it enables. Migration 042 exists because tracking_broken was wired through
-- the code without this, so the cache write raised a constraint violation on
-- every tick, was swallowed by the try/catch, and the dashboard could never
-- say why. Not repeating it.
ALTER TABLE managed_campaigns DROP CONSTRAINT IF EXISTS managed_campaigns_no_rec_reason_check;
ALTER TABLE managed_campaigns ADD CONSTRAINT managed_campaigns_no_rec_reason_check
  CHECK (no_rec_reason IN (
    'stable',
    'collecting',
    'budget_below_threshold',
    'delivery_blocked',
    'no_comparable_audiences',
    'no_comparable_creatives',
    'below_object_evidence_floor',
    'cooling_down',
    'tracking_broken',
    'cta_broken'
  ));
