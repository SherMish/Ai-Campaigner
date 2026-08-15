import type pg from "pg";
import { PgSnapshotStore } from "../meta/snapshot-store.js";
import { listAdSetMeta } from "./audience-meta-cache.js";
import { deriveAudienceLabels, type AdSetMeta } from "../meta/audience-label.js";
import { resolveRangeWindow, type RangeKey } from "./readout.js";
import { resolveCampaignId } from "./customer-recommendations.js";

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
}

export interface AudienceRow {
  adSetId: string;
  label: string; // human dimension, or the ad-set name if nothing else distinguishes it
  spendAgorot: number;
  leads: number;
  cplAgorot: number | null;
  creatives: AudienceCreativeRow[];
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
  const store = new PgSnapshotStore(pool);
  const [adsetStats, creativeStats, meta] = await Promise.all([
    store.adsetRangeStats(campaignId, window.start, window.end),
    store.creativeRangeStats(campaignId, window.start, window.end),
    listAdSetMeta(pool, campaignId),
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

  const creativesByAdSet = new Map<string, AudienceCreativeRow[]>();
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
    });
    creativesByAdSet.set(key, list);
  }

  const audiences: AudienceRow[] = managedAdsetStats.map((a) => ({
    adSetId: a.adSetId,
    label: labels.get(a.adSetId) ?? metaById.get(a.adSetId)?.name ?? a.adSetId,
    spendAgorot: a.spendAgorot,
    leads: a.leads,
    cplAgorot: a.cplAgorot,
    creatives: (creativesByAdSet.get(a.adSetId) ?? []).sort((x, y) => y.spendAgorot - x.spendAgorot),
  }));
  audiences.sort((a, b) => b.spendAgorot - a.spendAgorot);

  if (audiences.length > 0) return { campaignId, range, audiences };

  const mostRecentDataDate = await store.mostRecentObjectDataDate(campaignId);
  const today = ref.toISOString().slice(0, 10);
  const reason: AudienceEmptyReason =
    mostRecentDataDate === null ? "no_data_yet" : mostRecentDataDate === today ? "started_today" : "no_data_in_range";
  return { campaignId, range, audiences, empty: { reason, mostRecentDataDate } };
}
