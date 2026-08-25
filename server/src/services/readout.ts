import type pg from "pg";
import type { Agorot } from "@aic/shared";
import type { CampaignStatus } from "@aic/shared";
import type { InsightsPeriod } from "../meta/types.js";
import { PgSnapshotStore, type PeriodAgg, type DailyPoint } from "../meta/snapshot-store.js";
import { rollingPeriods, todayPeriod, dailyPeriod } from "../meta/scheduled-ingestion.js";
import { computeCpl } from "../meta/insights.js";

// The customer-selectable ranges. "day" is today so far (provisional);
// "week"/"month" are trailing windows INCLUDING today, so the switcher always
// answers "how am I doing" rather than the engine's complete-days question.
export const RANGE_KEYS = ["day", "week", "month", "allTime"] as const;
export type RangeKey = (typeof RANGE_KEYS)[number];

export const RANGE_DAYS: Record<Exclude<RangeKey, "allTime">, number> = { day: 1, week: 7, month: 30 };

// The one place the day/week/month/all-time switcher's date math lives.
// AIC-95: campaign-audiences.ts (the per-audience/per-ad detail panel) used
// to ignore the switcher entirely and always query a different, fixed
// window — this is what makes it follow the same selection instead of
// silently answering a different question with the same UI control.
//
// Trailing and INCLUDING today (never the engine's own complete-days-only
// window, `scheduled-ingestion.ts`'s `rollingPeriods` — a deliberately
// different question: "how am I doing" vs. "what would the engine judge").
// `allTime` has no lower bound — summed from whatever disjoint-daily rows
// exist, honestly "as far back as we have data," not a fabricated lifetime
// figure for per-object grains that have no separate lifetime counter.
export function resolveRangeWindow(range: RangeKey, ref: Date): { start: string; end: string } {
  const day = 24 * 60 * 60 * 1000;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const end = iso(ref);
  if (range === "allTime") return { start: "1970-01-01", end };
  const start = iso(new Date(ref.getTime() - (RANGE_DAYS[range] - 1) * day));
  return { start, end };
}

function sumDays(points: DailyPoint[]): PeriodAgg {
  const spendAgorot = points.reduce((s, p) => s + p.spendAgorot, 0);
  const leads = points.reduce((s, p) => s + p.leads, 0);
  return { spendAgorot, leads, cplAgorot: computeCpl(spendAgorot, leads) };
}

export interface CreativeRow {
  metaObjectId: string;
  creativeName: string | null;
  spendAgorot: Agorot;
  leads: number;
  cplAgorot: Agorot | null;
  deliveryStatus: string;
}

export interface CampaignReadout {
  campaignId: string;
  name: string;
  status: CampaignStatus;
  metaCampaignId: string | null;
  period: { current: InsightsPeriod; previous: InsightsPeriod };
  current: PeriodAgg;
  previous: PeriodAgg;
  // Today so far — customer-surface only, and deliberately NOT folded into
  // `current` (which stops at yesterday). The engine evaluates on complete
  // days; blending a partial day into the 7-day CPL would make that ratio
  // noisy mid-day without helping anyone. Provisional: Meta's same-day
  // conversion data is incomplete and revises upward.
  today: PeriodAgg;
  // The customer's day/week/month/all-time switcher. Every bounded range is
  // summed from DISJOINT per-day rows; `allTime` comes from the cached
  // lifetime Meta read instead (per-day rows only go back
  // DAILY_LOOKBACK_DAYS). Never summed from the rolling-window snapshots —
  // those overlap and would multiply every figure.
  ranges: Record<RangeKey, PeriodAgg>;
  // Whether the window has ANY measured rows — see where it's built. Without
  // it a zero-sum over an empty set is indistinguishable from a real zero.
  rangeHasData: Record<RangeKey, boolean>;
  // Per-day series behind the leads graph, oldest first.
  daily: DailyPoint[];
  // Earliest day we have real data for, so the UI can say "this campaign is
  // new" instead of implying a flat empty month.
  firstDataDate: string | null;
  delta: {
    spendPct: number | null;
    leadsPct: number | null;
    cplPct: number | null;
  };
  perCreative: CreativeRow[];
}

// Percent change vs a baseline, rounded. NULL when there's no baseline to
// compare against (previous = 0) — an honest "no comparison," not a fake +100%.
export function deltaPct(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

// Assemble the admin readout for one campaign entirely from insight_snapshots —
// no live Meta call at render time (AIC-7). `ref` lets tests fix the window.
export async function buildCampaignReadout(
  pool: pg.Pool,
  campaignId: string,
  ref: Date = new Date(),
): Promise<CampaignReadout | null> {
  const camp = await pool.query<{
    name: string;
    status: CampaignStatus;
    meta_campaign_id: string | null;
    leads_to_date: number | null;
    spend_to_date: number | null;
  }>(
    `SELECT name, status, meta_campaign_id, leads_to_date, spend_to_date
     FROM managed_campaigns WHERE id = $1`,
    [campaignId],
  );
  if (camp.rows.length === 0) return null;

  const { current, previous } = rollingPeriods(ref);
  const todayWindow = todayPeriod(ref);
  const dailyWindow = dailyPeriod(ref);
  const store = new PgSnapshotStore(pool);
  const [cur, prev, today, daily] = await Promise.all([
    store.campaignTotals(campaignId, current.start, current.end),
    store.campaignTotals(campaignId, previous.start, previous.end),
    store.campaignTotals(campaignId, todayWindow.start, todayWindow.end),
    store.dailySeries(campaignId, dailyWindow.start, dailyWindow.end),
  ]);

  // Bounded ranges = sums over disjoint days, trailing and INCLUDING today.
  const ranges = {
    day: sumDays(daily.filter((p) => p.date >= resolveRangeWindow("day", ref).start)),
    week: sumDays(daily.filter((p) => p.date >= resolveRangeWindow("week", ref).start)),
    month: sumDays(daily.filter((p) => p.date >= resolveRangeWindow("month", ref).start)),
    // Lifetime figures come from the cached Meta read — the per-day rows only
    // reach back DAILY_LOOKBACK_DAYS, so summing them would silently
    // under-report an older campaign's "all time".
    allTime: {
      spendAgorot: Number(camp.rows[0].spend_to_date ?? 0),
      leads: Number(camp.rows[0].leads_to_date ?? 0),
      cplAgorot: computeCpl(Number(camp.rows[0].spend_to_date ?? 0), Number(camp.rows[0].leads_to_date ?? 0)),
    },
  } satisfies Record<RangeKey, PeriodAgg>;

  // AIC-130, found live: with no rows for today the cards read "₪0 · 0 פניות"
  // — a measured claim of zero — directly above a panel saying "אין נתונים
  // לתקופה שנבחרה". Both came from the same empty result; only one told the
  // truth. (עלות לפנייה already showed "—", because null has nowhere to
  // collapse to; spend and leads had a plausible-looking zero to fall into.)
  //
  // This is the same distinction the per-ad rows already make with `hasData`:
  // "no results YET" is not the claim "zero results". sumDays([]) cannot
  // express it, so the emptiness has to travel separately.
  const inRange = (k: RangeKey) => daily.filter((p) => p.date >= resolveRangeWindow(k, ref).start);
  const rangeHasData = {
    day: inRange("day").length > 0,
    week: inRange("week").length > 0,
    month: inRange("month").length > 0,
    // Lifetime doesn't come from the daily rows at all (they only reach back
    // DAILY_LOOKBACK_DAYS), so it's answered by the cached lifetime read.
    allTime: camp.rows[0].spend_to_date != null || camp.rows[0].leads_to_date != null,
  } satisfies Record<RangeKey, boolean>;

  // AIC-85/86 regression fix: this used to be its own hand-rolled query,
  // independently vulnerable to the same overlapping-window bug
  // creativeStats() was just fixed for (a rolling row plus the "today"
  // extra-period ingestion's leftover single-day rows for the same object,
  // both matching a plain containment filter with no dedup — one real ad
  // rendered as three). Routing through the shared, now-fixed store method
  // instead of re-querying `insight_snapshots` directly means this can't
  // drift out of sync with the fix again.
  const creativeStats = await store.creativeStats(campaignId, current.start, current.end);

  return {
    campaignId,
    name: camp.rows[0].name,
    status: camp.rows[0].status,
    metaCampaignId: camp.rows[0].meta_campaign_id,
    period: { current, previous },
    current: cur,
    previous: prev,
    today,
    ranges,
    rangeHasData,
    daily,
    firstDataDate: daily.find((p) => p.spendAgorot > 0 || p.leads > 0)?.date ?? null,
    delta: {
      spendPct: deltaPct(cur.spendAgorot, prev.spendAgorot),
      leadsPct: deltaPct(cur.leads, prev.leads),
      cplPct:
        cur.cplAgorot !== null && prev.cplAgorot !== null
          ? deltaPct(cur.cplAgorot, prev.cplAgorot)
          : null,
    },
    perCreative: creativeStats.map((r) => ({
      metaObjectId: r.metaObjectId,
      creativeName: r.creativeName,
      spendAgorot: r.spendAgorot,
      leads: r.leads,
      cplAgorot: r.cplAgorot,
      deliveryStatus: r.deliveryStatus,
    })),
  };
}

// List managed campaigns for the admin picker.
export async function listCampaignsForAdmin(pool: pg.Pool): Promise<
  Array<{ id: string; name: string; status: CampaignStatus; business: string }>
> {
  const { rows } = await pool.query(
    `SELECT mc.id, mc.name, mc.status, c.business_name AS business
     FROM managed_campaigns mc
     JOIN customers c ON c.id = mc.customer_id
     ORDER BY c.business_name`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    business: r.business,
  }));
}
