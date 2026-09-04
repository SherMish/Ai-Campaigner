-- AIC-200 — WHICH messaging app a campaign's messages actually open in.
--
-- `destination` answers "how do we WRITE ad sets for this campaign" and is
-- correctly 'whatsapp' for every click-to-message campaign: they all optimize
-- CONVERSATIONS and all report messaging_conversation_started.
--
-- It cannot also answer "what do we TELL the customer". Four of Meta's seven
-- messaging destination types route to more than one app
-- (MESSAGING_INSTAGRAM_DIRECT_MESSENGER_WHATSAPP and friends), and one routes
-- only to Instagram Direct — which never reaches WhatsApp at all. Printing
-- "וואטסאפ" beside a real conversation that arrived in Instagram Direct sends
-- the customer to the wrong inbox to find their own lead.
--
-- A separate column rather than a wider `destination` enum precisely because
-- the two questions have different answers: an INSTAGRAM_DIRECT campaign is
-- still written as a messaging campaign, and still counted as one.
--
-- NULL means "not detected" — every row that predates this, and any campaign
-- that is not a messaging campaign at all. Nullable on purpose: an unknown
-- channel must never render as a confident one.
ALTER TABLE managed_campaigns
  ADD COLUMN IF NOT EXISTS messaging_channel TEXT;

ALTER TABLE managed_campaigns DROP CONSTRAINT IF EXISTS managed_campaigns_messaging_channel_check;
ALTER TABLE managed_campaigns ADD CONSTRAINT managed_campaigns_messaging_channel_check
  CHECK (messaging_channel IS NULL
         OR messaging_channel IN ('whatsapp', 'instagram', 'messenger', 'multi'));
