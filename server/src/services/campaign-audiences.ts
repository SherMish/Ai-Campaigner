import type pg from "pg";
import { PgSnapshotStore } from "../meta/snapshot-store.js";
import { listAdSetMeta } from "./audience-meta-cache.js";
import { deriveAudienceLabels, type AdSetMeta } from "../meta/audience-label.js";
import { resolveRangeWindow, type RangeKey } from "./readout.js";
import { resolveCampaignId } from "./customer-recommendations.js";
import { listAdMeta } from "./ad-meta-cache.js";
import { classifyAdState, hasNoDataYet, type AdState } from "../meta/ad-state.js";

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
}

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
  const [adsetStats, creativeStats, allTimeCreativeStats, meta, adMeta] = await Promise.all([
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
  ]);

  const metaById = new Map(meta.map((m) => [m.adSetId, m]));
  // AIC-65: the cache (upsertAdSetMeta) only ever stores MANAGED ad sets now
  // — a deleted/archived/never-published one has no meta row here even if
  // its historical spend still shows up in adsetStats (Insights, unfiltered).
  // Drop those rather than render them with blank labels.
  const managedAdsetStats = adsetStats.filter((a) => metaById.has(a.adSetId));
  const asMetaList: AdSetMeta[] = managedAdsetStats.map((a) => {
    const m = metaById.get(a.adSetId)!;
    return {
      adSetId: a.adSetId,
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
    };
  });
  const labels = deriveAudienceLabels(asMetaList);

  // Meta's own effective_status per ad, from the cache — the only place a
  // PENDING_REVIEW or DISAPPROVED ad exists at all, since neither ever
  // produces an insight row.
  const adStateById = new Map(adMeta.map((a) => [a.adId, a.effectiveStatus]));

  const creativesByAdSet = new Map<string, AudienceCreativeRow[]>();
  const creativeIdsInWindowByAdSet = new Map<string, Set<string>>();
  for (const c of creativeStats) {
    const key = c.adSetId ?? "";
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
    });
    creativesByAdSet.set(key, list);
    const ids = creativeIdsInWindowByAdSet.get(key) ?? new Set<string>();
    ids.add(c.metaObjectId);
    creativeIdsInWindowByAdSet.set(key, ids);
  }

  // THE FIX (2026-08-22). Merge in ads that EXIST on Meta but have no insight
  // row yet — a just-created ad in review, or one Meta rejected (which will
  // never gain data, so waiting would not help). Without this the customer
  // gets a success message and then a list without their ad.
  //
  // Deliberately narrow: only states that EXPLAIN the missing data are merged
  // (see hasNoDataYet). An ACTIVE ad with no rows in the selected window is a
  // different, already-handled case — moreCreativesCount below says "N more
  // with data from another period" for exactly that, and duplicating it here
  // would double-count.
  for (const a of adMeta) {
    const state = classifyAdState(a.effectiveStatus);
    if (!hasNoDataYet(state)) continue;
    const inWindow = creativeIdsInWindowByAdSet.get(a.adSetId) ?? new Set<string>();
    if (inWindow.has(a.adId)) continue; // already listed from real data
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
  const allTimeIdsByAdSet = new Map<string, Set<string>>();
  for (const c of allTimeCreativeStats) {
    const key = c.adSetId ?? "";
    const ids = allTimeIdsByAdSet.get(key) ?? new Set<string>();
    ids.add(c.metaObjectId);
    allTimeIdsByAdSet.set(key, ids);
  }

  const audiences: AudienceRow[] = managedAdsetStats.map((a) => {
    const inWindow = creativeIdsInWindowByAdSet.get(a.adSetId) ?? new Set<string>();
    const allTime = allTimeIdsByAdSet.get(a.adSetId) ?? inWindow;
    let moreCreativesCount = 0;
    for (const id of allTime) if (!inWindow.has(id)) moreCreativesCount++;
    return {
      adSetId: a.adSetId,
      label: labels.get(a.adSetId) ?? metaById.get(a.adSetId)?.name ?? a.adSetId,
      spendAgorot: a.spendAgorot,
      leads: a.leads,
      cplAgorot: a.cplAgorot,
      creatives: (creativesByAdSet.get(a.adSetId) ?? []).sort((x, y) => y.spendAgorot - x.spendAgorot),
      moreCreativesCount,
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
