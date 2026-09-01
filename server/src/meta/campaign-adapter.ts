import type { LiveCampaignState, MetaReader, ExecWriter } from "../execution/safe-executor.js";
import { normalizeAdSet, isProblem, type AdSetHealth, type DeliveryReader, type RawAdSetDelivery } from "./delivery-health.js";
import { normalizeAdSetMeta, type AdSetMeta, type RawAdSetMeta } from "./audience-label.js";
import { normalizeAdDetail, type AdDetail, type RawAdDetail } from "./ad-detail.js";
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

// AIC-105's "Meta API failure" error category — built against a REAL live
// case (2026-08-19: a customer's WhatsApp campaign build refused with a
// clear, actionable Meta message that the generic Error(string) below was
// throwing away). Carries Meta's own error_user_title/error_user_msg
// STRUCTURALLY, so a caller (the build routes) can surface exactly what
// Meta told the operator instead of a dead-end "failed to build campaign".
//
// Deliberately narrow: only extracts the fields Meta already provides in
// plain, operator-readable form. Does NOT attempt AIC-105's full four-
// category translation table (Meta-code → Hebrew symptom-table lookup) —
// that is real, larger, separate work, still not done.
/**
 * Meta's per-ad-account throttle (AIC-160). Its own constant because the
 * number is the ONLY thing separating "wait a minute" from "something is
 * broken", and the two need opposite responses from an operator.
 */
export const META_RATE_LIMIT_CODE = 17;

export class GraphWriteError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: number | null,
    public readonly subcode: number | null,
    public readonly isTransient: boolean,
    // Meta's own operator-facing strings, when it provides them (it does
    // not always — see the second test case). null means "nothing to
    // surface beyond the generic message", not "Meta had nothing to say".
    public readonly userTitle: string | null,
    public readonly userMessage: string | null,
  ) {
    super(message);
    this.name = "GraphWriteError";
  }
}

interface GraphErrorBody {
  message?: string;
  code?: number;
  error_subcode?: number;
  is_transient?: boolean;
  error_user_title?: string;
  error_user_msg?: string;
}

// Shared by every write path (post/postCreate/adimages/advideos): builds
// the RIGHT error type from a failed Graph response. GraphWriteError only
// when Meta gave BOTH title and message — a partial pair is not something
// an operator could act on, so it falls through to the plain Error exactly
// as before this change (unchanged behaviour for every case this file
// hasn't seen live yet).
function graphError(context: string, status: number, body: Record<string, unknown>): Error {
  const err = (body.error ?? body) as GraphErrorBody;
  const message = `${context} → ${status} ${JSON.stringify(err)}`;
  if (err.error_user_title && err.error_user_msg) {
    return new GraphWriteError(
      message, status,
      err.code ?? null, err.error_subcode ?? null, err.is_transient ?? false,
      err.error_user_title, err.error_user_msg,
    );
  }
  return new Error(message);
}
import { shekelToAgorot, resolveDestinationShape, ADVANTAGE_AUDIENCE_ENABLED, FIXED_CTA } from "@aic/shared";
import { extractLeads } from "./insights.js";
import type { RawAdMetaRow } from "./ad-meta-types.js";
import { normalizeAdMedia, type AdMedia, type AdMediaReader, type RawAdMedia } from "./ad-media.js";
import { detectDestination, type AdSetTrackingConfig, type TrackingReader } from "./tracking-health.js";
import type { AdCreativeDestination, CtaReader } from "./cta-health.js";
import type { AdAccountHealth, AccountHealthReader } from "./account-health.js";
import type { EventDayCount, EventVolumeReader } from "./event-volume.js";
import type { AdAccountOption, PageOption, InstagramOption, DiscoveredCampaign, CampaignDiscoveryReader } from "./campaign-discovery.js";

// Real Meta reader+writer backing the safe-execute pipeline (AIC-12) against the
// Marketing API. Budgets are read/written in the account currency's MINOR unit,
// which for ILS is agorot — matching our integer-agorot model directly.
//
// A campaign's budget may live at campaign level (CBO) or ad-set level; this
// adapter resolves the budget-bearing object on read and writes back to the same
// one, so setDailyBudget targets the right object.
const BASE = "https://graph.facebook.com";

/**
 * AIC-170 — the ONLY link Meta accepts on a click-to-WhatsApp CTA built from
 * Instagram media. A wa.me deep link is refused ("Please remove parameter
 * link…"), and that refusal is what AIC-166 misread as the combination being
 * impossible. Named, so nobody re-derives it from a phone number again.
 */
const WHATSAPP_CANONICAL_LINK = "https://api.whatsapp.com/send";

/**
 * The ad-set fields destination detection reads. Shared (AIC-160) between
 * `getAdSetTracking`, which fetches them per campaign, and `listCampaigns`,
 * which now gets them nested inside ONE campaigns call — so the two cannot
 * drift into detecting different destinations from the same ad set.
 */
interface RawAdSetTracking {
  id: string;
  name?: string;
  optimization_goal?: string;
  destination_type?: string;
  promoted_object?: { pixel_id?: string; custom_event_type?: string };
}

function normalizeAdSetTracking(r: RawAdSetTracking): AdSetTrackingConfig {
  return {
    adSetId: String(r.id),
    name: r.name ?? null,
    optimizationGoal: r.optimization_goal ?? null,
    destinationType: r.destination_type ?? null,
    pixelId: r.promoted_object?.pixel_id ?? null,
    customEventType: r.promoted_object?.custom_event_type ?? null,
  };
}

export interface GeoLocationOption {
  key: string;
  name: string;
  type: "city" | "region";
  region: string | null;
}

/**
 * AIC-157 — cities/regions if any were chosen, otherwise the country.
 *
 * Never both: Meta unions the fields inside geo_locations, so a payload
 * carrying cities AND countries targets the cities plus the whole country —
 * the nationwide spend the picker exists to prevent, wearing the appearance
 * of a narrowed audience.
 */
export function geoLocations(t: { countries: string[]; cities?: Array<{ key: string; type: "city" | "region" }> }): Record<string, unknown> {
  const cities = (t.cities ?? []).filter((c) => c.type === "city").map((c) => ({ key: c.key }));
  const regions = (t.cities ?? []).filter((c) => c.type === "region").map((c) => ({ key: c.key }));
  if (cities.length === 0 && regions.length === 0) return { countries: t.countries };
  return {
    ...(cities.length ? { cities } : {}),
    ...(regions.length ? { regions } : {}),
  };
}

export class GraphCampaignAdapter implements MetaReader, ExecWriter, DeliveryReader, BuilderWriter, CreativeWriter, LaunchWriter, AdditionWriter, ControlWriter, AdMediaReader, TrackingReader, CtaReader, AccountHealthReader, EventVolumeReader, CampaignDiscoveryReader {
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
    if (!r.ok) throw graphError(`POST ${id}`, r.status, body);
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
      throw graphError(`POST ${parentId}/${edge}`, r.status, json);
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

    // AIC-169: adset_id rides along on the read we were already making, so a
    // consumer can resolve "does this ad set have a live ad" from LIVE data
    // instead of from whichever ads happen to have rows in a date window.
    const ads = await this.get(`${metaCampaignId}/ads?fields=id,status,adset_id&limit=100`);
    const adStatuses: Record<string, ObjectIntent> = {};
    const adSetByAd: Record<string, string> = {};
    for (const ad of (ads.data as Array<Record<string, unknown>>) ?? []) {
      adStatuses[String(ad.id)] = intentStatus(ad.status as string | undefined);
      if (ad.adset_id) adSetByAd[String(ad.id)] = String(ad.adset_id);
    }
    return { dailyBudgetAgorot: dailyBudgetAgorot > 0 ? dailyBudgetAgorot : 0, adStatuses, adSetStatuses, adSetByAd, campaignStatus };
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
  // Rollback (user decision, 2026-08-19). Meta's DELETE /{id} is the same call
  // for a campaign, an ad set and an ad, so one method covers all three.
  //
  // Only ever called by the builder's rollback path, on objects THAT SAME
  // ATTEMPT just created — never on anything pre-existing. That scoping is
  // what makes a hard delete (rather than the product's usual archive
  // default, see the note above) the right call here: these objects have
  // existed for seconds, carry no history worth keeping, and their entire
  // reason for existing was a build that did not complete.
  async deleteObject(metaId: string): Promise<void> {
    const r = await fetch(`${BASE}/${this.ver}/${metaId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!r.ok) {
      const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      throw graphError(`DELETE ${metaId}`, r.status, body);
    }
  }

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

  // Every ad in a campaign, with the fields the per-ad cache needs. A separate
  // call from getDeliveryHealth (which reads ads too, but discards name and
  // rolls everything up to the ad set) so that function's contract is
  // untouched — one extra Graph call per campaign per tick.
  //
  // `effective_status` is the field that matters here: it is where
  // PENDING_REVIEW and DISAPPROVED live, and an ad in either has no Insights
  // data at all — which is exactly why the customer's per-ad list could not
  // see an ad they had just created.
  async listAds(metaCampaignId: string): Promise<RawAdMetaRow[]> {
    const body = await this.get(
      `${metaCampaignId}/ads?fields=id,name,adset_id,effective_status,created_time&limit=200`,
    );
    return ((body.data as Array<Record<string, unknown>>) ?? []).map((a) => ({
      adId: String(a.id),
      adSetId: a.adset_id ? String(a.adset_id) : "",
      name: a.name ? String(a.name) : null,
      // Never defaulted to ACTIVE — an absent status is unknown, and
      // classifyAdState renders it as such rather than claiming delivery.
      effectiveStatus: a.effective_status ? String(a.effective_status) : "",
      createdTime: a.created_time ? String(a.created_time) : null,
    }));
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
      `${metaCampaignId}/adsets?fields=id,name,is_dynamic_creative,effective_status,promoted_object,targeting{age_min,age_max,age_range,genders,geo_locations},ads.limit(1){id}&limit=100`,
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
    return ((body.data as RawAdSetTracking[]) ?? []).map(normalizeAdSetTracking);
  }

  // AIC-128: each ad's creative destination, joined to its ad set's promise.
  // Two reads because Meta will not nest ad-set fields under /ads: the ad set
  // list gives destination_type, the ad list gives each creative's actual
  // call_to_action. Comparing them is the whole check.
  //
  // `call_to_action{type,value}` is requested explicitly rather than relying on
  // `call_to_action_type` — that scalar is DERIVED by Meta from the ad set and
  // reads WHATSAPP_MESSAGE even when the creative carries no number, which is
  // exactly the failure this check exists to catch. Only the nested `value`
  // proves a real destination.
  async getAdCreativeDestinations(metaCampaignId: string): Promise<AdCreativeDestination[]> {
    const adsetBody = await this.get(
      `${metaCampaignId}/adsets?fields=id,destination_type&limit=100`,
    );
    const destByAdSet = new Map<string, string | null>(
      (((adsetBody.data as Array<{ id: string; destination_type?: string }>) ?? [])).map((r) => [
        String(r.id),
        r.destination_type ?? null,
      ]),
    );

    const adsBody = await this.get(
      `${metaCampaignId}/ads?fields=id,name,adset_id,effective_status,creative{call_to_action}&limit=200`,
    );
    type RawAd = {
      id: string;
      name?: string;
      adset_id?: string;
      effective_status?: string;
      creative?: {
        call_to_action?: {
          type?: string;
          // AIC-166: app_destination is Meta's shape for an adopted WhatsApp
          // ad's button. Not reading it made every one of them look broken.
          value?: { whatsapp_number?: string; link?: string; app_destination?: string };
        };
      };
    };
    return (((adsBody.data as RawAd[]) ?? [])).map((a) => {
      const cta = a.creative?.call_to_action;
      const adSetId = String(a.adset_id ?? "");
      return {
        adId: String(a.id),
        adName: a.name ?? null,
        adSetId,
        destinationType: destByAdSet.get(adSetId) ?? null,
        effectiveStatus: a.effective_status ?? null,
        ctaType: cta?.type ?? null,
        whatsappNumber: cta?.value?.whatsapp_number ?? null,
        link: cta?.value?.link ?? null,
        appDestination: cta?.value?.app_destination ?? null,
      };
    });
  }

  // AIC-72: can this AD ACCOUNT actually spend? Every object-level check can be
  // green while the account is disabled, unsettled, in risk review, or simply
  // has no card — and then nothing delivers and Insights just go quiet.
  //
  // `funding_source_details` is requested rather than the bare `funding_source`
  // id: an account with no payment method omits the object entirely, which is
  // the signal, and the display string ("Mastercard *1459") is what lets an
  // operator tell the customer WHICH card to fix.
  async getAdAccountHealth(metaAdAccountId: string): Promise<AdAccountHealth> {
    const body = await this.get(
      `${metaAdAccountId}?fields=id,name,account_status,disable_reason,funding_source_details`,
    );
    const funding = body.funding_source_details as { display_string?: string } | undefined;
    return {
      adAccountId: String(body.id ?? metaAdAccountId),
      name: (body.name as string) ?? null,
      accountStatus: typeof body.account_status === "number" ? body.account_status : null,
      disableReason: typeof body.disable_reason === "number" ? body.disable_reason : null,
      hasFundingSource: !!funding,
      fundingSourceLabel: funding?.display_string ?? null,
    };
  }

  // AIC-91: per-event daily counts for a pixel.
  //
  // `/stats?aggregation=event` returns buckets that are finer than a day and
  // repeat an event within one — the live pixel returns several buckets per
  // date — so counts are summed per (day, event) rather than taken as given.
  // Reading one bucket as a day's total would under-report and make a healthy
  // pixel look like it had stopped.
  async getPixelEventCounts(pixelId: string, sinceUnix: number): Promise<EventDayCount[]> {
    const body = await this.get(`${pixelId}/stats?aggregation=event&start_time=${sinceUnix}`);
    type Bucket = { start_time?: string; data?: Array<{ value?: string; count?: number | string }> };
    const totals = new Map<string, number>();
    for (const b of ((body.data as Bucket[]) ?? [])) {
      const day = String(b.start_time ?? "").slice(0, 10);
      if (!day) continue;
      for (const e of b.data ?? []) {
        const event = String(e.value ?? "");
        if (!event) continue;
        const key = `${day}\u0000${event}`;
        totals.set(key, (totals.get(key) ?? 0) + Number(e.count ?? 0));
      }
    }
    return [...totals.entries()]
      .map(([key, count]) => {
        const [day, event] = key.split("\u0000");
        return { day, event, count };
      })
      .sort((a, b) => a.day.localeCompare(b.day));
  }

  // AIC-92 signal B: which event SOURCES this pixel receives. BROWSER + SERVER
  // together means CAPI is running alongside the browser pixel, which is where
  // deduplication failures happen. Contextual only — it never raises an alarm
  // by itself (see summarizeOvercount), it explains one.
  async getPixelEventSources(pixelId: string, sinceUnix: number): Promise<{ browser: boolean; server: boolean }> {
    const body = await this.get(`${pixelId}/stats?aggregation=event_source&start_time=${sinceUnix}`);
    type Bucket = { data?: Array<{ value?: string; count?: number | string }> };
    let browser = false, server = false;
    for (const b of ((body.data as Bucket[]) ?? [])) {
      for (const e of b.data ?? []) {
        const v = String(e.value ?? "").toUpperCase();
        if (Number(e.count ?? 0) <= 0) continue;
        if (v === "BROWSER") browser = true;
        // Meta labels server-side events several ways depending on integration.
        else if (v === "SERVER" || v === "APP" || v.includes("SERVER")) server = true;
      }
    }
    return { browser, server };
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

  /*
   * Instagram accounts usable with this ad account.
   *
   * TWO SOURCES, because Meta has two different links and only one of them is
   * the modern one:
   *
   *   1. `{ad_account}/instagram_accounts` — the older, account-level link.
   *      Real (act_1573023157816786 returns @ads_agent_il through it) but
   *      empty for accounts whose Instagram is attached the current way.
   *   2. `{page}?fields=instagram_business_account` — a professional Instagram
   *      connected to a Page. This is how Meta links Instagram today, and it
   *      was invisible to us: the picker asked only source 1, so an operator
   *      who had correctly connected Instagram in Meta saw an empty dropdown
   *      and no reason why. Found live 2026-08-30.
   *
   * Source 2 needs NO page token and NO instagram_* scope — verified against
   * a token carrying neither, which still read the link. So this costs one
   * extra call per Page and buys the case that was silently broken.
   *
   * NOT a source: `page_backed_instagram_accounts`. That is the shadow profile
   * Meta auto-creates so a Page can run Instagram placements without a real
   * account. It has no username, nobody logs into it, and offering it would
   * put an un-selectable-looking id in front of an operator as if it were the
   * business's Instagram.
   */
  async listInstagramAccounts(adAccountId: string): Promise<InstagramOption[]> {
    type RawIg = { id: string; username?: string };

    const [direct, viaPages] = await Promise.all([
      this.get(`${adAccountId}/instagram_accounts?fields=id,username&limit=200`)
        .then((b) => ((b.data as RawIg[]) ?? []))
        .catch(() => [] as RawIg[]),
      // Source 2. Isolated per Page: one Page we cannot read must not empty
      // the whole list, which is the failure this method already had.
      this.listPages(adAccountId)
        .then((pages) =>
          Promise.all(
            pages.map((pg) =>
              this.get(`${pg.id}?fields=instagram_business_account{id,username}`)
                .then((b) => (b.instagram_business_account as RawIg | undefined) ?? null)
                .catch(() => null),
            ),
          ),
        )
        .then((rows) => rows.filter((r): r is RawIg => !!r?.id))
        .catch(() => [] as RawIg[]),
    ]);

    const byId = new Map<string, RawIg>();
    for (const a of [...direct, ...viaPages]) byId.set(String(a.id), a);
    return [...byId.values()].map((a) => ({
      id: String(a.id),
      // Fall back to the id rather than rendering an empty @ — a nameless
      // option an operator cannot identify is worse than a raw id.
      username: a.username ? String(a.username) : String(a.id),
    }));
  }

  // Every campaign under one ad account, destination DETECTED per campaign
  // (detectDestination, over the same ad-set fields AIC-88's tracking check
  // trusts) rather than asked — so adopting a campaign can never disagree with
  // what the ongoing tracking-health check will judge once it's connected.
  //
  // AIC-160 — ONE call, not 1+N. This used to fetch the campaign list and then
  // read `/adsets` separately for every campaign, so opening step 4 on a
  // five-campaign account cost six Meta requests. On top of the hourly
  // ingestion engine that was enough to trip Meta's per-ad-account limit
  // (code 17), and the picker then showed the operator "failed to load
  // campaigns" — an error that reads like a broken connection when the truth
  // was "wait a minute".
  //
  // Field expansion nests the ad sets in the campaigns response. Verified live
  // against the real account: identical fields, five campaigns, one request.
  async listCampaigns(adAccountId: string): Promise<DiscoveredCampaign[]> {
    const body = await this.get(
      `${adAccountId}/campaigns?fields=id,name,status,effective_status,objective,daily_budget,` +
        `adsets.limit(100){id,name,optimization_goal,destination_type,promoted_object}&limit=200`,
    );
    type Raw = {
      id: string;
      name?: string;
      status?: string;
      effective_status?: string;
      objective?: string;
      daily_budget?: string;
      adsets?: { data?: RawAdSetTracking[] };
    };
    const rows = (body.data as Raw[]) ?? [];
    const out: DiscoveredCampaign[] = [];
    for (const r of rows) {
      const metaCampaignId = String(r.id);
      // A campaign with no ad sets yields an empty list, which detectDestination
      // already classifies as `no_ad_sets` — the same answer the separate read
      // produced, not a new silent case.
      const tracking = (r.adsets?.data ?? []).map(normalizeAdSetTracking);
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
  // Every create is status=ACTIVE. This REVERSES AIC-50/AIC-53's original hard
  // rule ("never produce a live, spending object directly"), deliberately, per
  // AIC-106: the launch gate is removed and creation IS the go-live moment.
  //
  // These three lines are where money starts moving, so be explicit about what
  // is and is not still guarding them:
  //
  //   - STILL GUARDING: the create-path budget ceiling
  //     (assertCreateWithinBudget, AIC-106 half 1) refuses an over-ceiling or
  //     ceiling-less build BEFORE the first call here, so nothing reaches Meta
  //     unbounded; and the operator-facing confirmation names the customer,
  //     the daily budget, and that it starts immediately.
  //   - NO LONGER GUARDING: the customer's launch approval (AIC-53, removed),
  //     and the AIC-18 admin first-campaign review — that review still exists
  //     and still moves `status` under_review → active, but it no longer sits
  //     between creation and spend, because the Meta objects are live the
  //     moment they are created.
  //
  // Changing something already running still requires approval (AIC-12/13).
  // That distinction — create freely, change deliberately — is the whole of
  // AIC-106's decision.
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
      status: "ACTIVE",
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
      status: "ACTIVE",
      billing_event: "IMPRESSIONS",
      optimization_goal: shape.optimizationGoal,
      destination_type: shape.destinationType,
      promoted_object: promotedObject,
      targeting: {
        age_min: params.targeting.ageMin,
        age_max: params.targeting.ageMax,
        genders: params.targeting.genders,
        // AIC-157. Cities and countries are a UNION in Meta's geo_locations,
        // not a narrowing — sending both would target the chosen cities AND
        // the entire country, i.e. exactly the nationwide spend the picker
        // exists to stop, while looking like it worked. So it is one or the
        // other.
        //
        // Meta's own key, never a name: `search?type=adgeolocation` returns
        // English names ("Ramat Gan") for Hebrew queries, and a transcribed
        // name is not a targetable value at all.
        geo_locations: geoLocations(params.targeting),
        // Meta REFUSES the create outright if this is absent — it must be an
        // explicit 0 or 1 (found live 2026-08-19: "you need to enable or
        // disable the Advantage audience feature"). The value is a stated
        // product opinion, not a default — see ADVANTAGE_AUDIENCE_ENABLED.
        targeting_automation: { advantage_audience: ADVANTAGE_AUDIENCE_ENABLED },
      },
    });
  }

  async createAd(params: CreateAdParams): Promise<string> {
    return this.postCreate(params.adAccountId, "ads", {
      name: params.name,
      adset_id: params.metaAdSetId,
      status: "ACTIVE",
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
      throw graphError(`POST ${adAccountId}/adimages`, r.status, json);
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
      throw graphError(`POST ${adAccountId}/advideos`, r.status, json);
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

  // AIC-136: the Page's real name and profile photo, for the ad preview.
  //
  // The preview header used to read "העסק שלך" with a letter in a circle —
  // a placeholder standing where the single most recognisable thing about the
  // ad belongs. The customer sees their own Page in every ad they scroll past;
  // showing them a grey initial instead is the difference between a mock-up
  // they trust and one they squint at.
  //
  // NEEDS THE PAGE'S OWN TOKEN. The System User token cannot read a Page's
  // public fields — Meta answers "(#10) requires the 'pages_read_engagement'
  // permission or the Page Public Metadata Access feature" (verified live).
  // me/accounts hands back both the name AND a usable token per Page, so the
  // name costs nothing extra and only the picture needs the second call.
  async getPageIdentity(pageId: string): Promise<{ name: string | null; pictureUrl: string | null }> {
    const token = await this.pageAccessToken(pageId);
    const r = await fetch(
      `${BASE}/${this.ver}/${pageId}?fields=name,picture.width(120).height(120){url}` +
        `&access_token=${encodeURIComponent(token)}`,
    );
    const body = (await r.json().catch(() => ({}))) as {
      name?: string;
      picture?: { data?: { url?: string } };
      error?: unknown;
    };
    if (!r.ok) throw graphError(`GET ${pageId} identity`, r.status, body as Record<string, unknown>);
    return { name: body.name ?? null, pictureUrl: body.picture?.data?.url ?? null };
  }

  /**
   * AIC-157 — Meta's own geo lookup, for the builder's city picker.
   *
   * NOT account-scoped: `/search` is a global reference lookup, so it touches
   * no customer's ad account and needs nothing beyond an ads token. Verified
   * live 2026-08-31 with our System User token.
   *
   * Hebrew queries WORK and English names come back ("רמת גן" → "Ramat Gan"),
   * which is why the caller localizes through `localizePlace` — the same map
   * the dashboard's audience labels already use, so a city reads the same way
   * everywhere.
   */
  async searchGeoLocations(query: string): Promise<GeoLocationOption[]> {
    const q = query.trim();
    if (!q) return [];
    const body = await this.get(
      `search?type=adgeolocation&location_types=${encodeURIComponent('["city","region"]')}` +
        `&country_code=IL&limit=10&q=${encodeURIComponent(q)}`,
    );
    return ((body.data as Array<Record<string, unknown>>) ?? [])
      .filter((r) => r.type === "city" || r.type === "region")
      .map((r) => ({
        key: String(r.key),
        name: String(r.name ?? r.key),
        type: r.type as "city" | "region",
        // The district a city sits in — two Israeli towns can share a name,
        // and "Ramla, Central District" is the difference between picking the
        // right one and finding out from the spend.
        region: r.region ? String(r.region) : null,
      }));
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
        source: "facebook" as const,
      };
    });
  }

  /**
   * AIC-156 — the customer's own Instagram posts, for the existing-content
   * picker. Needs `instagram_basic`, which our System User token did not
   * carry until 2026-08-31; before that the picker could only ever offer
   * Facebook Page posts, so a customer who connected Instagram in the wizard
   * saw none of their own content.
   *
   * `boost_eligibility_info` comes back from Meta itself: media with licensed
   * music or interactive filters cannot be boosted, and Meta says so up front.
   * Carried through rather than filtered out, so the picker can show the post
   * disabled WITH the reason — an item the customer can see and understand is
   * better than a short list that reads as "you have no posts".
   *
   * A video's own `media_url` is the video file, not a picture, so the
   * thumbnail is preferred for the preview; falling back to media_url would
   * put a video URL into an <img>.
   */
  async listInstagramMedia(igUserId: string): Promise<PromotablePost[]> {
    const body = await this.get(
      // `boost_eligibility_info` is requested BARE, without a subfield
      // selection. Found live 2026-08-31: asking for
      // `boost_eligibility_info{eligible_to_boost,eligibility_errors}` fails
      // the WHOLE call with "(#100) Tried accessing nonexisting field
      // (eligibility_errors)" on v21.0 — the field is not exposed there — and
      // one bad subfield takes every post down with it, emptying the Instagram
      // half for every customer. Bare, Meta returns whatever subfields it
      // actually has, and a version that later adds a reason starts working
      // without a change here.
      `${igUserId}/media?fields=id,caption,media_type,media_url,thumbnail_url,timestamp,` +
        `boost_eligibility_info&limit=25`,
    );
    type RawMedia = {
      id: string; caption?: string; media_type?: string;
      media_url?: string; thumbnail_url?: string; timestamp?: string;
      boost_eligibility_info?: { eligible_to_boost?: boolean; eligibility_errors?: Array<{ error_message?: string }> };
    };
    return ((body.data as RawMedia[]) ?? []).map((m) => {
      const boost = m.boost_eligibility_info;
      return {
        id: String(m.id),
        message: m.caption ?? null,
        pictureUrl: m.thumbnail_url ?? m.media_url ?? null,
        createdAt: String(m.timestamp ?? ""),
        source: "instagram" as const,
        // `undefined` (the field absent) is NOT "not boostable" — it is "Meta
        // did not say". Only an explicit false blocks.
        boostable: boost?.eligible_to_boost !== false,
        // v21.0 returns only `eligible_to_boost` — no reason. Parsed
        // defensively so a later version that adds one is picked up; until
        // then the UI falls back to its own copy rather than an empty line.
        boostReason: boost?.eligibility_errors?.[0]?.error_message ?? null,
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
      // AIC-156: without this the ad still runs on Instagram — as the
      // Page-backed shadow profile, not the customer's account.
      ...(params.instagramUserId ? { instagram_user_id: params.instagramUserId } : {}),
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

  // The comment that used to sit here said Meta "reuses whatever CTA/link the
  // original Page post already has". True of what happens when you send
  // nothing — but it was mistaken for a LIMIT, and that cost a real build.
  //
  // Found live 2026-08-23: a click-to-WhatsApp build failed at create_ad with
  // "The ad's creative is incompatible with the objective of the campaign the
  // ad belongs to", because this path sent ONLY object_story_id and the post
  // (a plain photo) carried no CTA. Probed against the real ad account: Meta
  // accepts `call_to_action` alongside `object_story_id` and it persists
  // (read back as call_to_action_type: WHATSAPP_MESSAGE). The post never
  // needed its own CTA — we needed to attach one, exactly as the upload path
  // already does.
  // AIC-139: one ad's full creative, for the details modal. Fetched only when
  // a customer opens that ad — the panel already makes two live reads on open,
  // and pulling every ad's copy into them would pay for text nobody asked to
  // see.
  async getAdDetail(metaAdId: string): Promise<AdDetail | null> {
    const body = await this.get(
      `${metaAdId}?fields=id,name,effective_status,` +
        `creative{id,title,body,image_url,object_story_id,object_story_spec,call_to_action_type}`,
    );
    if (!body?.id) return null;
    return normalizeAdDetail(body as unknown as RawAdDetail);
  }

  // AIC-131: which creatives an ad currently points at, for the reaper's
  // "is anything using this?" check.
  //
  // Read from /ads rather than from each creative, because an adcreative does
  // not expose who references it — the relationship is only visible from the ad
  // side.
  //
  // THE effective_status FILTER IS LOAD-BEARING, not tidiness. Meta's /ads edge
  // EXCLUDES archived ads by default, and this comment previously claimed the
  // opposite while the query did the default thing. Measured on a real account:
  // 8 ads by default, 18 with ARCHIVED requested — TEN archived ads invisible,
  // whose creatives would every one of them have read as orphaned and been
  // deleted out from under them.
  //
  // DELETED ads cannot be included at all: Meta refuses the request outright
  // ("Requesting for deleted objects is not supported in this endpoint",
  // subcode 1815001). So a creative whose only ad is DELETED will always look
  // orphaned here and will be reaped. That is acceptable and deliberate — a
  // DELETED ad is terminal, can never serve again, and Meta will not even show
  // it to us — but it is a real limit, not something the check handles.
  async listAdCreativeIdsInUse(adAccountId: string): Promise<string[]> {
    const statuses = [
      "ACTIVE", "PAUSED", "ARCHIVED", "ADSET_PAUSED", "CAMPAIGN_PAUSED",
      "DISAPPROVED", "PENDING_REVIEW", "PENDING_BILLING_INFO", "IN_PROCESS", "WITH_ISSUES",
    ];
    const body = await this.get(
      `${adAccountId}/ads?fields=creative{id}&effective_status=${encodeURIComponent(JSON.stringify(statuses))}&limit=500`,
    );
    type Raw = { creative?: { id?: string } };
    return ((body.data as Raw[]) ?? [])
      .map((a) => a.creative?.id)
      .filter((id): id is string => typeof id === "string");
  }

  // AIC-131: the account's ad creatives, for the one-off backfill of leaks that
  // predate created_creatives. Not used by the reaper itself, which works from
  // our own records rather than from everything Meta holds.
  async listAdCreatives(adAccountId: string): Promise<Array<{ id: string; name: string | null }>> {
    const body = await this.get(`${adAccountId}/adcreatives?fields=id,name&limit=500`);
    type Raw = { id: string; name?: string };
    return ((body.data as Raw[]) ?? []).map((c) => ({ id: String(c.id), name: c.name ?? null }));
  }

  // AIC-131. Meta's DELETE on an adcreative. Only ever called by the reaper,
  // and only for a creative we created, aged past the threshold, and confirmed
  // unreferenced by any ad in the account.
  async deleteCreative(creativeId: string): Promise<void> {
    const r = await fetch(`${BASE}/${this.ver}/${creativeId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!r.ok) {
      const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      throw graphError(`DELETE ${creativeId}`, r.status, body);
    }
  }

  /**
   * Promote something already published — a Facebook Page post, or (AIC-156)
   * an Instagram post.
   *
   * THE TWO ARE DIFFERENT PAYLOADS, not a flag on one. Per Meta's "Use Posts
   * as Instagram Ads" guide:
   *
   *   Facebook   object_story_id = "{page}_{post}"   [+ instagram_user_id]
   *   Instagram  object_id       = "{page}"          + source_instagram_media_id
   *                                                  + instagram_user_id
   *
   * Note `object_id` for the Instagram path — the PAGE id, bare, not a story
   * id. Sending `object_story_id` with an IG media id would build a creative
   * pointing at a Facebook post that does not exist.
   *
   * An Instagram post NEEDS instagram_user_id; there is no shadow-profile
   * fallback for content that lives on a real account. Refused loudly here
   * rather than sent half-formed, so the failure names the missing thing
   * instead of arriving as a Meta 400 the customer sees as a 502.
   */
  async createCreativeFromExistingPost(params: CreatePostCreativeParams): Promise<string> {
    const fromInstagram = params.postSource === "instagram";
    if (fromInstagram && !params.instagramUserId) {
      throw new Error(
        "createCreativeFromExistingPost: an Instagram post needs instagramUserId — " +
          "the connection has no instagram_id, so this post cannot be promoted as the customer",
      );
    }
    const fields: Record<string, unknown> = {
      name: params.name,
      ...(fromInstagram
        ? { object_id: params.pageId, source_instagram_media_id: params.postId }
        : { object_story_id: `${params.pageId}_${params.postId}` }),
      // A Facebook post carries it only when we have one; an Instagram post
      // cannot get here without one (guarded above).
      ...(params.instagramUserId ? { instagram_user_id: params.instagramUserId } : {}),
    };

    // No destination given → post as is, byte-identical to the old behaviour.
    if (params.destination) {
      const shape = resolveDestinationShape(params.destination);
      // Engagement has no ctaType by design: the interaction happens on the
      // post itself, so imposing a button would change what the customer
      // chose to run. resolveDestinationShape already encodes that, so this
      // needs no engagement special-case of its own.
      if (shape.ctaType) {
        if (shape.destinationType === "WEBSITE") {
          fields.call_to_action = { type: shape.ctaType, value: { link: params.destinationUrl } };
        } else if (fromInstagram) {
          // AIC-170 — an Instagram post takes Meta's CANONICAL click-to-WhatsApp
          // shape, not ours.
          //
          // A Page post carries the number in the creative
          // (`whatsapp_number`); Instagram media does not, and Meta refuses
          // that field here. It also refuses a wa.me deep link — the exact
          // refusal AIC-166 mistook for "an Instagram post cannot serve a
          // WhatsApp campaign at all", which was wrong and blocked the whole
          // path for a day. `api.whatsapp.com/send` is the only link it
          // accepts, and it is the same shape the customer's own adopted ad
          // reads back as.
          //
          // The number therefore comes from the PAGE's connected WhatsApp
          // Business number, not from managed_campaigns.whatsapp_destination.
          // That is Meta's model for this creative type, not an omission here.
          //
          // Verified live on our own account against v21.0, v23.0 and v25.0.
          fields.call_to_action = {
            type: shape.ctaType,
            value: { link: WHATSAPP_CANONICAL_LINK, app_destination: "WHATSAPP" },
          };
        } else {
          fields.call_to_action = { type: shape.ctaType, value: { whatsapp_number: params.whatsappNumber } };
        }
      }
    }

    return this.postCreate(params.adAccountId, "adcreatives", fields);
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
