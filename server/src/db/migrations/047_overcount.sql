-- AIC-92: cache whether a campaign's leads look INFLATED.
--
-- Every other measurement check assumes under-counting: we see fewer leads than
-- happened, the engine gets cautious, damage bounded. Over-counting compounds
-- instead — inflated leads → CPL looks excellent → the engine recommends MORE
-- budget → more money against conversions that never happened → CPL still looks
-- excellent. The product would be confidently, expensively wrong while the
-- customer's phone stays silent.
--
-- Note this one does NOT get a no_rec_reason. Unlike tracking/CTA/account/
-- lead-event, a suspected over-count does not suppress every recommendation —
-- only budget INCREASES (see increaseBudget in rules.ts). A decrease on suspect
-- numbers is still safe, so blanket suppression would remove correct, protective
-- actions. Fail toward not spending, not toward doing nothing.
ALTER TABLE managed_campaigns
  ADD COLUMN overcount_suspected BOOLEAN DEFAULT false,
  ADD COLUMN overcount_reason TEXT,
  ADD COLUMN overcount_detail JSONB,
  ADD COLUMN overcount_checked_at TIMESTAMPTZ;

ALTER TABLE ops_queue_items DROP CONSTRAINT ops_queue_items_type_check;
ALTER TABLE ops_queue_items ADD CONSTRAINT ops_queue_items_type_check CHECK (type IN (
  'meta_connection_failure','campaign_not_delivering','campaign_rejected',
  'unusual_performance','recommendation_review','support_request',
  'missing_creative','account_restriction','campaign_tracking_broken',
  'campaign_cta_broken','ad_account_cannot_spend','lead_event_stopped',
  'leads_possibly_overcounted'));
