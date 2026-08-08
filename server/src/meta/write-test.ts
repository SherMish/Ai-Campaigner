import type { Logger } from "../services/logger.js";
import { GraphCampaignAdapter } from "./campaign-adapter.js";
import { InMemoryRecommendationStore } from "../recommendations/recommendation-store.js";
import { RecommendationService } from "../recommendations/recommendation-service.js";
import {
  SafeExecutor,
  type AccessGuard,
  type OpsRaiser,
  type CampaignLoader,
} from "../execution/safe-executor.js";

// AIC-1 write half + AIC-12/13 live validation. Sets the campaign's daily budget
// to its CURRENT value (a true no-op) through the full safe-execute pipeline, then
// reads back to confirm zero net change. In-memory stores + fakes for the guards
// and ops sink, real Meta reader/writer — so it exercises the whole pipeline
// against live Meta without seeding the DB or touching the admin surface.
//
// Gated by META_WRITE_TEST. Optionally target a specific campaign via
// META_TEST_CAMPAIGN_ID; otherwise the first campaign with a daily budget is used.
const BASE = "https://graph.facebook.com";
const OK_GUARD: AccessGuard = { assertExecutable: async () => {} };
const NOOP_OPS: OpsRaiser = { raise: async () => {} };

export async function runWriteTest(log: Logger): Promise<void> {
  const token = process.env.META_SYSTEM_USER_TOKEN;
  const ver = process.env.META_GRAPH_VERSION || "v21.0";
  if (!token) {
    log.error("[write-test] META_SYSTEM_USER_TOKEN not set");
    return;
  }
  log.info("[write-test] ── AIC-1 no-op write test (through AIC-12 pipeline) ──");

  // Find a campaign with a daily budget to no-op.
  let campaignId = process.env.META_TEST_CAMPAIGN_ID || "";
  try {
    if (!campaignId) {
      // Discover: list ad accounts → campaigns with a daily_budget.
      const accts = await gj(`${BASE}/${ver}/me/adaccounts?fields=id&limit=25`, token);
      for (const a of (accts.data as Array<Record<string, unknown>>) ?? []) {
        const camps = await gj(`${BASE}/${ver}/${a.id}/campaigns?fields=id,name,status,daily_budget&limit=50`, token);
        const c = ((camps.data as Array<Record<string, unknown>>) ?? []).find((x) => x.daily_budget != null);
        if (c) { campaignId = String(c.id); log.info(`[write-test] using campaign ${c.id} — ${c.name} (status ${c.status})`); break; }
        // no campaign-level budget on this account; the adapter will check ad-set level for a chosen campaign
        const anyC = ((camps.data as Array<Record<string, unknown>>) ?? [])[0];
        if (anyC && !campaignId) { campaignId = String(anyC.id); log.info(`[write-test] no campaign-level budget; will check ad-set budget on ${anyC.id} — ${anyC.name}`); }
      }
    }
    if (!campaignId) { log.error("[write-test] no campaign found to test"); return; }

    const adapter = new GraphCampaignAdapter(token, ver);
    const before = await adapter.getCampaignState(campaignId);
    log.info(`[write-test] current daily budget = ${before.dailyBudgetAgorot} agorot (budget object: ${adapter.budgetObjectOf(campaignId)})`);
    if (!(before.dailyBudgetAgorot > 0)) {
      log.error("[write-test] no daily budget found (campaign or ad-set) — cannot run a budget no-op. Skipping; choose a different reversible write.");
      return;
    }

    // Build an approved no-op recommendation: proposed == current.
    const store = new InMemoryRecommendationStore();
    const service = new RecommendationService(store);
    const rec = await service.propose({
      campaignId: "aic1-test", type: "decrease_budget", targetMetaId: campaignId,
      evidence: { note: "AIC-1 no-op write test" },
      currentBudgetAgorot: before.dailyBudgetAgorot,
      proposedBudgetAgorot: before.dailyBudgetAgorot, // no-op
      maxSpendImpactAgorot: 0, rationale: "AIC-1: reversible no-op to validate live write through the pipeline",
    });
    await service.approve(rec.id, "aic-1-test");

    const campaigns: CampaignLoader = {
      load: async () => ({
        id: "aic1-test", metaCampaignId: campaignId, connectionId: "live",
        customerId: "pisga", agreedBudgetAgorot: before.dailyBudgetAgorot, // agreed == current → within-budget
      }),
    };
    const executor = new SafeExecutor({
      store, service, campaigns, reader: adapter, writer: adapter,
      connectionGuard: OK_GUARD, controlGate: OK_GUARD, ops: NOOP_OPS,
    });

    const result = await executor.execute(rec.id, "aic-1-test");
    log.info(`[write-test] pipeline outcome = ${result.outcome}${result.reason ? " (" + result.reason + ")" : ""}`);

    // Read back to prove zero net change.
    const after = await adapter.getCampaignState(campaignId);
    const unchanged = after.dailyBudgetAgorot === before.dailyBudgetAgorot;
    const rd = await store.getById(rec.id);
    const hist = store.actionHistory.at(-1);
    log.info(`[write-test] read-back daily budget = ${after.dailyBudgetAgorot} agorot (net change: ${after.dailyBudgetAgorot - before.dailyBudgetAgorot})`);
    log.info(`[write-test] recommendation state = ${rd?.state}; action_history result = ${hist?.result}`);
    const pass = result.outcome === "executed" && unchanged && rd?.state === "executed";
    log.info(`[write-test] RESULT=${pass ? "PASS ✅ — live write round-trip through AIC-12 succeeded, zero net change" : "FAIL"}`);
  } catch (e) {
    log.error(`[write-test] error: ${(e as Error).message}`);
    log.info("[write-test] RESULT=FAIL (write likely blocked — this is the AIC-1 access-tier signal for writes)");
  }
}

async function gj(url: string, token: string): Promise<Record<string, unknown>> {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return (await r.json().catch(() => ({}))) as Record<string, unknown>;
}
