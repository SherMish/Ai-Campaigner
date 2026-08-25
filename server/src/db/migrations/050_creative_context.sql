-- AIC-134 / first slice of AIC-78: the business facts an AI needs to write copy
-- that is about THIS business rather than generic marketing filler.
--
-- Everything here is captured on the onboarding call, and that timing is the
-- whole point. A founder will tell you "we've been doing this 12 years" and
-- "everyone asks if it's covered by insurance" in the first five minutes, and
-- nowhere in the product was there a place to put either — so it was lost, and
-- copy generated later can only fall back to the obvious.
--
-- Chosen against one test: would a copy generator write MATERIALLY DIFFERENT
-- copy with this field? Anything that failed it was left out — the wizard is
-- used live on a call, and every extra field is friction paid by an operator
-- while a customer waits.
ALTER TABLE customers
  -- "12 years experience", "same-day appointments". The claim the ad makes.
  -- Named by AIC-78 as the canonical example: "You have 12 years of experience
  -- and your ads only mention price" is only possible if someone captured it.
  ADD COLUMN IF NOT EXISTS differentiators TEXT NOT NULL DEFAULT '',
  -- What makes people hesitate. Copy that pre-empts the objection converts;
  -- copy written without knowing it argues with the wrong thing.
  ADD COLUMN IF NOT EXISTS objections TEXT NOT NULL DEFAULT '',
  -- Price/starting point. Two jobs: "from ₪X" is one of the strongest lines an
  -- ad can carry, and it also filters out leads who were never going to buy —
  -- which shows up directly in AIC-67's lead-quality feedback.
  ADD COLUMN IF NOT EXISTS price_range TEXT NOT NULL DEFAULT '',
  -- Claims we must NOT make: regulated wording, guarantees the business can't
  -- honour, competitor comparisons they don't want. This is a SAFETY RAIL, not
  -- flavour — a generator with no constraints will happily invent a guarantee,
  -- and the liability for that lands on the customer (see the responsibility
  -- notice in the creative step).
  ADD COLUMN IF NOT EXISTS copy_constraints TEXT NOT NULL DEFAULT '',
  -- What the customer actually does when a lead arrives ("we call within an
  -- hour"). Sets the promise the ad is allowed to make and shapes the CTA.
  ADD COLUMN IF NOT EXISTS lead_followup TEXT NOT NULL DEFAULT '';
