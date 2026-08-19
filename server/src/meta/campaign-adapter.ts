import type { LiveCampaignState, MetaReader, ExecWriter } from "../execution/safe-executor.js";
import { normalizeAdSet, isProblem, type AdSetHealth, type DeliveryReader, type RawAdSetDelivery } from "./delivery-health.js";
import { normalizeAdSetMeta, type AdSetMeta, type RawAdSetMeta } from "./audience-label.js";
import type { BuilderWriter, CreateCampaignParams, CreateAdSetParams, CreateAdParams, PixelOption, PixelRecencyCheck } from "../builder/types.js";
import type {
  CreativeWriter,
  UploadedImage,
  UploadedVideo,
  PromotablePost,
  CreateUploadCreativeParams,
  CreatePostCreativeParams,
} from "../builder/creative-types.js";
import type { LaunchWriter, MetaCampaignStatus } from "../launch/types.js";
import type { AdditionWriter } from "../additions/types.js";
import { intentStatus, type ControlWriter, type ManualObjectStatus, type ObjectIntent } from "../controls/types.js";
import { shekelToAgorot, resolveDestinationShape } from "@aic/shared";
import { extractLeads } from "./insights.js";
import { normalizeAdMedia, type AdMedia, type AdMediaReader, type RawAdMedia } from "./ad-media.js";
import { detectDestination, type AdSetTrackingConfig, type TrackingReader } from "./tracking-health.js";
import type { AdAccountOption, PageOption, DiscoveredCampaign, CampaignDiscoveryReader } from "./campaign-discovery.js";

// Real Meta reader+writer backing the safe-execute pipeline (AIC-12) against the
// Marketing API. Budgets are read/written in the account currency's MINOR unit,
// which for ILS is agorot — matching our integer-agorot model directly.
//
// A campaign's budget may live at campaign level (CBO) or ad-set level; this
// adapter resolves the budget-bearing object on read and writes back to the same
// one, so setDailyBudget targets the right object.
const BASE = "https://graph.facebook.com";

export class GraphCampaignAdapter implements MetaReader, ExecWriter, DeliveryReader, BuilderWriter, CreativeWriter, LaunchWriter, AdditionWriter, ControlWriter, AdMediaReader, TrackingReader, CampaignDiscoveryReader {
  private budgetObj = new Map<string, string>(); // campaignId → budget object id

  constructor(
    private readonly token: string,
    private readonly ver = process.env.META_GRAPH_VERSION || "v21.0",
    // Injectable so tests can poll uploadVideo's processing check without
    // waiting in real time — production never overrides this.
    private readonly videoPollDelayMs = 2000,
  ) {}

  // `token` defaults to the System User token; Page-content edges must pass the
  // Page's own token instead (see pageAccessToken).
  private async get(pathAndQuery: string, token: string = this.token): Promise<Record<string, unknown>> {
    const r = await fetch(`${BASE}/${this.ver}/${pathAndQuery}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) throw new Error(`GET ${pathAndQuery} → ${r.status} ${JSON.stringify(body.error ?? body)}`);
    return body;
  }

  private async post(id: string, fields: Record<string, string>): Promise<void> {
    const r = await fetch(`${BASE}/${this.ver}/${id}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) throw new Error(`POST ${id} → ${r.status} ${JSON.stringify(body.error ?? body)}`);
  }

  // Create a new object under `parentId` (e.g. an ad account, campaign, or ad
  // set) and return its real Meta id. Meta's create endpoints return
  // `{ id: "..." }` on success. Fields are sent as JSON-string values in the
  // form body, matching how Meta expects nested params (targeting, creative,
  // special_ad_categories) on these endpoints.
  private async postCreate(parentId: string, edge: string, fields: Record<string, unknown>): Promise<string> {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) {
      body.set(k, typeof v === "string" ? v : JSON.stringify(v));
    }
    const r = await fetch(`${BASE}/${this.ver}/${parentId}/${edge}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok || !json.id) {
      throw new Error(`POST ${parentId}/${edge} → ${r.status} ${JSON.stringify(json.error ?? json)}`);
    }
    return String(json.id);
  }

  // AIC-70 (real bug, 2026-08-12): this method backs the customer's per-row
  // pause/resume display, read right after a manual write. `effective_status`
  // is a COMPUTED field with read-after-write lag — the same class of bug
  // commit 556cbcb fixed for the read-back verifiers (getCampaignStatus /
  // getAdSetStatus / getAdStatus, all below). This was the missed fourth
  // consumer: a customer could resume an ad, get read-back-verified success,
  // and still see it as paused here until Meta's computed field caught up.
  // `status` is what was just set — instant, authoritative for "what did I
  // set", which is exactly the question this method answers.
  async getCampaignState(metaCampaignId: string): Promise<LiveCampaignState & { campaignStatus: ObjectIntent }> {
    // AIC-100: `status`, not `effective_status` — same reason as every other
    // own-status read in this method (see the read-after-write comment
    // above). campaignStatus joins adStatuses/adSetStatuses so the customer
    // app can resolve an ad's real delivery from all three own-intents
    // instead of a single ambiguous field.
    const camp = await this.get(`${metaCampaignId}?fields=daily_budget,status,name`);
    let budgetObjId = metaCampaignId;
    let dailyBudgetAgorot = camp.daily_budget != null ? Number(camp.daily_budget) : NaN;
    const campaignStatus = intentStatus(camp.status as string | undefined);

    // Always read ad sets: for their statuses (the audience rule + pause_adset
    // verify) and, when the campaign has no CBO budget, the ad-set-level budget.
    const adsetsBody = await this.get(`${metaCampaignId}/adsets?fields=id,daily_budget,status&limit=100`);
    const adsets = (adsetsBody.data as Array<Record<string, unknown>>) ?? [];
    const adSetStatuses: Record<string, ObjectIntent> = {};
    for (const a of adsets) {
      adSetStatuses[String(a.id)] = intentStatus(a.status as string | undefined);
    }
    if (!(dailyBudgetAgorot > 0)) {
      const withBudget = adsets.find((a) => a.daily_budget != null);
      if (withBudget) {
        budgetObjId = String(withBudget.id);
        dailyBudgetAgorot = Number(withBudget.daily_budget);
      }
    }
    this.budgetObj.set(metaCampaignId, budgetObjId);

    const ads = await this.get(`${metaCampaignId}/ads?fields=id,status&limit=100`);
    const adStatuses: Record<string, ObjectIntent> = {};
    for (const ad of (ads.data as Array<Record<string, unknown>>) ?? []) {
      adStatuses[String(ad.id)] = intentStatus(ad.status as string | undefined);
    }
    return { dailyBudgetAgorot: dailyBudgetAgorot > 0 ? dailyBudgetAgorot : 0, adStatuses, adSetStatuses, campaignStatus };
  }

  async setDailyBudget(metaCampaignId: string, agorot: number): Promise<void> {
    const objId = this.budgetObj.get(metaCampaignId) ?? metaCampaignId;
    await this.post(objId, { daily_budget: String(agorot) });
  }

  async pauseAd(adId: string): Promise<void> {
    await this.setAdStatus(adId, "PAUSED");
  }

  async pauseAdSet(adSetId: string): Promise<void> {
    await this.setAdSetStatus(adSetId, "PAUSED");
  }

  // ── Caller-supplied status (AIC-66 manual controls) ──────────────────────
  // These two are the ONLY writes that take a status from the caller, and they
  // exist for exactly one reason: a human directly operating their own object
  // (pause/resume/archive/delete), which is not an engine proposal and has no
  // recommendation to approve. That does NOT weaken the invariants above:
  //   - create-writes still hardcode PAUSED (AIC-50) — nothing can be born live
  //   - activateCampaign/activateAdSet/activateAd still hardcode ACTIVE
  //     (AIC-53/63) — the engine/approval paths cannot pass a status
  // Anything reaching these must come from an authenticated human action that
  // is itself the authorization (see server/src/controls/manual-controls.ts).
  //
  // ARCHIVED vs DELETED: archive is recoverable and keeps history; delete is
  // permanent. The product defaults to archive and treats delete as the
  // deliberate harder option (admin-only, confirm-to-type).
  async setAdSetStatus(adSetId: string, status: ManualObjectStatus): Promise<void> {
    await this.post(adSetId, { status });
  }

  async setAdStatus(adId: string, status: ManualObjectStatus): Promise<void> {
    await this.post(adId, { status });
  }

  // Which object carries the budget for a campaign (for logging/verification).
  budgetObjectOf(metaCampaignId: string): string | undefined {
    return this.budgetObj.get(metaCampaignId);
  }

  // Per-ad-set delivery health (AIC-39): effective_status + issues_info. This is
  // the separate read that reveals "not delivering / disapproved" — invisible in
  // Insights (which just show near-zero spend).
  async getDeliveryHealth(metaCampaignId: string): Promise<AdSetHealth[]> {
    const body = await this.get(`${metaCampaignId}/adsets?fields=id,name,effective_status,issues_info&limit=100`);
    const health = ((body.data as RawAdSetDelivery[]) ?? []).map(normalizeAdSet);
    const byId = new Map(health.map((h) => [h.adSetId, h]));

    // Roll AD-level issues up to their ad set: an errored/disapproved ad makes its
    // ad set not-deliver, and the error often lives at the ad grain, not the ad set.
    // Also count each ad set's currently-delivering ads (AIC-71) — an ad-set-level
    // ACTIVE status with every individual ad paused (AIC-66's manual pause) is
    // "healthy" but shows nothing, which `deliveringAdCount` needs to catch even
    // though it's not a `isProblem` case.
    const ads = await this.get(`${metaCampaignId}/ads?fields=id,adset_id,effective_status,issues_info&limit=200`);
    for (const adRow of (ads.data as Array<{ adset_id?: string } & RawAdSetDelivery>) ?? []) {
      const parent = adRow.adset_id ? byId.get(String(adRow.adset_id)) : undefined;
      if (!parent) continue;
      const adHealth = normalizeAdSet({ id: String(adRow.id), effective_status: adRow.effective_status, issues_info: adRow.issues_info });
      if (adHealth.state === "delivering") parent.deliveringAdCount++;
      if (isProblem(parent)) continue; // ad set already flagged; still counted above
      if (isProblem(adHealth)) {
        parent.state = adHealth.state;
        parent.reason = adHealth.reason;
      }
    }
    return health;
  }

  // Per-ad creative media (AIC-73 round 2) — a nail salon's ads ARE images;
  // "almond green, french, video, pink lines" as a comma-string is the
  // weakest possible representation of visual content.
  //
  // Honesty note verified live: this campaign's ad has exactly ONE creative
  // (no asset_feed_spec, is_dynamic_creative false) — the multi-part ad NAME
  // is just a label someone typed, NOT four creatives. So this returns the
  // real assets Meta reports and the UI counts THOSE; it never infers a
  // creative count from the name.
  async getAdMedia(metaCampaignId: string): Promise<AdMedia[]> {
    const body = await this.get(
      `${metaCampaignId}/ads?fields=id,name,creative{thumbnail_url,image_url,asset_feed_spec{images,videos}}&limit=200`,
    );
    return ((body.data as RawAdMedia[]) ?? []).map(normalizeAdMedia);
  }

  // True lifetime lead count (AIC-67 follow-up, real bug fix). `date_preset=
  // maximum` is a single non-overlapping window covering the campaign's
  // entire history — verified live: it does NOT need a known campaign-start
  // date, Meta caps it to the real data range. This must NEVER be
  // reconstructed by summing insight_snapshots rows: the ingestion tick
  // stores OVERLAPPING rolling-7-day windows (today-7..today-1, shifting by
  // one day per tick), so the same real leads get counted once per
  // overlapping row — confirmed live, 1 real lead read back as "3."
  async getLifetimeLeads(metaCampaignId: string): Promise<number> {
    return (await this.getLifetimeTotals(metaCampaignId)).leads;
  }

  // Lifetime leads AND spend in one call — the "all time" range can't be
  // summed from the per-day rows (those only cover DAILY_LOOKBACK_DAYS), so
  // it reads these cached lifetime figures instead. That also keeps the daily
  // window from having to grow with campaign age.
  //
  // AIC-87: `leadEventTypes` is the SECOND independent site (besides
  // ingestion's normalizeRow) that turns raw actions into a leads count —
  // must use the same per-campaign definition, or leads_to_date silently
  // disagrees with every other number the customer sees for this campaign.
  async getLifetimeTotals(
    metaCampaignId: string,
    leadEventTypes?: readonly string[],
  ): Promise<{ leads: number; spendAgorot: number }> {
    const body = await this.get(
      `${metaCampaignId}/insights?level=campaign&fields=actions,spend&date_preset=maximum`,
    );
    const row = (body.data as Array<{ actions?: Array<{ action_type: string; value: string }>; spend?: string }>)?.[0];
    return {
      leads: extractLeads(row?.actions, leadEventTypes),
      spendAgorot: shekelToAgorot(Number(row?.spend ?? 0) || 0),
    };
  }

  // Ad-set name + targeting (AIC-37) — the separate read that lets us derive a
  // human audience label ("18–35" vs "35–45") instead of ever showing a raw
  // ad-set name or "ad set N". Also carries is_dynamic_creative (AIC-36), so
  // the rules can skip the creative comparison for an ad set running Meta's
  // Dynamic/Advantage+ creative. Cached by the caller (ad_set_meta); not read
  // at customer render time.
  async getAdSetMeta(metaCampaignId: string): Promise<AdSetMeta[]> {
    const body = await this.get(
      // age_range is REQUIRED, not optional: age_min/age_max report the
      // Advantage+ expansion ceiling, not the configured range (AIC-73).
      `${metaCampaignId}/adsets?fields=id,name,is_dynamic_creative,effective_status,targeting{age_min,age_max,age_range,genders,geo_locations},ads.limit(1){id}&limit=100`,
    );
    // Root-caused live (AIC-65, 2026-08-12): Meta OMITS the `ads` connection
    // field entirely when it's genuinely empty, rather than returning
    // {data: []} — confirmed on GelNails' real dead ad set. normalizeAdSetMeta
    // deliberately treats an absent `ads` field as "unknown, don't penalize"
    // (so callers who didn't request the field never get a false exclusion) —
    // but THIS query always requests it, so here absence really does mean
    // zero. Fill in the confirmed-empty default before normalizing.
    const rows = ((body.data as RawAdSetMeta[]) ?? []).map((r) => ({ ...r, ads: r.ads ?? { data: [] } }));
    return rows.map(normalizeAdSetMeta);
  }

  // AIC-88: the ad sets' tracking configuration — what Meta is actually
  // optimizing for. Deliberately its OWN read rather than widening
  // getAdSetMeta: that one's result is cached into ad_set_meta for the
  // customer-facing audience labels, and these fields have nothing to do with
  // labelling. Read-only; a failure surfaces as `unknown`, never as "broken".
  async getAdSetTracking(metaCampaignId: string): Promise<AdSetTrackingConfig[]> {
    const body = await this.get(
      `${metaCampaignId}/adsets?fields=id,name,optimization_goal,destination_type,promoted_object&limit=100`,
    );
    type Raw = {
      id: string;
      name?: string;
      optimization_goal?: string;
      destination_type?: string;
      promoted_object?: { pixel_id?: string; custom_event_type?: string };
    };
    return ((body.data as Raw[]) ?? []).map((r) => ({
      adSetId: String(r.id),
      name: r.name ?? null,
      optimizationGoal: r.optimization_goal ?? null,
      destinationType: r.destination_type ?? null,
      pixelId: r.promoted_object?.pixel_id ?? null,
      customEventType: r.promoted_object?.custom_event_type ?? null,
    }));
  }

  // AIC-105 Branch B — every ad account the System User can currently manage
  // (both AIC-101 access layers already passed), for the operator to pick
  // from instead of retyping the "act_…" number from Meta's own screen.
  async listAdAccounts(): Promise<AdAccountOption[]> {
    const body = await this.get(`me/adaccounts?fields=id,name,currency,account_status&limit=200`);
    type Raw = { id: string; name?: string; currency?: string; account_status?: number };
    return ((body.data as Raw[]) ?? []).map((a) => ({
      id: String(a.id),
      name: a.name ? String(a.name) : String(a.id),
      currency: a.currency ? String(a.currency) : "ILS",
      accountStatus: typeof a.account_status === "number" ? a.account_status : null,
    }));
  }

  // Pages this ONE ad account can promote — the Page-side sibling of
  // listAdAccounts, scoped to the picked account.
  //
  // NOT `me/accounts`: that lists every Page the System User can manage
  // across all customers, so the picker offered another customer's Page
  // while this customer's ad account was selected (found live). Meta answers
  // the actually-useful question on `promote_pages` — verified live
  // 2026-08-18: act_2181076988590009 → the Pisga Page;
  // act_1573023157816786 → [].
  async listPages(adAccountId: string): Promise<PageOption[]> {
    type RawPage = { id: string; name?: string; business?: { id?: string } };
    const opt = (p: RawPage) => ({ id: String(p.id), name: p.name ? String(p.name) : String(p.id) });

    // Pages the System User can actually manage (layer 2 passed), narrowed to
    // the business that owns THIS ad account — an account can only advertise
    // for Pages its own business holds.
    //
    // Two wrong turns got us here, both caught live:
    //  1. `me/accounts` alone — every Page across ALL customers, so the
    //     picker offered one customer's Page while another's account was
    //     selected.
    //  2. `{account}/promote_pages` alone — correctly scoped, but it only
    //     lists Pages the account has ALREADY advertised through, so it is
    //     empty for every brand-new account. That is exactly the Branch A
    //     "create the first campaign" case, i.e. broken where it matters most
    //     (act_1573023157816786: 0 ads → [] even after its Page was assigned).
    // The union below keeps promote_pages' answer for established accounts
    // (it also covers a Page shared in from outside the owning business,
    // which the business filter alone would miss) and adds the same-business
    // Pages a new account needs.
    const acct = await this.get(`${adAccountId}?fields=business`);
    const businessId = (acct.business as { id?: string } | undefined)?.id ?? null;

    const [manageable, promotable] = await Promise.all([
      this.get(`me/accounts?fields=id,name,business&limit=200`)
        .then((b) => ((b.data as RawPage[]) ?? [])).catch(() => [] as RawPage[]),
      this.get(`${adAccountId}/promote_pages?fields=id,name&limit=200`)
        .then((b) => ((b.data as RawPage[]) ?? [])).catch(() => [] as RawPage[]),
    ]);

    const sameBusiness = businessId
      ? manageable.filter((p) => p.business?.id && String(p.business.id) === businessId)
      : [];
    const byId = new Map<string, PageOption>();
    for (const p of [...sameBusiness, ...promotable]) byId.set(String(p.id), opt(p));
    return [...byId.values()];
  }

  // Every campaign under one ad account, destination DETECTED per campaign
  // (detectDestination, over the same getAdSetTracking read AIC-88 already
  // trusts) rather than asked — so adopting a campaign can never disagree
  // with what the ongoing tracking-health check will judge once it's
  // connected. One extra read per campaign (its ad sets); fine for an
  // operator-triggered, low-frequency admin action, not a hot path.
  async listCampaigns(adAccountId: string): Promise<DiscoveredCampaign[]> {
    const body = await this.get(
      `${adAccountId}/campaigns?fields=id,name,status,effective_status,objective,daily_budget&limit=200`,
    );
    type Raw = {
      id: string;
      name?: string;
      status?: string;
      effective_status?: string;
      objective?: string;
      daily_budget?: string;
    };
    const rows = (body.data as Raw[]) ?? [];
    const out: DiscoveredCampaign[] = [];
    for (const r of rows) {
      const metaCampaignId = String(r.id);
      const tracking = await this.getAdSetTracking(metaCampaignId);
      out.push({
        id: metaCampaignId,
        name: r.name ? String(r.name) : metaCampaignId,
        status: r.status ?? "UNKNOWN",
        effectiveStatus: r.effective_status ?? r.status ?? "UNKNOWN",
        objective: r.objective ?? null,
        dailyBudgetAgorot: r.daily_budget != null ? Number(r.daily_budget) : null,
        destination: detectDestination(tracking),
      });
    }
    return out;
  }

  // The host a pixel actually fires on — the confirming half of the launch
  // gate's "where do my leads come from" row (AIC-89 slice). Read-only.
  //
  // Deliberately the PIXEL's host, not the ad's link URL: an externally-created
  // ad exposes no destination through the creative (verified live — every URL
  // field comes back empty for an ad we didn't build), and more importantly
  // the customer needs to know where the action that COUNTS as a lead happens,
  // which can differ from where the ad click lands.
  //
  // Returns the highest-volume host, or null when the pixel has no recent
  // traffic. Null degrades the row to the action name alone; it never blocks
  // launch, because the action is the load-bearing fact and the domain is
  // context. NOTE: `/stats` is capped at a rolling ~28-day window and silently
  // ignores an older `start_time` — fine here (we want "currently"), but it is
  // why this endpoint must never be used for historical reconciliation.
  async getPixelTopHost(pixelId: string): Promise<string | null> {
    const body = await this.get(`${pixelId}/stats?aggregation=host`);
    const totals = new Map<string, number>();
    for (const bucket of (body.data as Array<Record<string, unknown>>) ?? []) {
      for (const e of (bucket.data as Array<Record<string, unknown>>) ?? []) {
        const host = String(e.value ?? "");
        if (!host) continue;
        totals.set(host, (totals.get(host) ?? 0) + Number(e.count ?? 0));
      }
    }
    let top: string | null = null;
    let best = 0;
    for (const [host, count] of totals) {
      if (count > best) { top = host; best = count; }
    }
    return top;
  }

  // AIC-89 — the website-destination builder step's Pixel picker. Every
  // Pixel/dataset visible on the ad account, for the operator/customer to
  // choose from rather than typing a raw id (the AIC-87 free-text capture
  // this replaces for the CREATE path specifically).
  async listPixels(adAccountId: string): Promise<PixelOption[]> {
    const body = await this.get(`${adAccountId}/adspixels?fields=id,name`);
    return ((body.data as Array<Record<string, unknown>>) ?? []).map((p) => ({
      id: String(p.id),
      name: p.name ? String(p.name) : String(p.id),
    }));
  }

  // AIC-89's build-time guardrail: warn before creating a website campaign
  // against a Pixel that isn't actually seeing the chosen event. Adapted from
  // getPixelTopHost's proven `/stats` pattern, bucketed by event name instead
  // of host. Field-shape confidence note: `aggregation=host` above is
  // live-verified; `aggregation=event` is this adapter's best-effort reading
  // of the same edge, not yet confirmed against a real Pixel with real
  // events — treat the first live check as the real verification.
  //
  // Returns `hasRecentEvents: null` (never a confident `false`) on any read
  // failure or an unparseable response — the same "never a confident denial
  // from an ambiguous read" discipline as AccessProbe (AIC-101): a network
  // hiccup must never tell an operator a healthy Pixel is dead.
  async checkPixelEventRecency(pixelId: string, eventName: string): Promise<PixelRecencyCheck> {
    try {
      const body = await this.get(`${pixelId}/stats?aggregation=event`);
      let total = 0;
      let sawEvent = false;
      for (const bucket of (body.data as Array<Record<string, unknown>>) ?? []) {
        for (const e of (bucket.data as Array<Record<string, unknown>>) ?? []) {
          if (String(e.value ?? "") !== eventName) continue;
          sawEvent = true;
          total += Number(e.count ?? 0);
        }
      }
      // The event bucket never appearing at all is a different, weaker signal
      // than appearing with a real zero — both read as "no recent events" for
      // this warning's purpose, but only a genuine response (not a thrown
      // error) earns a definite answer either way.
      return { hasRecentEvents: sawEvent ? total > 0 : false };
    } catch {
      return { hasRecentEvents: null };
    }
  }

  // ── Create-writes (AIC-50, the builder) ────────────────────────────────────
  // Every create is status=PAUSED — the builder NEVER produces a live, spending
  // object directly (the hard rule this ticket exists to enforce). Activation
  // is a separate, approved write (AIC-53), never something a create call does.
  //
  // Field-shape confidence note: campaign create (name/objective/status/budget/
  // special_ad_categories) mirrors the same fields already read+written
  // elsewhere in this file, so those are well-verified. The ad-set WhatsApp-
  // destination fields (optimization_goal/destination_type/promoted_object)
  // are this adapter's best-effort reading of Meta's Click-to-WhatsApp API —
  // NOT yet live-verified the way setDailyBudget/pauseAdSet were (AIC-1/36
  // dogfood). Treat the first live create-write test on an account we control
  // as the real verification of this specific shape, not this code review.

  async createCampaign(params: CreateCampaignParams): Promise<string> {
    // AIC-107: sourced from the destination shape, never an inline literal —
    // the inline "OUTCOME_LEADS" here is what would have created an
    // engagement campaign as a Leads campaign on Meta.
    const { objective } = resolveDestinationShape(params.destination);
    return this.postCreate(params.adAccountId, "campaigns", {
      name: params.name,
      objective,
      status: "PAUSED",
      buying_type: "AUCTION",
      special_ad_categories: params.specialAdCategories,
      daily_budget: String(params.dailyBudgetAgorot),
      bid_strategy: params.bidStrategy,
    });
  }

  // Meta creates ad sets on the AD ACCOUNT's edge (not the campaign's) — the
  // parent is identified by campaign_id IN the body, same pattern as createAd.
  async createAdSet(params: CreateAdSetParams): Promise<string> {
    // Throws for anything not yet supported rather than silently defaulting
    // to the WhatsApp shape — the specific defect this replaces.
    const shape = resolveDestinationShape(params.destination);
    // AIC-89: promoted_object shape follows the destination, same as the
    // creative's CTA shape (createCreativeFromUpload). Field-shape confidence
    // note: page_id/WhatsApp was live-verified against a real create; the
    // pixel_id/custom_event_type pair below is this adapter's best-effort
    // reading of Meta's OFFSITE_CONVERSIONS API, matching the real shape
    // observed on Pisga's own free_beta_signups_leads campaign
    // (promoted_object: { pixel_id, custom_event_type: COMPLETE_REGISTRATION })
    // — treat the first live create-write on an account we control as the
    // real verification, not this code review.
    const promotedObject =
      shape.destinationType === "WEBSITE"
        ? { pixel_id: params.pixelId, custom_event_type: params.conversionEvent }
        : { page_id: params.pageId };
    return this.postCreate(params.adAccountId, "adsets", {
      name: params.name,
      campaign_id: params.metaCampaignId,
      status: "PAUSED",
      billing_event: "IMPRESSIONS",
      optimization_goal: shape.optimizationGoal,
      destination_type: shape.destinationType,
      promoted_object: promotedObject,
      targeting: {
        age_min: params.targeting.ageMin,
        age_max: params.targeting.ageMax,
        genders: params.targeting.genders,
        geo_locations: { countries: params.targeting.countries },
      },
    });
  }

  async createAd(params: CreateAdParams): Promise<string> {
    return this.postCreate(params.adAccountId, "ads", {
      name: params.name,
      adset_id: params.metaAdSetId,
      status: "PAUSED",
      creative: { creative_id: params.creativeId },
    });
  }

  // ── Creative handling (AIC-51) ─────────────────────────────────────────────
  // Field-shape confidence note (same caveat as the create-writes above): the
  // WhatsApp call-to-action shape on an upload-based creative is this
  // adapter's best-effort reading of Meta's Click-to-WhatsApp API, not yet
  // live-verified. createCreativeFromExistingPost's object_story_id shape is
  // the well-established, simpler path (no destination fields to get wrong).

  async uploadImage(adAccountId: string, fileBuffer: Buffer, filename: string): Promise<UploadedImage> {
    const body = new URLSearchParams({ bytes: fileBuffer.toString("base64") });
    const r = await fetch(`${BASE}/${this.ver}/${adAccountId}/adimages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const json = (await r.json().catch(() => ({}))) as { images?: Record<string, { hash?: string; url?: string }>; error?: unknown };
    const entry = json.images ? Object.values(json.images)[0] : undefined;
    if (!r.ok || !entry?.hash) {
      throw new Error(`POST ${adAccountId}/adimages → ${r.status} ${JSON.stringify(json.error ?? json)}`);
    }
    return { hash: entry.hash, url: entry.url ?? "" };
  }

  // Uploads via multipart (native FormData/Blob — no extra dependency), then
  // polls (bounded) for Meta to finish processing so a thumbnail exists — a
  // video creative can't be created without one.
  async uploadVideo(adAccountId: string, fileBuffer: Buffer, filename: string): Promise<UploadedVideo> {
    const form = new FormData();
    form.set("source", new Blob([new Uint8Array(fileBuffer)]), filename);
    const r = await fetch(`${BASE}/${this.ver}/${adAccountId}/advideos`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}` },
      body: form,
    });
    const json = (await r.json().catch(() => ({}))) as { id?: string; error?: unknown };
    if (!r.ok || !json.id) {
      throw new Error(`POST ${adAccountId}/advideos → ${r.status} ${JSON.stringify(json.error ?? json)}`);
    }
    const videoId = json.id;

    const POLL_ATTEMPTS = 10;
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
      const status = await this.get(`${videoId}?fields=status,picture`);
      const videoStatus = (status.status as { video_status?: string } | undefined)?.video_status;
      if (videoStatus === "ready" && status.picture) {
        return { videoId, thumbnailUrl: String(status.picture) };
      }
      if (videoStatus === "error") {
        throw new Error(`video ${videoId} failed processing on Meta's side`);
      }
      await new Promise((resolve) => setTimeout(resolve, this.videoPollDelayMs));
    }
    throw new Error(`video ${videoId} did not finish processing within ${(POLL_ATTEMPTS * this.videoPollDelayMs) / 1000}s`);
  }

  // The Page's own access token, required for every Page-content edge. Verified
  // live 2026-08-12: Meta rejects the System User token on `/{page}/posts` with
  // "A Page access token is required for this call for the new Pages
  // experience" (code 190/subcode 2069032). The Page must be assigned to this
  // System User for `/me/accounts` to include it — see docs/META_SETUP.md's
  // three-layers-of-access section.
  private async pageAccessToken(pageId: string): Promise<string> {
    const body = await this.get(`me/accounts?fields=id,access_token&limit=200`);
    const rows = (body.data as Array<{ id?: string; access_token?: string }>) ?? [];
    const match = rows.find((r) => String(r.id) === pageId);
    if (!match?.access_token) {
      throw new Error(
        `no Page access token for ${pageId} — the Page is not assigned to this System User (see docs/META_SETUP.md)`,
      );
    }
    return match.access_token;
  }

  async listPromotablePosts(pageId: string): Promise<PromotablePost[]> {
    // NOT `/promotable_posts` — that edge does not exist (verified live: "(#100)
    // Tried accessing nonexisting field (promotable_posts)" with BOTH a System
    // User and a Page token). `/posts` is the real edge, and it needs the Page's
    // own token.
    const pageToken = await this.pageAccessToken(pageId);
    const body = await this.get(
      `${pageId}/posts?fields=id,message,full_picture,created_time&limit=25`,
      pageToken,
    );
    // Found live 2026-08-17: a Page's own /posts edge returns `id` ALREADY in
    // Meta's compound "{page-id}_{post-id}" story-id form, not the post's bare
    // id. createCreativeFromExistingPost re-prefixes pageId onto whatever we
    // hand it as postId, so passing the compound id straight through doubled
    // the prefix — Meta rejected the malformed object_story_id with
    // "(#100) Invalid post_id parameter", surfaced to the customer as a raw
    // 502. Stripping the known prefix here keeps `id` meaning "the post's own
    // id" everywhere downstream, matching what createCreativeFromExistingPost
    // (and its test) already assume.
    const prefix = `${pageId}_`;
    return ((body.data as Array<Record<string, unknown>>) ?? []).map((p) => {
      const raw = String(p.id);
      return {
        id: raw.startsWith(prefix) ? raw.slice(prefix.length) : raw,
        message: p.message ? String(p.message) : null,
        pictureUrl: p.full_picture ? String(p.full_picture) : null,
        createdAt: String(p.created_time ?? ""),
      };
    });
  }

  async createCreativeFromUpload(params: CreateUploadCreativeParams): Promise<string> {
    const shape = resolveDestinationShape(params.destination);
    // AIC-107: an engagement campaign has no CTA of ours to impose — it
    // promotes an existing Page post, whose own CTA stands. This upload path
    // builds a link_data creative around a call_to_action, so it cannot
    // serve that type; refusing loudly here beats sending Meta
    // `call_to_action: { type: null }` and getting a confusing 400 (or worse,
    // a creative that silently misrepresents the destination).
    if (!shape.ctaType) {
      throw new Error(
        `destination '${params.destination}' has no call-to-action shape — ` +
          `use the existing-post creative path instead of an upload`,
      );
    }
    const linkData: Record<string, unknown> =
      params.media.kind === "image"
        ? { image_hash: params.media.imageHash }
        : { video_id: params.media.videoId, image_url: params.media.thumbnailUrl };
    // AIC-102: the WhatsApp shape's call_to_action.value carries a phone
    // number; the website shape's carries the destination link instead, and
    // link_data itself needs the same link at the top level (the field Meta
    // actually navigates to on click — the CTA's `link` value mirrors it).
    const callToAction =
      shape.destinationType === "WEBSITE"
        ? { type: shape.ctaType, value: { link: params.destinationUrl } }
        : { type: shape.ctaType, value: { whatsapp_number: params.whatsappNumber } };
    return this.postCreate(params.adAccountId, "adcreatives", {
      name: params.name,
      object_story_spec: {
        page_id: params.pageId,
        link_data: {
          ...linkData,
          ...(shape.destinationType === "WEBSITE" ? { link: params.destinationUrl } : {}),
          message: params.primaryText,
          name: params.headline,
          call_to_action: callToAction,
        },
      },
    });
  }

  async createCreativeFromExistingPost(params: CreatePostCreativeParams): Promise<string> {
    return this.postCreate(params.adAccountId, "adcreatives", {
      name: params.name,
      object_story_id: `${params.pageId}_${params.postId}`,
    });
  }

  // ── Launch gate (AIC-53) ────────────────────────────────────────────────
  // activateCampaign is the ONLY write in this whole adapter that can set a
  // campaign ACTIVE — status is hardcoded, never a caller-supplied value,
  // mirroring the create-writes' "always PAUSED" invariant in reverse.

  // ── Configured status vs effective status ───────────────────────────────
  // These three readers back every read-back VERIFICATION in the codebase
  // (activateCampaign, approveAddition's activateOne, manual controls), so
  // they must return the object's OWN configured `status` — not
  // `effective_status`, which is a COMPUTED field. Two ways that bit us:
  //
  //  1. Read-after-write lag. Verified live 2026-08-12: a real customer paused
  //     a real ad, Meta applied it, but `effective_status` still read ACTIVE
  //     moments later — so verification failed and the app told the customer
  //     the change hadn't worked when it had. `status` updates immediately.
  //  2. Parent state leaks in. An ad inside a paused ad set reports
  //     `effective_status: ADSET_PAUSED` (and CAMPAIGN_PAUSED, WITH_ISSUES,
  //     DISAPPROVED exist too), so verifying "did my ACTIVE write land" against
  //     it would false-fail forever, even at rest.
  //
  // `effective_status` remains the right field for "is this actually
  // delivering" — that's delivery-health's question (AIC-39), not this one.
  private async configuredStatus(id: string): Promise<MetaCampaignStatus> {
    const r = await this.get(`${id}?fields=status,effective_status`);
    return String(r.status ?? r.effective_status ?? "");
  }

  async getCampaignStatus(metaCampaignId: string): Promise<MetaCampaignStatus> {
    return this.configuredStatus(metaCampaignId);
  }

  async activateCampaign(metaCampaignId: string): Promise<void> {
    await this.post(metaCampaignId, { status: "ACTIVE" });
  }

  // ── Add to an existing campaign (AIC-63) ────────────────────────────────
  // Same "no caller-supplied status" pattern as activateCampaign — these are
  // the only two writes that can set an ad set / ad ACTIVE.

  async getAdSetStatus(adSetId: string): Promise<MetaCampaignStatus> {
    return this.configuredStatus(adSetId);
  }

  async getAdStatus(adId: string): Promise<MetaCampaignStatus> {
    return this.configuredStatus(adId);
  }

  async activateAdSet(adSetId: string): Promise<void> {
    await this.setAdSetStatus(adSetId, "ACTIVE");
  }

  async activateAd(adId: string): Promise<void> {
    await this.post(adId, { status: "ACTIVE" });
  }
}
