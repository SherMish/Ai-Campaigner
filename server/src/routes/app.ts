import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { buildCustomerOverview } from "../services/customer-overview.js";
import { upsertLeadQuality } from "../services/billing.js";
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

// Weekly lead-quality feedback (AIC-22). The customer reports, for the current
// week, how many of their leads were relevant. Scoped to their own campaign.
appRouter.post("/lead-quality", requireAuth, async (req, res) => {
  try {
    const overview = await buildCustomerOverview(pool, (req as AuthedRequest).userId!);
    if (!overview?.campaign) {
      res.status(404).json({ error: "no managed campaign" });
      return;
    }
    const { leadsReported, relevantCount, customersWon } = req.body ?? {};
    if (
      !Number.isInteger(leadsReported) ||
      !Number.isInteger(relevantCount) ||
      leadsReported < 0 ||
      relevantCount < 0 ||
      relevantCount > leadsReported
    ) {
      res.status(400).json({ error: "invalid lead-quality figures" });
      return;
    }
    await upsertLeadQuality(pool, {
      campaignId: overview.campaign.id,
      weekStart: mondayOf(new Date()),
      leadsReported,
      relevantCount,
      customersWon:
        typeof customersWon === "number" && Number.isInteger(customersWon)
          ? customersWon
          : null,
    });
    res.json({ ok: true });
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

// ISO date (YYYY-MM-DD) of the Monday of the given date's week.
function mondayOf(d: Date): string {
  const copy = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = copy.getUTCDay(); // 0=Sun..6=Sat
  const diff = (day + 6) % 7; // days since Monday
  copy.setUTCDate(copy.getUTCDate() - diff);
  return copy.toISOString().slice(0, 10);
}
