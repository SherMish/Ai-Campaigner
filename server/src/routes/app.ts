import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { buildCustomerOverview } from "../services/customer-overview.js";
import { upsertLeadQuality } from "../services/billing.js";

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

// ISO date (YYYY-MM-DD) of the Monday of the given date's week.
function mondayOf(d: Date): string {
  const copy = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = copy.getUTCDay(); // 0=Sun..6=Sat
  const diff = (day + 6) % 7; // days since Monday
  copy.setUTCDate(copy.getUTCDate() - diff);
  return copy.toISOString().slice(0, 10);
}
