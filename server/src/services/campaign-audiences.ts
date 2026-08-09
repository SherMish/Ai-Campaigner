import type pg from "pg";
import { PgSnapshotStore } from "../meta/snapshot-store.js";
import { listAdSetMeta } from "./audience-meta-cache.js";
import { deriveAudienceLabels, type AdSetMeta } from "../meta/audience-label.js";
import { rollingPeriods } from "../meta/scheduled-ingestion.js";
import { resolveCampaignId } from "./customer-recommendations.js";

// The opt-in "details" view (AIC-37): per-audience (ad set) breakdown, each with
// its own per-creative rows. Progressive disclosure — the customer's default Home
// stays the four-number roll-up; this is the door they open on request. Business-
// framed labels only (the human audience dimension, never "ad set N"); raw
// ad-jargon metrics (CPM/CTR/etc.) stay out, same boundary as the rest of the
// customer surface.

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

export interface CampaignAudiences {
  campaignId: string;
  audiences: AudienceRow[];
}

// Ownership-scoped: resolves the caller's own campaign, never another
// customer's. Reads only from our DB (snapshots + the cached ad_set_meta) — no
// live Meta call at render time, same discipline as the rest of the readout.
export async function buildCampaignAudiences(
  pool: pg.Pool,
  userId: string,
  ref: Date = new Date(),
): Promise<CampaignAudiences | null> {
  const campaignId = await resolveCampaignId(pool, userId);
  if (!campaignId) return null;

  const { current } = rollingPeriods(ref);
  const store = new PgSnapshotStore(pool);
  const [adsetStats, creativeStats, meta] = await Promise.all([
    store.adsetStats(campaignId, current.start, current.end),
    store.creativeStats(campaignId, current.start, current.end),
    listAdSetMeta(pool, campaignId),
  ]);

  const metaById = new Map(meta.map((m) => [m.adSetId, m]));
  const asMetaList: AdSetMeta[] = adsetStats.map((a) => {
    const m = metaById.get(a.adSetId);
    return {
      adSetId: a.adSetId,
      name: m?.name ?? "",
      ageMin: m?.ageMin ?? null,
      ageMax: m?.ageMax ?? null,
      genders: m?.genders ?? "all",
      geoSummary: m?.geoSummary ?? "",
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

  const audiences: AudienceRow[] = adsetStats.map((a) => ({
    adSetId: a.adSetId,
    label: labels.get(a.adSetId) ?? metaById.get(a.adSetId)?.name ?? a.adSetId,
    spendAgorot: a.spendAgorot,
    leads: a.leads,
    cplAgorot: a.cplAgorot,
    creatives: (creativesByAdSet.get(a.adSetId) ?? []).sort((x, y) => y.spendAgorot - x.spendAgorot),
  }));
  audiences.sort((a, b) => b.spendAgorot - a.spendAgorot);

  return { campaignId, audiences };
}
