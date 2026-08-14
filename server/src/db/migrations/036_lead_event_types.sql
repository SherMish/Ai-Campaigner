-- AIC-87: the lead definition becomes PER-CAMPAIGN instead of a hardcoded
-- constant. Until now `extractLeads` (server/src/meta/insights.ts) only ever
-- counted the Click-to-WhatsApp messaging-conversation event, because every P0
-- campaign was Click-to-WhatsApp. A campaign whose leads are Pixel conversions
-- (objective OUTCOME_LEADS, optimization_goal OFFSITE_CONVERSIONS) reports a
-- completely different action type, so under the old constant it ingested as
-- ZERO leads no matter how well it performed — spend with nothing to show for
-- it, which reads as a catastrophically failing campaign rather than a
-- mis-configured metric. METRICS.md:25 already flagged this as the extension
-- point ("if a campaign's lead mechanism differs … out of scope for P0").
--
-- An ARRAY, not a single TEXT, because the existing behaviour genuinely is a
-- PRIORITY LIST: prefer the 7-day-attribution variant when present, else the
-- base type, and NEVER sum both (summing would double-count the same lead).
-- `extractLeads` already implements exactly that first-match-wins loop; this
-- column just makes the list per-campaign instead of module-level.
--
-- The DEFAULT reproduces today's constant exactly, so every campaign that
-- already exists keeps byte-identical behaviour — the same "the floor keeps
-- existing accounts unchanged" instinct as AIC-77a's budget-relative formula.
ALTER TABLE managed_campaigns
  ADD COLUMN lead_event_types TEXT[] NOT NULL DEFAULT ARRAY[
    'onsite_conversion.messaging_conversation_started_7d',
    'onsite_conversion.messaging_conversation_started'
  ];

-- The Meta Pixel backing a conversion-based campaign's leads. NULL for
-- Click-to-WhatsApp campaigns (no pixel involved). Set together with a
-- pixel-shaped `lead_event_types`; AIC-88's tracking-health guard keys off
-- this column to decide whether a campaign is even checkable.
ALTER TABLE managed_campaigns ADD COLUMN tracking_pixel_id TEXT;
