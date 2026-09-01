import type { OpsQueueType, OpsSeverity } from "@aic/shared";
import type { RecommendationStore } from "../recommendations/recommendation-store.js";
import type { RecommendationService } from "../recommendations/recommendation-service.js";
import type { RecommendationRecord } from "../recommendations/types.js";
import { assertWithinBudget, BudgetLimitError } from "./budget.js";
import { EXEC_HE } from "./strings.he.js";

export interface LiveCampaignState {
  dailyBudgetAgorot: number;
  adStatuses: Record<string, "active" | "paused">;
  adSetStatuses: Record<string, "active" | "paused">;
  /**
   * AIC-169 — which ad belongs to which ad set, from the same live read.
   *
   * Without it a consumer holding these statuses cannot ask "does THIS ad set
   * have any live ad", and the customer view fell back to the ads it happened
   * to have rows for IN THE SELECTED DATE WINDOW. On a range with no delivery
   * that is an empty list, so an ad set with every ad paused rendered
   * "מפרסם" — a live claim that changed when the customer changed the dates.
   *
   * Free: `{campaign}/ads` is already being read here; this is one more field
   * on the same request.
   */
  adSetByAd: Record<string, string>;
}

export interface MetaReader {
  getCampaignState(metaCampaignId: string): Promise<LiveCampaignState>;
}

export interface ExecWriter {
  setDailyBudget(metaCampaignId: string, agorot: number): Promise<void>;
  pauseAd(adId: string): Promise<void>;
  pauseAdSet(adSetId: string): Promise<void>;
}

// Throws when access is lost (AIC-5) / automation is stopped (AIC-14).
export interface AccessGuard {
  assertExecutable(id: string): Promise<void>;
}

export interface OpsRaiser {
  raise(item: {
    customerId: string | null;
    campaignId: string | null;
    type: OpsQueueType;
    severity: OpsSeverity;
    detail: string;
  }): Promise<void>;
}

export interface ExecCampaign {
  id: string;
  metaCampaignId: string | null;
  connectionId: string | null;
  customerId: string;
  agreedBudgetAgorot: number;
}

export interface CampaignLoader {
  load(campaignId: string): Promise<ExecCampaign | null>;
}

export type ExecOutcome = "executed" | "aborted" | "failed";

export interface ExecResult {
  outcome: ExecOutcome;
  reason?: string; // internal
  customerMessage?: string; // plain Hebrew, on abort/failure
  opsRaised: boolean;
}

export interface SafeExecutorDeps {
  store: RecommendationStore;
  service: RecommendationService;
  campaigns: CampaignLoader;
  reader: MetaReader;
  writer: ExecWriter;
  connectionGuard: AccessGuard; // access health (AIC-5)
  controlGate: AccessGuard; // emergency controls (AIC-14)
  ops: OpsRaiser;
}

function isBudgetRec(rec: RecommendationRecord): boolean {
  return rec.type === "increase_budget" || rec.type === "decrease_budget";
}

// The safe-execute pipeline (PRD §19). Runs when a customer-approved
// recommendation is executed. Ordered; every step can abort cleanly. It must
// never apply a change that is stale, unsafe, or based on outdated campaign
// state — and never silently succeed on failure.
export class SafeExecutor {
  constructor(private readonly d: SafeExecutorDeps) {}

  async execute(recId: string, approvedBy = "customer"): Promise<ExecResult> {
    const rec = await this.d.store.getById(recId);
    if (!rec) throw new Error(`recommendation ${recId} not found`);

    // 1. Relevance: only an approved rec executes (belt with AIC-8/AIC-11).
    if (rec.state !== "approved") {
      return { outcome: "aborted", reason: `state is ${rec.state}, not approved`, opsRaised: false };
    }

    const campaign = await this.d.campaigns.load(rec.campaignId);
    if (!campaign || !campaign.metaCampaignId) {
      return this.fail(rec, campaign, "campaign not linked to a Meta campaign", EXEC_HE.genericFailure, "campaign_not_delivering");
    }

    // 2. Access health (AIC-5). Lost access is a hold, not a failure — the rec
    //    stays approved to retry after reconnect; raise an ops item.
    try {
      if (campaign.connectionId) await this.d.connectionGuard.assertExecutable(campaign.connectionId);
    } catch {
      await this.d.ops.raise({ customerId: campaign.customerId, campaignId: campaign.id, type: "meta_connection_failure", severity: "high", detail: `execution held: access lost for rec ${rec.id}` });
      return { outcome: "aborted", reason: "access lost", customerMessage: EXEC_HE.accessLost, opsRaised: true };
    }

    // 3. Emergency controls (AIC-14). A stop is an intentional hold — no failure,
    //    no ops noise; the rec stays approved.
    try {
      await this.d.controlGate.assertExecutable(campaign.id);
    } catch {
      return { outcome: "aborted", reason: "automation stopped", opsRaised: false };
    }

    // Claim it: approved → executing. From here, any problem ends in `failed`.
    await this.d.service.beginExecution(rec.id);

    // replace_creative is human-assisted in P0 — no Meta write; escalate to ops.
    if (rec.type === "replace_creative") {
      await this.d.ops.raise({ customerId: campaign.customerId, campaignId: campaign.id, type: "missing_creative", severity: "medium", detail: `creative replacement requested (rec ${rec.id}, target ${rec.targetMetaId})` });
      await this.d.service.completeExecution(rec.id, {
        result: "success", what: "flagged creative for replacement", why: rec.rationale,
        previousState: {}, newState: { escalated: true }, approvedBy, humanInvolved: true,
      });
      return { outcome: "executed", opsRaised: true };
    }

    // 4. Sync live state.
    const before = await this.d.reader.getCampaignState(campaign.metaCampaignId);

    // 5. External-change detection: did the campaign change since we proposed?
    if (isBudgetRec(rec) && before.dailyBudgetAgorot !== rec.currentBudgetAgorot) {
      return this.fail(rec, campaign, `external change: live budget ${before.dailyBudgetAgorot} ≠ captured ${rec.currentBudgetAgorot}`, EXEC_HE.externalChange, "unusual_performance", { before });
    }
    if (rec.type === "pause_creative" && before.adStatuses[rec.targetMetaId ?? ""] !== "active") {
      return this.fail(rec, campaign, `external change: ad ${rec.targetMetaId} is not active`, EXEC_HE.externalChange, "unusual_performance", { before });
    }
    if (rec.type === "pause_adset" && before.adSetStatuses[rec.targetMetaId ?? ""] !== "active") {
      return this.fail(rec, campaign, `external change: ad set ${rec.targetMetaId} is not active`, EXEC_HE.externalChange, "unusual_performance", { before });
    }

    // 6. Budget safety (AIC-13): never exceed the agreed ceiling.
    try {
      assertWithinBudget(campaign.agreedBudgetAgorot, rec.proposedBudgetAgorot);
    } catch (e) {
      if (e instanceof BudgetLimitError) {
        return this.fail(rec, campaign, e.message, EXEC_HE.overBudget, "unusual_performance", { before });
      }
      throw e;
    }

    // 7. Execute (idempotent absolute-set ops).
    try {
      if (isBudgetRec(rec)) {
        await this.d.writer.setDailyBudget(campaign.metaCampaignId, rec.proposedBudgetAgorot as number);
      } else if (rec.type === "pause_creative") {
        await this.d.writer.pauseAd(rec.targetMetaId as string);
      } else if (rec.type === "pause_adset") {
        await this.d.writer.pauseAdSet(rec.targetMetaId as string);
      }
    } catch (e) {
      return this.fail(rec, campaign, `write failed: ${(e as Error).message}`, EXEC_HE.genericFailure, "campaign_not_delivering", { before });
    }

    // 8. Verify read-back: a mismatch is a failure, not a success.
    const after = await this.d.reader.getCampaignState(campaign.metaCampaignId);
    const landed = isBudgetRec(rec)
      ? after.dailyBudgetAgorot === rec.proposedBudgetAgorot
      : rec.type === "pause_adset"
        ? after.adSetStatuses[rec.targetMetaId ?? ""] === "paused"
        : after.adStatuses[rec.targetMetaId ?? ""] === "paused";
    if (!landed) {
      return this.fail(rec, campaign, "read-back mismatch: change did not land", EXEC_HE.genericFailure, "campaign_not_delivering", { before, after });
    }

    // 9. Log the real change + mark executed.
    await this.d.service.completeExecution(rec.id, {
      result: "success",
      what: describe(rec),
      why: rec.rationale,
      previousState: before as unknown as Record<string, unknown>,
      newState: after as unknown as Record<string, unknown>,
      approvedBy,
      humanInvolved: false,
    });
    return { outcome: "executed", opsRaised: false };
  }

  // Mark a claimed (executing) rec failed, log it, raise an ops item + customer
  // message. Never leaves a rec looking succeeded.
  private async fail(
    rec: RecommendationRecord,
    campaign: ExecCampaign | null,
    reason: string,
    customerMessage: string,
    opsType: OpsQueueType,
    states: { before?: unknown; after?: unknown } = {},
  ): Promise<ExecResult> {
    // Only recs already 'executing' can be failed; claim it first if needed.
    if (rec.state === "approved") await this.d.service.beginExecution(rec.id).catch(() => {});
    await this.d.service.completeExecution(rec.id, {
      result: "failed", what: describe(rec), why: reason,
      previousState: (states.before as Record<string, unknown>) ?? {},
      newState: (states.after as Record<string, unknown>) ?? {},
      approvedBy: null, humanInvolved: false,
    }).catch(() => {});
    await this.d.ops.raise({
      customerId: campaign?.customerId ?? null,
      campaignId: campaign?.id ?? rec.campaignId,
      type: opsType,
      severity: "high",
      detail: `execution failed (rec ${rec.id}): ${reason}`,
    });
    return { outcome: "failed", reason, customerMessage, opsRaised: true };
  }
}

function describe(rec: RecommendationRecord): string {
  switch (rec.type) {
    case "increase_budget":
    case "decrease_budget":
      return `set daily budget ${rec.currentBudgetAgorot} → ${rec.proposedBudgetAgorot}`;
    case "pause_creative":
      return `pause ad ${rec.targetMetaId}`;
    case "pause_adset":
      return `pause ad set ${rec.targetMetaId}`;
    case "replace_creative":
      return `replace creative ${rec.targetMetaId}`;
    default:
      return rec.type;
  }
}
