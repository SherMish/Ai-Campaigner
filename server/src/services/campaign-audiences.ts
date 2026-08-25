import type pg from "pg";
import { PgSnapshotStore } from "../meta/snapshot-store.js";
import { listAdSetMeta } from "./audience-meta-cache.js";
import { deriveAudienceLabels, type AdSetMeta } from "../meta/audience-label.js";
import { resolveRangeWindow, type RangeKey } from "./readout.js";
import { resolveCampaignId } from "./customer-recommendations.js";
import { listAdMeta } from "./ad-meta-cache.js";
import { classifyAdState, type AdState } from "../meta/ad-state.js";
import { listHiddenAdIds } from "../controls/hidden-ads.js";

// The opt-in "details" view (AIC-37): per-audience (ad set) breakdown, each with
// its own per-creative rows. Progressive disclosure — the customer's default Home
// stays the four-number roll-up; this is the door they open on request. Business-
// framed labels only (the human audience dimension, never "ad set N"); raw
// ad-jargon metrics (CPM/CTR/etc.) stay out, same boundary as the rest of the
// customer surface.
//
// AIC-95: this used to always read the engine's own fixed 7-complete-day
// window (`rollingPeriods().current`), completely ignoring the day/week/
// month/all-time switcher at the top of Home — its own disclaimer said so.
// It now takes the customer's selected `range` and resolves the SAME window
// the KPI cards use (`resolveRangeWindow`, shared with readout.ts so the two
// can't drift), reading the disjoint-daily range-stat methods instead of the
// single current-rolling-window row.

export interface AudienceCreativeRow {
  metaObjectId: string;
  creativeName: string | null;
  spendAgorot: number;
  leads: number;
  cplAgorot: number | null;
  deliveryStatus: string;
  // Found live 2026-08-22: this list is built from insight_snapshots, i.e.
  // ads that have MEASURED DATA. A customer added an ad, saw a success
  // confirmation, and the list still showed only the old ads — the new one
  // had no impressions yet, so no row existed. `PENDING_REVIEW`, the state
  // every new ad passes through, appeared nowhere in the codebase.
  //
  // `adState` is Meta's effective_status classified (see meta/ad-state.ts).
  // `hasData` distinguishes "no results yet" from "zero results" — a
  // brand-new ad showing ₪0 / 0 leads is not the same claim as an ad that ran
  // and produced nothing, and conflating them would be the product lying
  // about a number.
  adState: AdState;
  hasData: boolean;
  // AIC-128: why this ad is not in the default list. Null for a normal row.
  removed: RemovedReason | null;
}

// Two ways an ad leaves the customer's default view, kept apart because only
// one of them can be undone.
//
//   by_customer  — removed from view HERE, on request. Meta never saw it, the
//                  ad is still sitting there PAUSED, so restore is a DB delete
//                  and always works.
//   gone_at_meta — an operator archived or deleted it at Meta, so Meta stopped
//                  listing it. There is NO restore: Meta has no un-archive, and
//                  an archived object can only ever move to deleted. Offering a
//                  restore button here would be a button that cannot work.
//
// Deliberately not split into archived-vs-deleted: once Meta stops listing an
// object we cannot tell which it was, and inventing the distinction would be
// guessing at a fact we don't have.
export type RemovedReason = "by_customer" | "gone_at_meta";

export interface AudienceRow {
  adSetId: string;
  label: string; // human dimension, or the ad-set name if nothing else distinguishes it
  spendAgorot: number;
  leads: number;
  cplAgorot: number | null;
  creatives: AudienceCreativeRow[];
  // Real live bug: the campaign card said "2 active ads", but this ad set's
  // own breakdown showed only 1 — the other had real historical data (Meta
  // still marked it ACTIVE) but nothing in the SELECTED window, so it just
  // silently disappeared, reading as "an ad vanished". This counts creatives
  // with a row somewhere in this ad set's history that aren't in `creatives`
  // above — a DB-only fact (never a liveness claim; that would need a live
  // Meta call, which this view deliberately never makes) — so the UI can say
  // "N more with data from another period" instead of nothing.
  moreCreativesCount: number;
  // AIC-128. A removed ad — whether the customer hid it here or an operator
  // archived/deleted it at Meta — keeps every insight row it ever produced, so
  // its spend and leads are still inside this ad set's spendAgorot/leads above.
  // That means the visible creative rows no longer sum to this row's own total,
  // and an unexplained gap in the arithmetic is exactly the kind of thing that
  // makes a customer stop trusting the numbers.
  //
  // So the gap is reported rather than swallowed, in the SELECTED window (the
  // same window the totals above use) so the two actually reconcile. Same
  // treatment moreCreativesCount already gets, for the same reason: a row that
  // silently disappears reads as money going missing.
  removedCreativesCount: number;
  removedSpendAgorot: number;
  removedLeads: number;
  // The removed rows themselves, so the panel can reveal them behind a toggle
  // rather than making the customer go somewhere else to find them. Same shape
  // as `creatives`; each carries its own `removed` reason, which is what
  // decides whether a restore button is offered.
  removedCreatives: AudienceCreativeRow[];
}

// Why the panel has nothing to show for the selected window — never a bare
// empty array with no explanation (the house rule this ticket is the origin
// of: any surface that can be empty must render a reason).
//   started_today          — no per-object data before today, but today has
//                             some (a campaign that just started/resumed
//                             delivering); the selected window just doesn't
//                             reach far enough into today to show it yet.
//   no_data_in_range       — the campaign HAS real per-object data, just not
//                             within the selected window (e.g. paused for
//                             weeks, "week" happens to land in the gap).
//   no_data_yet            — never had any real per-object data at all.
export type AudienceEmptyReason = "started_today" | "no_data_in_range" | "no_data_yet";

export interface CampaignAudiences {
  campaignId: string;
  range: RangeKey;
  audiences: AudienceRow[];
  empty?: { reason: AudienceEmptyReason; mostRecentDataDate: string | null };
}

// Ownership-scoped: resolves the caller's own campaign, never another
// customer's. Reads only from our DB (snapshots + the cached ad_set_meta) — no
// live Meta call at render time, same discipline as the rest of the readout.
export async function buildCampaignAudiences(
  pool: pg.Pool,
  userId: string,
  range: RangeKey = "week",
  ref: Date = new Date(),
): Promise<CampaignAudiences | null> {
  const campaignId = await resolveCampaignId(pool, userId);
  if (!campaignId) return null;

  const window = resolveRangeWindow(range, ref);
  const allTimeWindow = resolveRangeWindow("allTime", ref);
  const store = new PgSnapshotStore(pool);
  const [adsetStats, creativeStats, allTimeCreativeStats, meta, adMeta, allTimeAdsetStats, hiddenAdIds] = await Promise.all([
    store.adsetRangeStats(campaignId, window.start, window.end),
    store.creativeRangeStats(campaignId, window.start, window.end),
    // Only for moreCreativesCount below — real bug, found live: the campaign
    // card said "2 active ads" but the breakdown showed only 1, because the
    // second had real historical rows outside the selected window and just
    // silently disappeared. Skipped when range is already "allTime" (same
    // query twice) — every creative in range then IS the all-time set.
    range === "allTime"
      ? Promise.resolve<Awaited<ReturnType<typeof store.creativeRangeStats>>>([])
      : store.creativeRangeStats(campaignId, allTimeWindow.start, allTimeWindow.end),
    listAdSetMeta(pool, campaignId),
    listAdMeta(pool, campaignId),
    // AIC-116: ad-set grain, all time — "has this ad set EVER recorded data?".
    // Deliberately not derived from the all-time CREATIVE stats above: an ad
    // set can have adset-grain history with no creative rows at all, and
    // treating that as "never had data" would resurrect a long-dead ad set as
    // a zero row every time the customer picked a narrow range.
    range === "allTime"
      ? Promise.resolve<Awaited<ReturnType<typeof store.adsetRangeStats>>>([])
      : store.adsetRangeStats(campaignId, allTimeWindow.start, allTimeWindow.end),
    // AIC-128: ads the customer removed from their own view. Applied purely as
    // a presentation filter below — never to the stats themselves, which is
    // what keeps every total on this page (and everywhere else) unchanged.
    listHiddenAdIds(pool, campaignId),
  ]);

  const metaById = new Map(meta.map((m) => [m.adSetId, m]));
  const statsByAdSet = new Map(adsetStats.map((a) => [a.adSetId, a]));
  // AIC-65: the cache (upsertAdSetMeta) only ever stores MANAGED ad sets now
  // — a deleted/archived/never-published one has no meta row here even if
  // its historical spend still shows up in adsetStats (Insights, unfiltered).
  // Drop those rather than render them with blank labels. Iterating the cache
  // rather than filtering the stats enforces that by construction.
  //
  // AIC-116: which of those ad sets to show. It used to be "the ones with
  // stats in the window", which silently made this a list of ad sets that have
  // PERFORMANCE rather than ad sets that EXIST. A campaign built minutes ago
  // has neither insight rows nor, therefore, a single row to show — the
  // customer watched their campaign go live and then read "מודעות —".
  //
  // Two cases, kept apart on purpose:
  //   - stats in the window        → show it, with its numbers (unchanged)
  //   - no data ANYWHERE, ever     → show it at zero; it is new, not dead
  // An ad set with data outside the window is deliberately still excluded, so
  // picking a narrow range keeps saying "no data in this range" instead of
  // rendering last quarter's ad sets as a wall of zeroes.
  const adSetsWithAnyData = new Set(
    (range === "allTime" ? adsetStats : allTimeAdsetStats).map((a) => a.adSetId),
  );
  const spine = meta.filter(
    (m) => statsByAdSet.has(m.adSetId) || !adSetsWithAnyData.has(m.adSetId),
  );
  const spineIds = new Set(spine.map((m) => m.adSetId));
  const asMetaList: AdSetMeta[] = spine.map((m) => {
    return {
      adSetId: m.adSetId,
      name: m.name ?? "",
      ageMin: m.ageMin ?? null,
      ageMax: m.ageMax ?? null,
      genders: m.genders ?? "all",
      geoSummary: m.geoSummary ?? "",
      isDynamicCreative: m.isDynamicCreative ?? false,
      // Not tracked by the cache (audience_meta_cache) and unused by
      // deriveAudienceLabels — this view never surfaces an ad set's status.
      status: "active",
      isManaged: true, // filtered above — only managed ad sets reach here
      existsOnMeta: true,
    };
  });
  const labels = deriveAudienceLabels(asMetaList);

  // Meta's own effective_status per ad, from the cache — the only place a
  // PENDING_REVIEW or DISAPPROVED ad exists at all, since neither ever
  // produces an insight row.
  const adStateById = new Map(adMeta.map((a) => [a.adId, a.effectiveStatus]));

  const creativesByAdSet = new Map<string, AudienceCreativeRow[]>();
  const creativeIdsInWindowByAdSet = new Map<string, Set<string>>();
  // What the hidden rows were worth, per ad set, in the selected window — so
  // the panel can account for the difference between an ad set's total and the
  // rows shown under it.
  const removedAgg = new Map<string, { count: number; spendAgorot: number; leads: number }>();
  const removedByAdSet = new Map<string, AudienceCreativeRow[]>();
  // An ad Meta no longer lists — archived or deleted by an operator. The
  // tombstone (ad_meta.gone_at) is the only evidence: the snapshot rows that
  // build this list outlive the Meta object and carry a frozen status, so
  // without it a deleted ad renders as a live one forever.
  const goneAdIds = new Set(adMeta.filter((a) => a.goneAt !== null).map((a) => a.adId));

  // gone_at_meta WINS when both apply, and the order matters. If the customer
  // removed it here and an operator later archived it at Meta, the object no
  // longer exists — offering "restore" would put a row back for something that
  // cannot be shown, run, or resumed. The reason that decides what the customer
  // can DO takes precedence over the reason that merely explains how it left.
  const removalReason = (adId: string): RemovedReason | null =>
    goneAdIds.has(adId) ? "gone_at_meta" : hiddenAdIds.has(adId) ? "by_customer" : null;

  for (const c of creativeStats) {
    const key = c.adSetId ?? "";
    const removed = removalReason(c.metaObjectId);
    if (removed) {
      const agg = removedAgg.get(key) ?? { count: 0, spendAgorot: 0, leads: 0 };
      agg.count++;
      agg.spendAgorot += c.spendAgorot;
      agg.leads += c.leads;
      removedAgg.set(key, agg);
      const list = removedByAdSet.get(key) ?? [];
      list.push({
        metaObjectId: c.metaObjectId,
        creativeName: c.creativeName,
        spendAgorot: c.spendAgorot,
        leads: c.leads,
        cplAgorot: c.cplAgorot,
        deliveryStatus: c.deliveryStatus,
        adState: classifyAdState(adStateById.get(c.metaObjectId) ?? c.deliveryStatus),
        hasData: true,
        removed,
      });
      removedByAdSet.set(key, list);
      // Registered as "seen in this window" so the merge loop below cannot add
      // it a second time as a no-data row.
      const seen = creativeIdsInWindowByAdSet.get(key) ?? new Set<string>();
      seen.add(c.metaObjectId);
      creativeIdsInWindowByAdSet.set(key, seen);
      continue;
    }
    const list = creativesByAdSet.get(key) ?? [];
    list.push({
      metaObjectId: c.metaObjectId,
      creativeName: c.creativeName,
      spendAgorot: c.spendAgorot,
      leads: c.leads,
      cplAgorot: c.cplAgorot,
      deliveryStatus: c.deliveryStatus,
      // Prefer the cached live status over the snapshot's, which is only as
      // fresh as the last ingestion tick.
      adState: classifyAdState(adStateById.get(c.metaObjectId) ?? c.deliveryStatus),
      hasData: true,
      removed: null,
    });
    creativesByAdSet.set(key, list);
    const ids = creativeIdsInWindowByAdSet.get(key) ?? new Set<string>();
    ids.add(c.metaObjectId);
    creativeIdsInWindowByAdSet.set(key, ids);
  }

  const allTimeIdsByAdSet = new Map<string, Set<string>>();
  for (const c of allTimeCreativeStats) {
    const key = c.adSetId ?? "";
    const ids = allTimeIdsByAdSet.get(key) ?? new Set<string>();
    ids.add(c.metaObjectId);
    allTimeIdsByAdSet.set(key, ids);
  }

  // THE FIX (2026-08-22). Merge in ads that EXIST on Meta but have no insight
  // row yet — a just-created ad in review, or one Meta rejected (which will
  // never gain data, so waiting would not help). Without this the customer
  // gets a success message and then a list without their ad.
  //
  // Scoped by DATA, not by status (AIC-116 — see the gate below): an ad with no
  // rows in any period, whatever Meta says its status is. An ad with rows in
  // another period is already covered by moreCreativesCount below ("N more with
  // data from another period"), so the two cannot overlap.
  for (const a of adMeta) {
    const state = classifyAdState(a.effectiveStatus);
    if (!spineIds.has(a.adSetId)) continue; // its ad set isn't being shown
    // AIC-128: an ad removed BEFORE it ever recorded data would otherwise be
    // merged straight back into the visible list by this loop. It contributes
    // nothing to removedAgg — with no spend or leads there is no gap in the
    // arithmetic to explain, and counting it would imply money that never
    // existed — but it still belongs in the removed list so the customer can
    // find and restore it.
    const removedNoData = removalReason(a.adId);
    if (removedNoData) {
      const inWin = creativeIdsInWindowByAdSet.get(a.adSetId) ?? new Set<string>();
      if (inWin.has(a.adId)) continue; // already captured from real data above
      const everHad = allTimeIdsByAdSet.get(a.adSetId) ?? inWin;
      if (everHad.has(a.adId)) continue;
      const list = removedByAdSet.get(a.adSetId) ?? [];
      list.push({
        metaObjectId: a.adId, creativeName: a.name, spendAgorot: 0, leads: 0, cplAgorot: null,
        deliveryStatus: a.effectiveStatus, adState: state, hasData: false, removed: removedNoData,
      });
      removedByAdSet.set(a.adSetId, list);
      continue;
    }
    const inWindow = creativeIdsInWindowByAdSet.get(a.adSetId) ?? new Set<string>();
    if (inWindow.has(a.adId)) continue; // already listed from real data
    // AIC-116: the gate here was `hasNoDataYet(state)`, i.e. merge only an ad
    // whose STATUS explains the missing data (in review, rejected). That left
    // out the commonest case of all — an ACTIVE ad created minutes ago, which
    // Meta simply has not reported on yet. The honest test is not the status
    // but the data: an ad with no rows in ANY period has never been measured,
    // so nothing else in this view will ever mention it. An ad with rows in
    // another period is a different case and stays with moreCreativesCount
    // below, which is why this cannot double-count.
    const everHadData = allTimeIdsByAdSet.get(a.adSetId) ?? inWindow;
    if (everHadData.has(a.adId)) continue;
    const list = creativesByAdSet.get(a.adSetId) ?? [];
    list.push({
      metaObjectId: a.adId,
      creativeName: a.name,
      // Zeroes here are NOT a claim of zero results — hasData:false is what
      // tells the UI to render "no results yet" instead of "₪0, 0 leads".
      spendAgorot: 0,
      leads: 0,
      cplAgorot: null,
      deliveryStatus: a.effectiveStatus,
      adState: state,
      hasData: false,
      removed: null,
    });
    creativesByAdSet.set(a.adSetId, list);
    inWindow.add(a.adId);
    creativeIdsInWindowByAdSet.set(a.adSetId, inWindow);
  }

  // moreCreativesCount: creatives with a row SOMEWHERE in this ad set's
  // history that aren't in the selected window — see AudienceRow's own
  // comment for why. range === "allTime" skips the extra query above (the
  // window's own set already IS the all-time set), so nothing is ever
  // "missing" from it.
  const audiences: AudienceRow[] = spine.map((m) => {
    const inWindow = creativeIdsInWindowByAdSet.get(m.adSetId) ?? new Set<string>();
    const allTime = allTimeIdsByAdSet.get(m.adSetId) ?? inWindow;
    let moreCreativesCount = 0;
    // Removed ads are excluded here as well: counting one as "N more with data
    // from another period" would advertise the very row that was removed, and
    // would double-report it alongside the removed note.
    for (const id of allTime) if (!inWindow.has(id) && !removalReason(id)) moreCreativesCount++;
    // Absent stats mean no data, not zero results — the ad rows carry
    // hasData:false so the UI can say so rather than printing "₪0 · 0 לידים".
    const a = statsByAdSet.get(m.adSetId);
    return {
      adSetId: m.adSetId,
      label: labels.get(m.adSetId) ?? m.name ?? m.adSetId,
      spendAgorot: a?.spendAgorot ?? 0,
      leads: a?.leads ?? 0,
      cplAgorot: a?.cplAgorot ?? null,
      creatives: (creativesByAdSet.get(m.adSetId) ?? []).sort((x, y) => y.spendAgorot - x.spendAgorot),
      moreCreativesCount,
      removedCreativesCount: (removedByAdSet.get(m.adSetId) ?? []).length,
      removedSpendAgorot: removedAgg.get(m.adSetId)?.spendAgorot ?? 0,
      removedLeads: removedAgg.get(m.adSetId)?.leads ?? 0,
      removedCreatives: (removedByAdSet.get(m.adSetId) ?? []).sort((x, y) => y.spendAgorot - x.spendAgorot),
    };
  });
  audiences.sort((a, b) => b.spendAgorot - a.spendAgorot);

  if (audiences.length > 0) return { campaignId, range, audiences };

  const mostRecentDataDate = await store.mostRecentObjectDataDate(campaignId);
  const today = ref.toISOString().slice(0, 10);
  const reason: AudienceEmptyReason =
    mostRecentDataDate === null ? "no_data_yet" : mostRecentDataDate === today ? "started_today" : "no_data_in_range";
  return { campaignId, range, audiences, empty: { reason, mostRecentDataDate } };
}
