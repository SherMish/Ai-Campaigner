import type {
  AssetKind,
  AssetAccessResult,
  MetaClient,
  RawInsightRow,
  InsightsPeriod,
} from "./types.js";
import type { InsightGrain } from "@aic/shared";
import { classifyGraphError, type GraphErrorBody } from "./errors.js";

const GRAPH_BASE = "https://graph.facebook.com";

// Insights levels we pull. The standard P0 structure is 1 campaign → 1 ad set →
// 3–5 ads, each ad carrying one creative; we derive the creative grain from ad
// rows (see docs/METRICS.md), so the API levels queried are campaign/adset/ad.
const INSIGHT_LEVELS: Array<{ level: string; grain: InsightGrain }> = [
  { level: "campaign", grain: "campaign" },
  { level: "adset", grain: "adset" },
  { level: "ad", grain: "ad" },
];

const INSIGHT_FIELDS =
  "spend,impressions,inline_link_clicks,actions,campaign_id,adset_id,ad_id,ad_name";

// A cheap read per asset kind that fails iff we can't operate it.
function verifyPath(kind: AssetKind, id: string): string {
  switch (kind) {
    case "ad_account":
      // id is act_XXXX; account_status read requires ads_read on the account.
      return `${id}?fields=id,account_status`;
    case "page":
      return `${id}?fields=id`;
    case "instagram":
      return `${id}?fields=id`;
  }
}

type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

// Real Graph API client. The System User token is sent as a Bearer header, never
// in the URL (query-string tokens leak into logs). The `fetch` impl is injected
// so tests can drive it without network.
export class GraphMetaClient implements MetaClient {
  constructor(
    private readonly token: string,
    private readonly graphVersion = process.env.META_GRAPH_VERSION || "v21.0",
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}

  async verifyAssetAccess(
    kind: AssetKind,
    id: string,
  ): Promise<AssetAccessResult> {
    const url = `${GRAPH_BASE}/${this.graphVersion}/${verifyPath(kind, id)}`;
    try {
      const res = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      if (res.ok) {
        return { kind, id, health: "ok" };
      }
      const body = (await res.json().catch(() => undefined)) as
        | GraphErrorBody
        | undefined;
      const { health, detail } = classifyGraphError(res.status, body);
      return { kind, id, health, detail };
    } catch (err) {
      // Network/transport failure — unclassified; re-check next tick.
      return {
        kind,
        id,
        health: "needs_reconnect",
        detail: `network error verifying ${kind} ${id}: ${(err as Error).message}`,
      };
    }
  }

  async getInsights(
    campaignMetaId: string,
    period: InsightsPeriod,
  ): Promise<RawInsightRow[]> {
    const out: RawInsightRow[] = [];
    const timeRange = encodeURIComponent(
      JSON.stringify({ since: period.start, until: period.end }),
    );
    for (const { level, grain } of INSIGHT_LEVELS) {
      const url =
        `${GRAPH_BASE}/${this.graphVersion}/${campaignMetaId}/insights` +
        `?level=${level}&fields=${INSIGHT_FIELDS}&time_range=${timeRange}`;
      const res = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => undefined)) as
          | GraphErrorBody
          | undefined;
        throw new Error(
          `insights ${level} failed: ${JSON.stringify(body?.error ?? res.status)}`,
        );
      }
      const json = (await res.json()) as { data?: Record<string, unknown>[] };
      for (const d of json.data ?? []) {
        out.push(mapInsightRow(d, grain));
        // Standard structure: each ad = one creative. Emit a creative-grain row
        // mirroring the ad row so the per-creative table has data.
        if (grain === "ad") {
          out.push({ ...mapInsightRow(d, "creative") });
        }
      }
    }
    return out;
  }
}

function mapInsightRow(
  d: Record<string, unknown>,
  grain: InsightGrain,
): RawInsightRow {
  const objectId =
    grain === "campaign"
      ? String(d.campaign_id ?? "")
      : grain === "adset"
        ? String(d.adset_id ?? "")
        : String(d.ad_id ?? "");
  return {
    grain,
    objectId,
    parentId:
      grain === "ad" || grain === "creative"
        ? String(d.adset_id ?? "")
        : grain === "adset"
          ? String(d.campaign_id ?? "")
          : undefined,
    name: d.ad_name ? String(d.ad_name) : undefined,
    spend: String(d.spend ?? "0"),
    impressions: d.impressions ? String(d.impressions) : undefined,
    inlineLinkClicks: d.inline_link_clicks
      ? String(d.inline_link_clicks)
      : undefined,
    actions: (d.actions as RawInsightRow["actions"]) ?? undefined,
    raw: d,
  };
}

// Deterministic fake for tests: seed per-asset health and Insights fixtures.
export class FakeMetaClient implements MetaClient {
  public calls: Array<{ kind: AssetKind; id: string }> = [];
  public insightsError: Error | null = null;
  private insightsByCampaign: Record<string, RawInsightRow[]> = {};

  constructor(
    private readonly byId: Record<string, AssetAccessResult["health"]> = {},
    private readonly fallback: AssetAccessResult["health"] = "ok",
  ) {}

  async verifyAssetAccess(
    kind: AssetKind,
    id: string,
  ): Promise<AssetAccessResult> {
    this.calls.push({ kind, id });
    const health = this.byId[id] ?? this.fallback;
    return {
      kind,
      id,
      health,
      detail: health === "ok" ? undefined : `fake:${health}`,
    };
  }

  /** Seed Insights rows a campaign will return. */
  setInsights(campaignMetaId: string, rows: RawInsightRow[]): void {
    this.insightsByCampaign[campaignMetaId] = rows;
  }

  async getInsights(
    campaignMetaId: string,
    _period: InsightsPeriod,
  ): Promise<RawInsightRow[]> {
    if (this.insightsError) throw this.insightsError;
    return this.insightsByCampaign[campaignMetaId] ?? [];
  }
}
