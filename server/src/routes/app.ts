import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { buildCustomerOverview } from "../services/customer-overview.js";
import { recordLeadQualityReview, LeadQualityValidationError } from "../services/lead-quality-review.js";
import {
  listCustomerRecommendations,
  getCustomerRecommendation,
  approveCustomerRecommendation,
  dismissCustomerRecommendation,
} from "../services/customer-recommendations.js";
import {
  recheckCustomerConnection,
  requestBudgetChange,
} from "../services/customer-actions.js";
import { buildCampaignAudiences } from "../services/campaign-audiences.js";
import { RANGE_KEYS, type RangeKey } from "../services/readout.js";
import { getPendingLaunch, approveLaunch } from "../services/customer-launch.js";
import { buildLaunchWriter, buildLaunchReader } from "../launch/writer.js";
import { OpsQueue } from "../services/ops-queue.js";

const launchOps = new OpsQueue(pool);

// Customer-facing data API (AIC-22/24). Every route is scoped to the caller's
// own customer via the JWT — the service only ever reads rows owned by req.userId.
export const appRouter = Router();

appRouter.get("/overview", requireAuth, async (req, res) => {
  try {
    const overview = await buildCustomerOverview(pool, (req as AuthedRequest).userId!);
    if (!overview) {
      res.status(404).json({ error: "user not found" });
      return;
    }
    res.json(overview);
  } catch (e) {
    console.error("[app] overview failed", e);
    res.status(500).json({ error: "failed to load overview" });
  }
});

// Incremental lead-quality review (AIC-22, redesigned AIC-67). The customer
// is only ever asked about NEW leads since their last review — the pending
// count is read from the caller's OWN watermark (buildCustomerOverview),
// never supplied by the client, so re-rating already-reviewed leads (the old
// double-counting bug) is structurally impossible.
appRouter.post("/lead-quality", requireAuth, async (req, res) => {
  try {
    const overview = await buildCustomerOverview(pool, (req as AuthedRequest).userId!);
    if (!overview?.campaign || !overview.leadQuality) {
      res.status(404).json({ error: "no managed campaign" });
      return;
    }
    const { relevant } = req.body ?? {};
    if (!Number.isInteger(relevant)) {
      res.status(400).json({ error: "invalid lead-quality figures" });
      return;
    }
    try {
      await recordLeadQualityReview(pool, overview.campaign.id, {
        leadsDelta: overview.leadQuality.pending,
        relevantDelta: relevant,
      });
    } catch (e) {
      if (e instanceof LeadQualityValidationError) {
        res.status(400).json({ error: e.message });
        return;
      }
      throw e;
    }
    const updated = await buildCustomerOverview(pool, (req as AuthedRequest).userId!);
    res.json({ ok: true, leadQuality: updated?.leadQuality ?? null });
  } catch (e) {
    console.error("[app] lead-quality failed", e);
    res.status(500).json({ error: "failed to save feedback" });
  }
});

// ── Recommendations (AIC-23) ───────────────────────────────────────────────
appRouter.get("/recommendations", requireAuth, async (req, res) => {
  try {
    res.json(await listCustomerRecommendations(pool, (req as AuthedRequest).userId!));
  } catch (e) {
    console.error("[app] list recommendations failed", e);
    res.status(500).json({ error: "failed to load recommendations" });
  }
});

appRouter.get("/recommendations/:id", requireAuth, async (req, res) => {
  try {
    const rec = await getCustomerRecommendation(pool, (req as AuthedRequest).userId!, String(req.params.id));
    if (!rec) {
      res.status(404).json({ error: "recommendation not found" });
      return;
    }
    res.json(rec);
  } catch (e) {
    console.error("[app] get recommendation failed", e);
    res.status(500).json({ error: "failed to load recommendation" });
  }
});

appRouter.post("/recommendations/:id/approve", requireAuth, async (req, res) => {
  try {
    const r = await approveCustomerRecommendation(pool, (req as AuthedRequest).userId!, String(req.params.id));
    if (r.status === "not_found") { res.status(404).json({ error: "recommendation not found" }); return; }
    if (r.status === "not_pending") { res.status(409).json({ error: "recommendation is no longer pending" }); return; }
    if (r.status === "unavailable") { res.status(503).json({ error: "execution temporarily unavailable" }); return; }
    // done: report the pipeline outcome (executed / aborted / failed) + any
    // plain-Hebrew message — never the internal reason.
    res.json({
      outcome: r.result!.outcome,
      customerMessage: r.result!.customerMessage ?? null,
    });
  } catch (e) {
    console.error("[app] approve recommendation failed", e);
    res.status(500).json({ error: "failed to approve recommendation" });
  }
});

appRouter.post("/recommendations/:id/dismiss", requireAuth, async (req, res) => {
  try {
    const r = await dismissCustomerRecommendation(pool, (req as AuthedRequest).userId!, String(req.params.id));
    if (r === "not_found") { res.status(404).json({ error: "recommendation not found" }); return; }
    if (r === "not_pending") { res.status(409).json({ error: "recommendation is no longer pending" }); return; }
    res.json({ ok: true });
  } catch (e) {
    console.error("[app] dismiss recommendation failed", e);
    res.status(500).json({ error: "failed to dismiss recommendation" });
  }
});

// ── Connection + budget actions (AIC-21 / AIC-24) ──────────────────────────
appRouter.post("/connection/recheck", requireAuth, async (req, res) => {
  try {
    const health = await recheckCustomerConnection(pool, (req as AuthedRequest).userId!);
    if (health === null) {
      res.status(404).json({ error: "no connection" });
      return;
    }
    res.json({ accessHealth: health });
  } catch (e) {
    console.error("[app] connection recheck failed", e);
    res.status(500).json({ error: "failed to check connection" });
  }
});

appRouter.post("/budget-request", requireAuth, async (req, res) => {
  try {
    const { requestedAgorot } = req.body ?? {};
    const amount =
      Number.isInteger(requestedAgorot) && requestedAgorot > 0 ? requestedAgorot : null;
    const ok = await requestBudgetChange(pool, (req as AuthedRequest).userId!, amount);
    if (!ok) {
      res.status(404).json({ error: "no customer" });
      return;
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("[app] budget request failed", e);
    res.status(500).json({ error: "failed to submit request" });
  }
});

// ── Opt-in audience details (AIC-37) ───────────────────────────────────────
// The "details" expander: per-audience (ad set) + per-creative breakdown.
// Collapsed by default on Home; this is the door, not the room.
appRouter.get("/audiences", requireAuth, async (req, res) => {
  try {
    // AIC-95: follows the same range switcher the KPI cards do. An unknown
    // value falls back to "week" (the switcher's own default) rather than
    // 400ing — a stale client sending an old value shouldn't hard-fail.
    const rawRange = req.query.range;
    const range: RangeKey = (RANGE_KEYS as readonly string[]).includes(rawRange as string) ? (rawRange as RangeKey) : "week";
    const result = await buildCampaignAudiences(pool, (req as AuthedRequest).userId!, range);
    if (!result) {
      res.status(404).json({ error: "no managed campaign" });
      return;
    }
    res.json(result);
  } catch (e) {
    console.error("[app] audiences failed", e);
    res.status(500).json({ error: "failed to load audience details" });
  }
});

// ── Launch gate (AIC-53) ─────────────────────────────────────────────────
// A review-approved, still-PAUSED-on-Meta campaign shows here for the
// customer's explicit launch approval — this is what actually flips the
// campaign to spending, never review approval alone.
appRouter.get("/launch", requireAuth, async (req, res) => {
  try {
    // The same token-gated adapter the writer uses. Null (no token) is NOT
    // treated as "fine" — getPendingLaunch reports `verification_unavailable`
    // and blocks approval, since we can't confirm what we'd be turning on.
    const launch = await getPendingLaunch(pool, (req as AuthedRequest).userId!, buildLaunchReader());
    res.json({ launch });
  } catch (e) {
    console.error("[app] launch summary failed", e);
    res.status(500).json({ error: "failed to load launch summary" });
  }
});

appRouter.post("/launch/approve", requireAuth, async (req, res) => {
  try {
    const writer = buildLaunchWriter();
    if (!writer) {
      res.status(503).json({ error: "execution temporarily unavailable" });
      return;
    }
    const result = await approveLaunch(pool, writer, (req as AuthedRequest).userId!, buildLaunchReader(), launchOps);
    if (result.outcome === "not_found") {
      res.status(404).json({ error: "nothing pending launch" });
      return;
    }
    // Re-checked server-side: a disabled button is a courtesy, not the gate.
    if (result.outcome === "blocked") {
      res.status(409).json({ error: "launch preconditions not met", blockers: result.blockers });
      return;
    }
    res.json(result);
  } catch (e) {
    console.error("[app] launch approve failed", e);
    res.status(500).json({ error: "failed to approve launch" });
  }
});
