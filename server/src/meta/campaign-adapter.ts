import type { LiveCampaignState, MetaReader, ExecWriter } from "../execution/safe-executor.js";

// Real Meta reader+writer backing the safe-execute pipeline (AIC-12) against the
// Marketing API. Budgets are read/written in the account currency's MINOR unit,
// which for ILS is agorot — matching our integer-agorot model directly.
//
// A campaign's budget may live at campaign level (CBO) or ad-set level; this
// adapter resolves the budget-bearing object on read and writes back to the same
// one, so setDailyBudget targets the right object.
const BASE = "https://graph.facebook.com";

export class GraphCampaignAdapter implements MetaReader, ExecWriter {
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

    if (!(dailyBudgetAgorot > 0)) {
      // Budget is at ad-set level; find the first ad set that carries one.
      const adsets = await this.get(`${metaCampaignId}/adsets?fields=id,daily_budget,effective_status&limit=10`);
      const withBudget = ((adsets.data as Array<Record<string, unknown>>) ?? []).find((a) => a.daily_budget != null);
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
    return { dailyBudgetAgorot: dailyBudgetAgorot > 0 ? dailyBudgetAgorot : 0, adStatuses };
  }

  async setDailyBudget(metaCampaignId: string, agorot: number): Promise<void> {
    const objId = this.budgetObj.get(metaCampaignId) ?? metaCampaignId;
    await this.post(objId, { daily_budget: String(agorot) });
  }

  async pauseAd(adId: string): Promise<void> {
    await this.post(adId, { status: "PAUSED" });
  }

  // Which object carries the budget for a campaign (for logging/verification).
  budgetObjectOf(metaCampaignId: string): string | undefined {
    return this.budgetObj.get(metaCampaignId);
  }
}
