-- Every ad creative WE create on Meta, so the ones that never became an ad can
-- be found and cleaned up (AIC-131).
--
-- THE LEAK. Building an ad is two Meta calls: POST /adcreatives makes the
-- content, POST /ads attaches it to an ad set. The UI creates the creative as
-- soon as that step is filled in — deliberately, because Meta validates it
-- there and the customer gets real errors before committing — but anything that
-- stops them before submit leaves the creative behind, referenced by nothing.
-- Found live: 21 orphaned creatives on one ad account across four separate
-- days, against ZERO ads. They cost nothing (a creative with no ad cannot
-- deliver, spend, or appear in a report) but nothing ever reaped them.
--
-- WHY A TABLE RATHER THAN ASKING META. An adcreative exposes no created_time,
-- so age is unknowable from the API — and "orphaned" alone is not a licence to
-- delete: a creative made seconds ago by a customer still filling in the form
-- is also unreferenced. Age is the only thing separating "abandoned" from
-- "in progress", and only we can know it.
--
-- It is also the safety boundary. The reaper deletes ONLY ids recorded here,
-- so it can never touch a creative the customer made themselves in Ads
-- Manager — those are theirs, they may be reused deliberately, and deleting
-- one would be destroying a customer's own work.
CREATE TABLE IF NOT EXISTS created_creatives (
  meta_creative_id   TEXT PRIMARY KEY,
  meta_ad_account_id TEXT NOT NULL,
  -- Null for a builder session whose campaign row doesn't exist yet; the
  -- account id is what the reaper actually needs.
  campaign_id        UUID REFERENCES managed_campaigns(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set when an ad is created against it. A row with this set is finished
  -- business and is never a reaping candidate, whatever Meta reports later.
  attached_at        TIMESTAMPTZ,
  -- Set when the reaper deletes it on Meta. Kept rather than deleting the row,
  -- so a creative can never be "rediscovered" and re-deleted, and so there is
  -- an audit trail of what was removed.
  reaped_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS created_creatives_reapable_idx
  ON created_creatives (meta_ad_account_id, created_at)
  WHERE attached_at IS NULL AND reaped_at IS NULL;
