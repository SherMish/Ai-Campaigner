import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAdmin } from "../middleware/admin.js";
import {
  buildCampaignReadout,
  listCampaignsForAdmin,
} from "../services/readout.js";
import { ControlService, PgControlStore } from "../execution/control-service.js";
import { listCampaignActionHistory, condense } from "../services/action-history.js";
import { listCustomers, getCustomerDetail } from "../services/customers.js";
import { OpsQueue } from "../services/ops-queue.js";
import { consoleLogger } from "../services/logger.js";
import { submitReview, recordCustomerDecision, getLatestReview } from "../services/campaign-review.js";
import { updateBilling, conversionSummary, upsertLeadQuality, listLeadQuality, leadQualityResponseRate } from "../services/billing.js";

// Internal admin surfaces. Reads only from our DB (insight_snapshots) — never a
// live Meta call at render time (AIC-7).
export const adminRouter = Router();

adminRouter.use(requireAdmin);

const controls = new ControlService(new PgControlStore(pool));

// Emergency controls (AIC-14): immediate per-account kill-switches, no deploy.
const CONTROL_ACTIONS = {
  disable_automation: (id: string) => controls.disableAutomation(id),
  enable_automation: (id: string) => controls.enableAutomation(id),
  freeze_execution: (id: string) => controls.freezeExecution(id),
  unfreeze_execution: (id: string) => controls.unfreezeExecution(id),
  mark_unmanaged: (id: string) => controls.markUnmanaged(id),
  pause_management: (id: string) => controls.pauseManagement(id),
} as const;

adminRouter.post("/campaigns/:id/controls", async (req, res) => {
  const action = req.body?.action as keyof typeof CONTROL_ACTIONS | undefined;
  if (!action || !(action in CONTROL_ACTIONS)) {
    res.status(400).json({ error: "unknown control action", allowed: Object.keys(CONTROL_ACTIONS) });
    return;
  }
  await CONTROL_ACTIONS[action](req.params.id);
  res.json({ ok: true, action });
});

adminRouter.get("/campaigns", async (_req, res) => {
  const campaigns = await listCampaignsForAdmin(pool);
  res.json({ campaigns });
});

// Customers view (AIC-16): operator home base.
adminRouter.get("/customers", async (_req, res) => {
  res.json({ customers: await listCustomers(pool) });
});

adminRouter.get("/customers/:id", async (req, res) => {
  const detail = await getCustomerDetail(pool, req.params.id);
  if (!detail) {
    res.status(404).json({ error: "customer not found" });
    return;
  }
  res.json(detail);
});

// Needs-attention queue (AIC-17).
const opsQueue = new OpsQueue(pool, consoleLogger);

adminRouter.get("/ops-queue", async (req, res) => {
  res.json({ items: await opsQueue.list({ includeResolved: req.query.all === "true" }) });
});

adminRouter.post("/ops-queue", async (req, res) => {
  const { customerId, campaignId, type, severity, detail } = req.body ?? {};
  if (!type || !severity) {
    res.status(400).json({ error: "type and severity required" });
    return;
  }
  res.json(await opsQueue.create({ customerId: customerId ?? null, campaignId, type, severity, detail: detail ?? "" }));
});

adminRouter.post("/ops-queue/:id/claim", async (req, res) => {
  const item = await opsQueue.claim(req.params.id, req.body?.operator ?? "operator");
  if (!item) { res.status(404).json({ error: "not found or resolved" }); return; }
  res.json(item);
});

adminRouter.post("/ops-queue/:id/resolve", async (req, res) => {
  const item = await opsQueue.resolve(req.params.id, req.body?.note ?? "");
  if (!item) { res.status(404).json({ error: "not found" }); return; }
  res.json(item);
});

// First-campaign review (AIC-18).
adminRouter.get("/campaigns/:id/review", async (req, res) => {
  res.json({ review: await getLatestReview(pool, req.params.id) });
});

adminRouter.post("/campaigns/:id/review", async (req, res) => {
  const { reviewer, outcome, checklist, notes } = req.body ?? {};
  if (!reviewer || !["approved", "changes_requested", "unsupported"].includes(outcome)) {
    res.status(400).json({ error: "reviewer + valid outcome required" });
    return;
  }
  res.json(await submitReview(pool, { campaignId: req.params.id, reviewer, outcome, checklist, notes }));
});

adminRouter.post("/reviews/:id/customer-decision", async (req, res) => {
  const review = await recordCustomerDecision(pool, req.params.id, req.body?.approved === true);
  if (!review) { res.status(404).json({ error: "review not found" }); return; }
  res.json(review);
});

// Manual billing ledger (AIC-19).
adminRouter.patch("/customers/:id/billing", async (req, res) => {
  await updateBilling(pool, req.params.id, req.body ?? {});
  res.json({ ok: true });
});

adminRouter.get("/billing/conversion", async (_req, res) => {
  res.json(await conversionSummary(pool));
});

// Weekly lead-quality capture (AIC-19).
adminRouter.get("/campaigns/:id/lead-quality", async (req, res) => {
  res.json({ weeks: await listLeadQuality(pool, req.params.id) });
});

adminRouter.post("/campaigns/:id/lead-quality", async (req, res) => {
  const { weekStart, leadsReported, relevantCount, customersWon } = req.body ?? {};
  if (!weekStart) { res.status(400).json({ error: "weekStart required" }); return; }
  await upsertLeadQuality(pool, {
    campaignId: req.params.id, weekStart,
    leadsReported: Number(leadsReported ?? 0), relevantCount: Number(relevantCount ?? 0),
    customersWon: customersWon == null ? null : Number(customersWon),
  });
  res.json({ ok: true });
});

adminRouter.get("/lead-quality/response-rate", async (req, res) => {
  const week = String(req.query.week ?? "");
  if (!week) { res.status(400).json({ error: "week query param required" }); return; }
  res.json(await leadQualityResponseRate(pool, week));
});

adminRouter.get("/campaigns/:id/readout", async (req, res) => {
  const readout = await buildCampaignReadout(pool, req.params.id);
  if (!readout) {
    res.status(404).json({ error: "campaign not found" });
    return;
  }
  res.json(readout);
});

// Per-campaign action history (AIC-15). ?condensed=true → jargon-free projection.
adminRouter.get("/campaigns/:id/history", async (req, res) => {
  const entries = await listCampaignActionHistory(pool, req.params.id);
  if (req.query.condensed === "true") {
    res.json({ entries: condense(entries) });
    return;
  }
  res.json({ entries });
});
