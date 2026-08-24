-- Customer-side "delete" for an ad: hidden HERE, untouched on Meta.
--
-- WHY NOT META'S ARCHIVE. Meta's own guide: "An ARCHIVED object has only two
-- fields you can change: name and status. You can also only change status to
-- DELETED." Archiving is a ONE-WAY DOOR — there is no un-archive, at Meta or
-- through any API. A customer-facing remove built on it could never offer the
-- restore this feature exists to provide, and would hand a non-expert an
-- irreversible write to their own ad account. So the customer's remove is ours
-- alone: the ad stays PAUSED on Meta, fully recoverable, and Meta's real
-- ARCHIVED/DELETED stay operator-only (routes/admin.ts).
--
-- WHY ITS OWN TABLE RATHER THAN A COLUMN ON ad_meta. ad_meta is a CACHE of
-- Meta's truth, and upsertAdMeta PRUNES every row Meta stops reporting. User
-- intent must not live in something that is rebuilt from an external source —
-- a cache refresh would silently un-hide the ad. This table records a decision
-- a person made, so it outlives any cache cycle.
--
-- KEYED (campaign_id, meta_ad_id), NOT on the ad id alone. A Meta ad id is
-- globally unique in practice, so a bare primary key looks equivalent — but
-- every read and write here is scoped by campaign (ownership is checked against
-- the caller's own campaign before anything is written), and a key narrower
-- than that scope silently disagrees with it: one campaign's row would block an
-- insert for another campaign, and ON CONFLICT DO NOTHING would report that
-- collision as "already hidden" rather than as the anomaly it is. Caught by the
-- integration tests, which reuse ad ids across campaigns.
CREATE TABLE IF NOT EXISTS hidden_ads (
  meta_ad_id  TEXT NOT NULL,
  campaign_id UUID NOT NULL REFERENCES managed_campaigns(id) ON DELETE CASCADE,
  hidden_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 'customer' or the operator's label, so the removed-ads screen and the
  -- action history can honestly say who did it.
  hidden_by   TEXT NOT NULL,
  PRIMARY KEY (campaign_id, meta_ad_id)
);

CREATE INDEX IF NOT EXISTS hidden_ads_campaign_idx ON hidden_ads (campaign_id);

-- The SAME question from the other direction: an ad an operator archived or
-- deleted at Meta should also leave the customer's default view.
--
-- It didn't, and couldn't. The per-ad rows in `הצג פירוט` are built from stored
-- insight_snapshots with no join against Meta's current object list, so an ad
-- with historical spend keeps its row forever. Worse, upsertAdMeta HARD-DELETED
-- the cache row the moment Meta stopped reporting the ad, which threw away the
-- only evidence that it was gone — the row then fell back to the stale status
-- inside the snapshot and rendered as if it were still fine.
--
-- A tombstone instead of a hard prune. AIC-65's rule (a dead ad must not stay
-- visible) is preserved by FILTERING on gone_at rather than by deleting; and
-- because an ad that reappears in a later Meta response simply clears gone_at,
-- a transient API blip or a pagination edge now self-heals instead of
-- permanently discarding the row, which the hard DELETE could not do.
ALTER TABLE ad_meta ADD COLUMN IF NOT EXISTS gone_at TIMESTAMPTZ;
