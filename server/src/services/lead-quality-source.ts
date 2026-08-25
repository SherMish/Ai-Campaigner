import type pg from "pg";
import {
  attributeLeadQuality, qualityVerdict,
  type LeadQualityReview, type WindowLeads,
} from "./lead-quality-attribution.js";

// AIC-133: the DB half of lead-quality attribution. The judgement lives in
// lead-quality-attribution.ts (pure, tested on its own); this only fetches the
// reviews and the per-ad-set leads inside each review's window.
//
// THE WINDOW. A review covers everything since the previous review — that is
// exactly what AIC-67's `leads_delta` means, and using any other boundary
// (a calendar week, the rolling engine window) would attribute leads the
// customer was never asked about. The first review's window opens at the
// campaign's first recorded data.

export interface AdSetQualityMap {
  byAdSet: Map<string, { costPerRelevantAgorot: number | null; relevantRate: number | null; reviewCount: number }>;
  attributed: number;
  unattributable: number;
}

// The attribution math is keyed on an object id and knows nothing about what
// that object IS, so the same windows answer "which audience" and "which ad".
// Creatives are the sparser of the two — a campaign usually runs several ads
// at once, so most reviews come back unattributable — but sparse-and-honest is
// the whole design here, and the alternative is guessing.
export async function loadLeadQuality(
  pool: pg.Pool,
  campaignId: string,
  grain: "adset" | "creative" = "adset",
): Promise<AdSetQualityMap> {
  const { rows: reviewRows } = await pool.query<{ id: string; reviewed_at: Date; leads_delta: number; relevant_delta: number }>(
    `SELECT id, reviewed_at, leads_delta, relevant_delta
       FROM lead_quality_reviews WHERE campaign_id = $1 ORDER BY reviewed_at ASC`,
    [campaignId],
  );
  if (reviewRows.length === 0) {
    return { byAdSet: new Map(), attributed: 0, unattributable: 0 };
  }

  const reviews: LeadQualityReview[] = reviewRows.map((r) => ({
    id: r.id,
    createdAt: new Date(r.reviewed_at),
    leadsDelta: Number(r.leads_delta),
    relevantDelta: Number(r.relevant_delta),
  }));

  // Per (ad set, day) leads from the DAILY view — never the raw table, which
  // mixes per-day rows with overlapping rolling-window rows and would
  // double-count (migration 030).
  const { rows: dayRows } = await pool.query<{ meta_object_id: string; day: string; leads: number; spend_agorot: string }>(
    `SELECT meta_object_id, period_start::text AS day, SUM(leads)::int AS leads,
            SUM(spend_agorot)::bigint AS spend_agorot
       FROM insight_snapshot_daily
      WHERE campaign_id = $1 AND grain = $2
      GROUP BY meta_object_id, period_start`,
    [campaignId, grain],
  );

  // SPEND MUST COVER THE SAME DAYS AS THE LEADS. The review windows are
  // contiguous from the campaign's first data up to the last review, so their
  // union is simply "every day on or before the last review". Using lifetime
  // spend instead would divide reviewed relevant leads by unreviewed spend —
  // and by a different amount per ad set, which silently reorders the very
  // comparison this exists to get right.
  const lastReviewDay = reviews[reviews.length - 1].createdAt.toISOString().slice(0, 10);
  const spendByAdSet = new Map<string, number>();
  for (const d of dayRows) {
    if (d.day <= lastReviewDay) {
      spendByAdSet.set(d.meta_object_id, (spendByAdSet.get(d.meta_object_id) ?? 0) + Number(d.spend_agorot));
    }
  }

  const windowFor = (review: LeadQualityReview): WindowLeads[] => {
    const idx = reviews.findIndex((r) => r.id === review.id);
    // Day-resolution windows: reviews carry a timestamp but snapshots are
    // daily, so the boundary is a date. Documented rather than hidden — a
    // review recorded mid-day attributes that whole day.
    const start = idx > 0 ? reviews[idx - 1].createdAt.toISOString().slice(0, 10) : "0000-01-01";
    const end = review.createdAt.toISOString().slice(0, 10);
    const totals = new Map<string, number>();
    for (const d of dayRows) {
      if (d.day > start && d.day <= end) {
        totals.set(d.meta_object_id, (totals.get(d.meta_object_id) ?? 0) + Number(d.leads));
      }
    }
    return [...totals].map(([adSetId, leads]) => ({ adSetId, leads }));
  };

  const attribution = attributeLeadQuality(reviews, windowFor);
  const byAdSet = new Map<string, { costPerRelevantAgorot: number | null; relevantRate: number | null; reviewCount: number }>();

  for (const [adSetId, quality] of attribution.byAdSet) {
    const verdict = qualityVerdict(quality, spendByAdSet.get(adSetId) ?? 0);
    // Only USABLE verdicts enter the map. An ad set with one review is absent
    // rather than present-with-weak-data, so a consumer cannot accidentally
    // act on it by forgetting to check a flag.
    if (verdict.usable) {
      byAdSet.set(adSetId, {
        costPerRelevantAgorot: verdict.costPerRelevantAgorot,
        relevantRate: verdict.relevantRate,
        reviewCount: verdict.reviewCount,
      });
    }
  }

  return { byAdSet, attributed: attribution.attributed, unattributable: attribution.unattributable };
}
