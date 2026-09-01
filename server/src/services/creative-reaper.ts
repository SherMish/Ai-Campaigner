import type pg from "pg";

// AIC-131: delete the ad creatives that never became ads.
//
// Building an ad on Meta is two calls — POST /adcreatives, then POST /ads. The
// UI makes the creative as soon as that step is filled in, on purpose: Meta
// validates it there, so the customer gets real errors before committing.
// Anything that stops them before submit therefore leaves a creative behind,
// referenced by nothing. Found live: 21 orphans on one ad account across four
// days, against zero ads.
//
// THREE CONDITIONS, AND EACH RULES OUT A DIFFERENT WAY OF DELETING SOMETHING
// THAT MATTERS:
//
//   1. we created it   — the row exists in created_creatives. A customer's own
//                        creative, made in Ads Manager, is theirs; it may be
//                        deliberately kept for reuse, and deleting one would
//                        be destroying their work.
//   2. it is old       — an unreferenced creative made moments ago is a
//                        customer mid-form, not litter. Age is the ONLY thing
//                        separating abandoned from in-progress, and Meta
//                        exposes no created_time on an adcreative, so the
//                        answer has to come from our own record.
//   3. no ad uses it   — re-checked against Meta at reap time, never inferred
//                        from our own attached_at. Ads can be created outside
//                        our flow, and an ad attached elsewhere would still
//                        read as unattached to us.
//
// All three, or it stays.

export interface ReaperReader {
  // Every creative id currently referenced by an ad in the account.
  listAdCreativeIdsInUse(adAccountId: string): Promise<string[]>;
}

export interface ReaperWriter {
  deleteCreative(creativeId: string): Promise<void>;
}

export interface ReapCandidate {
  creativeId: string;
  adAccountId: string;
}

export interface ReapResult {
  considered: number;
  deleted: string[];
  // Still referenced despite our record saying otherwise — an ad was created
  // outside our flow. Marked attached rather than deleted, so they stop being
  // reconsidered every tick.
  reattached: string[];
  failed: Array<{ creativeId: string; error: string }>;
}

// Deliberately generous. The cost of waiting is one dormant object; the cost of
// being early is deleting a creative a customer is still working on. A builder
// session lasts minutes, so a day is far past any real one — and the leak this
// fixes accumulated over four days, so nothing here needs to be prompt.
export const MIN_AGE_HOURS = 24;

export async function listReapCandidates(
  pool: pg.Pool,
  minAgeHours: number = MIN_AGE_HOURS,
): Promise<ReapCandidate[]> {
  const { rows } = await pool.query<{ meta_creative_id: string; meta_ad_account_id: string }>(
    // AIC-171 — only ad accounts we still manage.
    //
    // Found in the logs: nine ad-account ids that exist nowhere on Meta
    // (act_add_*, act_route_*, act_admin_builder_* — integration-test fixtures
    // that reached production) were retried on EVERY tick, forever. Nine
    // wasted Meta calls an hour against a real customer's rate limit, and nine
    // error lines burying the real ones.
    //
    // The join is the honest rule, not a filter on the ids' shape: a creative
    // whose ad account we no longer hold a connection to is not ours to reap,
    // whether it came from a stray test or a customer who left.
    `SELECT cc.meta_creative_id, cc.meta_ad_account_id
       FROM created_creatives cc
      WHERE cc.attached_at IS NULL
        AND cc.reaped_at IS NULL
        AND cc.created_at < now() - ($1 || ' hours')::interval
        AND EXISTS (
          SELECT 1 FROM ad_accounts aa WHERE aa.meta_ad_account_id = cc.meta_ad_account_id
        )
      ORDER BY cc.created_at`,
    [String(minAgeHours)],
  );
  return rows.map((r) => ({ creativeId: r.meta_creative_id, adAccountId: r.meta_ad_account_id }));
}

/**
 * Reap one ad account's abandoned creatives.
 *
 * Scoped per account because the in-use check is one Graph read per account —
 * doing it per creative would be N reads for the same answer, and this runs on
 * a schedule against every account we manage.
 */
export async function reapAccount(deps: {
  pool: pg.Pool;
  reader: ReaperReader;
  writer: ReaperWriter;
  adAccountId: string;
  candidates: ReapCandidate[];
  log?: { error: (m: string) => void };
}): Promise<ReapResult> {
  const { pool, reader, writer, adAccountId, candidates, log } = deps;
  const result: ReapResult = { considered: candidates.length, deleted: [], reattached: [], failed: [] };
  if (candidates.length === 0) return result;

  // Condition 3, read fresh. If this read fails we delete NOTHING — without it
  // we cannot tell an orphan from a creative that is live in an ad, and the
  // failure mode of guessing is deleting the content out of a running ad.
  let inUse: Set<string>;
  try {
    inUse = new Set(await reader.listAdCreativeIdsInUse(adAccountId));
  } catch (e) {
    log?.error(`[reaper] ${adAccountId}: in-use read failed, reaping nothing — ${(e as Error).message}`);
    return result;
  }

  for (const c of candidates) {
    if (inUse.has(c.creativeId)) {
      // An ad was created against it outside our flow. Not litter — record
      // that and stop reconsidering it every tick.
      await pool.query(
        `UPDATE created_creatives SET attached_at = now() WHERE meta_creative_id = $1`,
        [c.creativeId],
      );
      result.reattached.push(c.creativeId);
      continue;
    }
    try {
      await writer.deleteCreative(c.creativeId);
      await pool.query(
        `UPDATE created_creatives SET reaped_at = now() WHERE meta_creative_id = $1`,
        [c.creativeId],
      );
      result.deleted.push(c.creativeId);
    } catch (e) {
      // Left unmarked on purpose: a transient Graph failure should be retried
      // next tick. A creative Meta has already removed answers 400 here
      // forever, which is noisy but harmless — and far better than marking a
      // deletion that never happened.
      result.failed.push({ creativeId: c.creativeId, error: (e as Error).message });
      log?.error(`[reaper] ${c.creativeId}: delete failed — ${(e as Error).message}`);
    }
  }
  return result;
}

/** Record a creative we just made, so it can be reaped if it never becomes an ad. */
export async function recordCreatedCreative(
  pool: pg.Pool,
  creativeId: string,
  adAccountId: string,
  campaignId: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO created_creatives (meta_creative_id, meta_ad_account_id, campaign_id)
     VALUES ($1, $2, $3) ON CONFLICT (meta_creative_id) DO NOTHING`,
    [creativeId, adAccountId, campaignId],
  );
}

/** Mark creatives as attached — an ad now exists for them. */
export async function markCreativesAttached(pool: pg.Pool, creativeIds: readonly string[]): Promise<void> {
  if (creativeIds.length === 0) return;
  await pool.query(
    `UPDATE created_creatives SET attached_at = now()
      WHERE meta_creative_id = ANY($1::text[]) AND attached_at IS NULL`,
    [creativeIds],
  );
}

/**
 * The scheduled entry point: reap every account that has candidates.
 *
 * Returns null when there is no Meta token, so the caller can stay quiet rather
 * than logging a tick that could never have done anything.
 */
export async function buildReaperTick(
  pool: pg.Pool,
  makeAdapter: () => (ReaperReader & ReaperWriter) | null,
  log?: { info: (m: string) => void; error: (m: string) => void },
): Promise<(() => Promise<ReapResult>) | null> {
  const probe = makeAdapter();
  if (!probe) return null;
  return async () => {
    const total: ReapResult = { considered: 0, deleted: [], reattached: [], failed: [] };
    const candidates = await listReapCandidates(pool);
    const byAccount = new Map<string, ReapCandidate[]>();
    for (const c of candidates) {
      const list = byAccount.get(c.adAccountId) ?? [];
      list.push(c);
      byAccount.set(c.adAccountId, list);
    }
    for (const [adAccountId, list] of byAccount) {
      const adapter = makeAdapter();
      if (!adapter) continue;
      const r = await reapAccount({ pool, reader: adapter, writer: adapter, adAccountId, candidates: list, log });
      total.considered += r.considered;
      total.deleted.push(...r.deleted);
      total.reattached.push(...r.reattached);
      total.failed.push(...r.failed);
    }
    return total;
  };
}
