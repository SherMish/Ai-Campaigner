import { shekelToAgorot, type Agorot } from "@aic/shared";
import type { InsightsPeriod } from "./types.js";
import { extractLeads, computeCpl } from "./insights.js";

// Full Meta data explorer (AIC-45) — the unrestricted internal counterpart to
// the customer's opt-in audience view (AIC-37). Where AIC-37 shows a human
// label and 3 numbers, this shows the raw tree with EVERY metric Meta gives
// us, including the ones deliberately hidden from customers (PRD §14): CPM,
// CTR, CPC, reach, frequency, and the quality/engagement/conversion rankings.
// Read-only — this never writes; any change still goes through AIC-12.

export interface ExplorerMetrics {
  spendAgorot: Agorot;
  impressions: number;
  reach: number | null;
  frequency: number | null;
  cpmAgorot: Agorot | null;
  ctrPct: number | null;
  cpcAgorot: Agorot | null;
  leads: number;
  cplAgorot: Agorot | null;
  qualityRanking: string | null;
  engagementRateRanking: string | null;
  conversionRateRanking: string | null;
}

export interface ExplorerCreative {
  id: string | null;
  name: string | null;
  title: string | null;
  body: string | null;
  callToActionType: string | null;
  imageUrl: string | null;
  videoId: string | null;
  // A "flexible"/dynamic creative (asset_feed_spec) mixes several images/
  // videos/bodies/titles instead of one fixed object_story_spec — Meta picks
  // the combination per impression. Surfaced as counts + the raw spec so the
  // operator sees it's flexible rather than a broken single creative.
  isFlexible: boolean;
  flexibleAssetCounts: { images: number; videos: number; bodies: number; titles: number } | null;
  // The Facebook Page this creative posts as — surfaced because it's the only
  // place in the app that reads it live; useful when meta_connections.page_id
  // needs reconciling against what's actually running.
  pageId: string | null;
}

export interface ExplorerAd {
  id: string;
  name: string | null;
  effectiveStatus: string | null;
  issues: string[];
  creative: ExplorerCreative | null;
  metrics: ExplorerMetrics;
}

export interface ExplorerTargeting {
  ageMin: number | null;
  ageMax: number | null;
  genders: string[]; // ["all"] when unset/both
  geoCountries: string[];
  interests: string[]; // flexible_spec interest names, when present
}

export interface ExplorerAdSet {
  id: string;
  name: string | null;
  effectiveStatus: string | null;
  issues: string[];
  dailyBudgetAgorot: Agorot | null;
  lifetimeBudgetAgorot: Agorot | null;
  bidStrategy: string | null;
  targeting: ExplorerTargeting;
  metrics: ExplorerMetrics;
  ads: ExplorerAd[];
  // The WhatsApp-destination ad set's promoted_object.page_id (set by our own
  // createAdSet, campaign-adapter.ts) — the reliable source for this account
  // type; creative-level object_story_spec/effective_object_story_id are
  // empty for click-to-WhatsApp ads.
  pageId: string | null;
  // AIC-65: false for a deleted/archived ad set, or one with zero ads (a
  // never-published draft — effective_status can still say ACTIVE for these,
  // Meta doesn't always reclassify it). Rendered clearly marked in the
  // operator view; never counted or shown as a normal active ad set.
  isManaged: boolean;
}

export interface ExplorerCampaign {
  id: string;
  name: string | null;
  effectiveStatus: string | null;
  dailyBudgetAgorot: Agorot | null;
  lifetimeBudgetAgorot: Agorot | null;
  bidStrategy: string | null;
  metrics: ExplorerMetrics;
  adSets: ExplorerAdSet[];
  period: InsightsPeriod;
  fetchedAt: string;
}

export interface ExplorerReader {
  getExplorerTree(metaCampaignId: string, period: InsightsPeriod): Promise<ExplorerCampaign>;
}

// ── Raw Meta shapes (only the fields we asked for) ──────────────────────────
interface RawIssue { error_summary?: string; error_message?: string }
interface RawInsightsRow {
  spend?: string;
  impressions?: string;
  reach?: string;
  frequency?: string;
  cpm?: string;
  ctr?: string;
  cpc?: string;
  actions?: Array<{ action_type: string; value: string }>;
  quality_ranking?: string;
  engagement_rate_ranking?: string;
  conversion_rate_ranking?: string;
}
interface RawTargeting {
  // age_min/age_max are the Advantage+ EXPANSION CEILING, not the configured
  // range — see audience-label.ts. Even on this raw-truth surface an operator
  // debugging targeting wants what was actually set (AIC-73).
  age_min?: number;
  age_max?: number;
  age_range?: number[]; // [min, max] — authoritative when present
  genders?: number[]; // 1=male, 2=female; absent/empty = all
  geo_locations?: { countries?: string[] };
  flexible_spec?: Array<{ interests?: Array<{ name?: string }> }>;
}
interface RawAdSet {
  id: string;
  name?: string;
  effective_status?: string;
  issues_info?: RawIssue[];
  daily_budget?: string;
  lifetime_budget?: string;
  bid_strategy?: string;
  targeting?: RawTargeting;
  promoted_object?: { page_id?: string };
}
interface RawCreative {
  id?: string;
  name?: string;
  title?: string;
  body?: string;
  call_to_action_type?: string;
  image_url?: string;
  video_id?: string;
  thumbnail_url?: string;
  object_story_spec?: { page_id?: string };
  asset_feed_spec?: {
    images?: unknown[];
    videos?: unknown[];
    bodies?: unknown[];
    titles?: unknown[];
  };
}
interface RawAd {
  id: string;
  name?: string;
  adset_id?: string;
  effective_status?: string;
  issues_info?: RawIssue[];
  creative?: RawCreative;
  // "{page_id}_{post_id}" — a more universal source than creative.
  // object_story_spec.page_id, which some formats (e.g. click-to-WhatsApp)
  // don't populate.
  effective_object_story_id?: string;
}

// The ad-level fallback for pageId: parse "{page_id}_{post_id}".
export function pageIdFromStoryId(id?: string): string | null {
  if (!id) return null;
  const i = id.indexOf("_");
  return i > 0 ? id.slice(0, i) : null;
}

function issuesOf(raw?: RawIssue[]): string[] {
  return (raw ?? []).map((i) => i.error_summary || i.error_message || "").filter(Boolean);
}

function emptyMetrics(): ExplorerMetrics {
  return {
    spendAgorot: 0, impressions: 0, reach: null, frequency: null,
    cpmAgorot: null, ctrPct: null, cpcAgorot: null, leads: 0, cplAgorot: null,
    qualityRanking: null, engagementRateRanking: null, conversionRateRanking: null,
  };
}

export function normalizeMetrics(row: RawInsightsRow | undefined): ExplorerMetrics {
  if (!row) return emptyMetrics();
  const spendAgorot = shekelToAgorot(Number(row.spend) || 0);
  const leads = extractLeads(row.actions);
  return {
    spendAgorot,
    impressions: Math.round(Number(row.impressions) || 0),
    reach: row.reach != null ? Math.round(Number(row.reach)) : null,
    frequency: row.frequency != null ? Number(row.frequency) : null,
    cpmAgorot: row.cpm != null ? shekelToAgorot(Number(row.cpm)) : null,
    ctrPct: row.ctr != null ? Number(row.ctr) : null,
    cpcAgorot: row.cpc != null ? shekelToAgorot(Number(row.cpc)) : null,
    leads,
    cplAgorot: computeCpl(spendAgorot, leads),
    qualityRanking: row.quality_ranking ?? null,
    engagementRateRanking: row.engagement_rate_ranking ?? null,
    conversionRateRanking: row.conversion_rate_ranking ?? null,
  };
}

const GENDER_NAMES: Record<number, string> = { 1: "male", 2: "female" };

export function normalizeTargeting(raw?: RawTargeting): ExplorerTargeting {
  const genders = (raw?.genders ?? []).map((g) => GENDER_NAMES[g] ?? String(g));
  const interests = (raw?.flexible_spec ?? [])
    .flatMap((spec) => spec.interests ?? [])
    .map((i) => i.name)
    .filter((n): n is string => !!n);
  const ageRange = raw?.age_range;
  const hasRange = Array.isArray(ageRange) && ageRange.length >= 2;
  return {
    ageMin: (hasRange ? ageRange[0] : raw?.age_min) ?? null,
    ageMax: (hasRange ? ageRange[1] : raw?.age_max) ?? null,
    genders: genders.length ? genders : ["all"],
    geoCountries: raw?.geo_locations?.countries ?? [],
    interests,
  };
}

const GRAPH_BASE = "https://graph.facebook.com";

const ADSET_FIELDS =
  "id,name,effective_status,issues_info,daily_budget,lifetime_budget,bid_strategy,promoted_object," +
  "targeting{age_min,age_max,age_range,genders,geo_locations,flexible_spec{interests}}";
const AD_FIELDS =
  "id,name,adset_id,effective_status,issues_info,effective_object_story_id," +
  "creative{id,name,title,body,call_to_action_type,image_url,video_id,thumbnail_url,object_story_spec{page_id},asset_feed_spec{images,videos,bodies,titles}}";
const INSIGHTS_FIELDS =
  "campaign_id,adset_id,ad_id,spend,impressions,reach,frequency,cpm,ctr,cpc,actions," +
  "quality_ranking,engagement_rate_ranking,conversion_rate_ranking";

// Live Graph API reader for the explorer (AIC-45). Deliberately its own small
// client rather than growing GraphCampaignAdapter (the safe-execute reader/
// writer, AIC-12) — this is diagnostic-only, read-only, and asks for a much
// wider field set than anything the engine needs. Fetch-on-demand (the ticket's
// own "fine for few operators" choice): every explorer open/refresh is a fresh
// read, nothing is cached at rest — this is the raw-truth surface, not a
// number the engine or a customer sees, so it's the deliberate one exception
// to "never a live Meta call at render time" (AIC-7's rule protects the
// surfaces on the normal navigation path; this one is behind an explicit
// operator action).
export class GraphExplorerReader implements ExplorerReader {
  constructor(
    private readonly token: string,
    private readonly ver = process.env.META_GRAPH_VERSION || "v21.0",
  ) {}

  private async get(pathAndQuery: string): Promise<Record<string, unknown>> {
    const r = await fetch(`${GRAPH_BASE}/${this.ver}/${pathAndQuery}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) throw new Error(`GET ${pathAndQuery} → ${r.status} ${JSON.stringify((body as { error?: unknown }).error ?? body)}`);
    return body;
  }

  private async insightsByLevel(
    campaignId: string,
    level: "campaign" | "adset" | "ad",
    period: InsightsPeriod,
  ): Promise<Map<string, RawInsightsRow>> {
    const timeRange = encodeURIComponent(JSON.stringify({ since: period.start, until: period.end }));
    const body = await this.get(`${campaignId}/insights?level=${level}&fields=${INSIGHTS_FIELDS}&time_range=${timeRange}`);
    const rows = (body.data as Array<RawInsightsRow & { campaign_id?: string; adset_id?: string; ad_id?: string }>) ?? [];
    const key = level === "campaign" ? "campaign_id" : level === "adset" ? "adset_id" : "ad_id";
    return new Map(rows.map((r) => [String(r[key as "campaign_id"] ?? ""), r]));
  }

  async getExplorerTree(metaCampaignId: string, period: InsightsPeriod): Promise<ExplorerCampaign> {
    const [campBody, adsetsBody, adsBody, campInsights, adsetInsights, adInsights] = await Promise.all([
      this.get(`${metaCampaignId}?fields=id,name,effective_status,daily_budget,lifetime_budget,bid_strategy`),
      this.get(`${metaCampaignId}/adsets?fields=${ADSET_FIELDS}&limit=100`),
      this.get(`${metaCampaignId}/ads?fields=${AD_FIELDS}&limit=200`),
      this.insightsByLevel(metaCampaignId, "campaign", period),
      this.insightsByLevel(metaCampaignId, "adset", period),
      this.insightsByLevel(metaCampaignId, "ad", period),
    ]);

    const adsByAdSet = new Map<string, RawAd[]>();
    for (const ad of (adsBody.data as RawAd[]) ?? []) {
      const key = ad.adset_id ?? "";
      if (!adsByAdSet.has(key)) adsByAdSet.set(key, []);
      adsByAdSet.get(key)!.push(ad);
    }

    const adSets: ExplorerAdSet[] = ((adsetsBody.data as RawAdSet[]) ?? []).map((a) => ({
      id: a.id,
      name: a.name ?? null,
      effectiveStatus: a.effective_status ?? null,
      issues: issuesOf(a.issues_info),
      dailyBudgetAgorot: a.daily_budget != null ? Number(a.daily_budget) : null,
      lifetimeBudgetAgorot: a.lifetime_budget != null ? Number(a.lifetime_budget) : null,
      bidStrategy: a.bid_strategy ?? null,
      targeting: normalizeTargeting(a.targeting),
      metrics: normalizeMetrics(adsetInsights.get(a.id)),
      pageId: a.promoted_object?.page_id ?? null,
      isManaged: a.effective_status !== "DELETED" && a.effective_status !== "ARCHIVED" && (adsByAdSet.get(a.id) ?? []).length > 0,
      ads: (adsByAdSet.get(a.id) ?? []).map((ad) => {
        const creative = normalizeCreative(ad.creative);
        // Some ad formats (e.g. click-to-WhatsApp) leave creative.object_story_spec
        // empty — fall back to the ad-level effective_object_story_id ("{page}_{post}").
        if (creative && creative.pageId === null) {
          creative.pageId = pageIdFromStoryId(ad.effective_object_story_id);
        }
        return {
          id: ad.id,
          name: ad.name ?? null,
          effectiveStatus: ad.effective_status ?? null,
          issues: issuesOf(ad.issues_info),
          creative,
          metrics: normalizeMetrics(adInsights.get(ad.id)),
        };
      }),
    }));

    const camp = campBody as unknown as { id: string; name?: string; effective_status?: string; daily_budget?: string; lifetime_budget?: string; bid_strategy?: string };
    return {
      id: camp.id,
      name: camp.name ?? null,
      effectiveStatus: camp.effective_status ?? null,
      dailyBudgetAgorot: camp.daily_budget != null ? Number(camp.daily_budget) : null,
      lifetimeBudgetAgorot: camp.lifetime_budget != null ? Number(camp.lifetime_budget) : null,
      bidStrategy: camp.bid_strategy ?? null,
      metrics: normalizeMetrics(campInsights.get(camp.id)),
      adSets,
      period,
      fetchedAt: new Date().toISOString(),
    };
  }
}

export function normalizeCreative(raw?: RawCreative): ExplorerCreative | null {
  if (!raw) return null;
  const feed = raw.asset_feed_spec;
  const isFlexible = !!feed && ((feed.images?.length ?? 0) + (feed.videos?.length ?? 0) > 1 || (feed.bodies?.length ?? 0) + (feed.titles?.length ?? 0) > 1);
  return {
    id: raw.id ?? null,
    name: raw.name ?? null,
    title: raw.title ?? null,
    body: raw.body ?? null,
    callToActionType: raw.call_to_action_type ?? null,
    imageUrl: raw.image_url ?? raw.thumbnail_url ?? null,
    videoId: raw.video_id ?? null,
    pageId: raw.object_story_spec?.page_id ?? null,
    isFlexible,
    flexibleAssetCounts: isFlexible
      ? {
          images: feed?.images?.length ?? 0,
          videos: feed?.videos?.length ?? 0,
          bodies: feed?.bodies?.length ?? 0,
          titles: feed?.titles?.length ?? 0,
        }
      : null,
  };
}
