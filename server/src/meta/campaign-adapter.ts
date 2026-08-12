import type { LiveCampaignState, MetaReader, ExecWriter } from "../execution/safe-executor.js";
import { normalizeAdSet, isProblem, type AdSetHealth, type DeliveryReader, type RawAdSetDelivery } from "./delivery-health.js";
import { normalizeAdSetMeta, type AdSetMeta, type RawAdSetMeta } from "./audience-label.js";
import type { BuilderWriter, CreateCampaignParams, CreateAdSetParams, CreateAdParams } from "../builder/types.js";
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

// Real Meta reader+writer backing the safe-execute pipeline (AIC-12) against the
// Marketing API. Budgets are read/written in the account currency's MINOR unit,
// which for ILS is agorot — matching our integer-agorot model directly.
//
// A campaign's budget may live at campaign level (CBO) or ad-set level; this
// adapter resolves the budget-bearing object on read and writes back to the same
// one, so setDailyBudget targets the right object.
const BASE = "https://graph.facebook.com";

export class GraphCampaignAdapter implements MetaReader, ExecWriter, DeliveryReader, BuilderWriter, CreativeWriter, LaunchWriter, AdditionWriter {
  private budgetObj = new Map<string, string>(); // campaignId → budget object id

  constructor(
    private readonly token: string,
    private readonly ver = process.env.META_GRAPH_VERSION || "v21.0",
    // Injectable so tests can poll uploadVideo's processing check without
    // waiting in real time — production never overrides this.
    private readonly videoPollDelayMs = 2000,
  ) {}

  private async get(pathAndQuery: string): Promise<Record<string, unknown>> {
    const r = await fetch(`${BASE}/${this.ver}/${pathAndQuery}`, {
      headers: { Authorization: `Bearer ${this.token}` },
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

  async getCampaignState(metaCampaignId: string): Promise<LiveCampaignState> {
    const camp = await this.get(`${metaCampaignId}?fields=daily_budget,effective_status,name`);
    let budgetObjId = metaCampaignId;
    let dailyBudgetAgorot = camp.daily_budget != null ? Number(camp.daily_budget) : NaN;

    // Always read ad sets: for their statuses (the audience rule + pause_adset
    // verify) and, when the campaign has no CBO budget, the ad-set-level budget.
    const adsetsBody = await this.get(`${metaCampaignId}/adsets?fields=id,daily_budget,effective_status&limit=100`);
    const adsets = (adsetsBody.data as Array<Record<string, unknown>>) ?? [];
    const adSetStatuses: Record<string, "active" | "paused"> = {};
    for (const a of adsets) {
      adSetStatuses[String(a.id)] = a.effective_status === "ACTIVE" ? "active" : "paused";
    }
    if (!(dailyBudgetAgorot > 0)) {
      const withBudget = adsets.find((a) => a.daily_budget != null);
      if (withBudget) {
        budgetObjId = String(withBudget.id);
        dailyBudgetAgorot = Number(withBudget.daily_budget);
      }
    }
    this.budgetObj.set(metaCampaignId, budgetObjId);

    const ads = await this.get(`${metaCampaignId}/ads?fields=id,effective_status&limit=100`);
    const adStatuses: Record<string, "active" | "paused"> = {};
    for (const ad of (ads.data as Array<Record<string, unknown>>) ?? []) {
      adStatuses[String(ad.id)] = ad.effective_status === "ACTIVE" ? "active" : "paused";
    }
    return { dailyBudgetAgorot: dailyBudgetAgorot > 0 ? dailyBudgetAgorot : 0, adStatuses, adSetStatuses };
  }

  async setDailyBudget(metaCampaignId: string, agorot: number): Promise<void> {
    const objId = this.budgetObj.get(metaCampaignId) ?? metaCampaignId;
    await this.post(objId, { daily_budget: String(agorot) });
  }

  async pauseAd(adId: string): Promise<void> {
    await this.post(adId, { status: "PAUSED" });
  }

  async pauseAdSet(adSetId: string): Promise<void> {
    await this.setAdSetStatus(adSetId, "PAUSED");
  }

  // Set an ad set's status directly. Used by pauseAdSet and by the reversible
  // dogfood (pause → verify → unpause) so a live test leaves zero net change.
  async setAdSetStatus(adSetId: string, status: "ACTIVE" | "PAUSED"): Promise<void> {
    await this.post(adSetId, { status });
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
    const ads = await this.get(`${metaCampaignId}/ads?fields=id,adset_id,effective_status,issues_info&limit=200`);
    for (const adRow of (ads.data as Array<{ adset_id?: string } & RawAdSetDelivery>) ?? []) {
      const parent = adRow.adset_id ? byId.get(String(adRow.adset_id)) : undefined;
      if (!parent || isProblem(parent)) continue; // ad set already flagged
      const adHealth = normalizeAdSet({ id: String(adRow.id), effective_status: adRow.effective_status, issues_info: adRow.issues_info });
      if (isProblem(adHealth)) {
        parent.state = adHealth.state;
        parent.reason = adHealth.reason;
      }
    }
    return health;
  }

  // Ad-set name + targeting (AIC-37) — the separate read that lets us derive a
  // human audience label ("18–35" vs "35–45") instead of ever showing a raw
  // ad-set name or "ad set N". Also carries is_dynamic_creative (AIC-36), so
  // the rules can skip the creative comparison for an ad set running Meta's
  // Dynamic/Advantage+ creative. Cached by the caller (ad_set_meta); not read
  // at customer render time.
  async getAdSetMeta(metaCampaignId: string): Promise<AdSetMeta[]> {
    const body = await this.get(
      `${metaCampaignId}/adsets?fields=id,name,is_dynamic_creative,effective_status,targeting{age_min,age_max,genders,geo_locations}&limit=100`,
    );
    return ((body.data as RawAdSetMeta[]) ?? []).map(normalizeAdSetMeta);
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
    return this.postCreate(params.adAccountId, "campaigns", {
      name: params.name,
      objective: "OUTCOME_LEADS",
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
    return this.postCreate(params.adAccountId, "adsets", {
      name: params.name,
      campaign_id: params.metaCampaignId,
      status: "PAUSED",
      billing_event: "IMPRESSIONS",
      optimization_goal: "CONVERSATIONS",
      destination_type: "WHATSAPP",
      promoted_object: { page_id: params.pageId },
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

  async listPromotablePosts(pageId: string): Promise<PromotablePost[]> {
    const body = await this.get(`${pageId}/promotable_posts?fields=id,message,picture,created_time&limit=25`);
    return ((body.data as Array<Record<string, unknown>>) ?? []).map((p) => ({
      id: String(p.id),
      message: p.message ? String(p.message) : null,
      pictureUrl: p.picture ? String(p.picture) : null,
      createdAt: String(p.created_time ?? ""),
    }));
  }

  async createCreativeFromUpload(params: CreateUploadCreativeParams): Promise<string> {
    const linkData: Record<string, unknown> =
      params.media.kind === "image"
        ? { image_hash: params.media.imageHash }
        : { video_id: params.media.videoId, image_url: params.media.thumbnailUrl };
    return this.postCreate(params.adAccountId, "adcreatives", {
      name: params.name,
      object_story_spec: {
        page_id: params.pageId,
        link_data: {
          ...linkData,
          message: params.primaryText,
          name: params.headline,
          call_to_action: { type: "WHATSAPP_MESSAGE", value: { whatsapp_number: params.whatsappNumber } },
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

  async getCampaignStatus(metaCampaignId: string): Promise<MetaCampaignStatus> {
    const camp = await this.get(`${metaCampaignId}?fields=effective_status`);
    return String(camp.effective_status ?? "");
  }

  async activateCampaign(metaCampaignId: string): Promise<void> {
    await this.post(metaCampaignId, { status: "ACTIVE" });
  }

  // ── Add to an existing campaign (AIC-63) ────────────────────────────────
  // Same "no caller-supplied status" pattern as activateCampaign — these are
  // the only two writes that can set an ad set / ad ACTIVE.

  async getAdSetStatus(adSetId: string): Promise<MetaCampaignStatus> {
    const r = await this.get(`${adSetId}?fields=effective_status`);
    return String(r.effective_status ?? "");
  }

  async getAdStatus(adId: string): Promise<MetaCampaignStatus> {
    const r = await this.get(`${adId}?fields=effective_status`);
    return String(r.effective_status ?? "");
  }

  async activateAdSet(adSetId: string): Promise<void> {
    await this.setAdSetStatus(adSetId, "ACTIVE");
  }

  async activateAd(adId: string): Promise<void> {
    await this.post(adId, { status: "ACTIVE" });
  }
}
