import type { LiveCampaignState, MetaReader, ExecWriter } from "../execution/safe-executor.js";
import { normalizeAdSet, isProblem, type AdSetHealth, type DeliveryReader, type RawAdSetDelivery } from "./delivery-health.js";

// Real Meta reader+writer backing the safe-execute pipeline (AIC-12) against the
// Marketing API. Budgets are read/written in the account currency's MINOR unit,
// which for ILS is agorot — matching our integer-agorot model directly.
//
// A campaign's budget may live at campaign level (CBO) or ad-set level; this
// adapter resolves the budget-bearing object on read and writes back to the same
// one, so setDailyBudget targets the right object.
const BASE = "https://graph.facebook.com";

export class GraphCampaignAdapter implements MetaReader, ExecWriter, DeliveryReader {
  private budgetObj = new Map<string, string>(); // campaignId → budget object id

  constructor(
    private readonly token: string,
    private readonly ver = process.env.META_GRAPH_VERSION || "v21.0",
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
}
