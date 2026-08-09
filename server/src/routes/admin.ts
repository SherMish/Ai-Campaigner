import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAdmin } from "../middleware/admin.js";
import type { AuthedRequest } from "../middleware/auth.js";
import {
  buildCampaignReadout,
  listCampaignsForAdmin,
} from "../services/readout.js";
import { ControlService, PgControlStore } from "../execution/control-service.js";
import { listCampaignActionHistory, condense } from "../services/action-history.js";
import { listCustomers, getCustomerDetail } from "../services/customers.js";
import { createCustomer, updateCustomer, deactivateCustomer, reactivateCustomer, deleteCustomer } from "../services/customer-admin.js";
import { listAuditLog, type Actor } from "../services/admin-audit.js";
import { PgUserStore } from "../auth/user-store.js";
import { OpsQueue } from "../services/ops-queue.js";
import { consoleLogger } from "../services/logger.js";
import { submitReview, recordCustomerDecision, getLatestReview } from "../services/campaign-review.js";
import { updateBilling, conversionSummary, upsertLeadQuality, listLeadQuality, leadQualityResponseRate } from "../services/billing.js";
import { buildFleetOverview } from "../services/fleet-overview.js";
import { buildCampaignExplorer } from "../services/campaign-explorer.js";

// Internal admin surfaces. Reads only from our DB (insight_snapshots) — never a
// live Meta call at render time (AIC-7).
export const adminRouter = Router();

adminRouter.use(requireAdmin);

const controls = new ControlService(new PgControlStore(pool));
const userStore = new PgUserStore(pool);

// Who's making this write, for the admin audit log (AIC-44/47). requireAdmin
// sets req.userId for the per-user path; the break-glass token path has no
// human behind it, so it's logged as such rather than guessed at.
async function actorFor(req: AuthedRequest): Promise<Actor> {
  const userId = req.userId ?? null;
  if (!userId) return { userId: null, label: "break-glass token" };
  const user = await userStore.findById(userId);
  return { userId, label: user?.email ?? userId };
}

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

// Fleet-wide snapshot (AIC-43): the operator's landing view. Read-only, our DB
// only.
adminRouter.get("/overview", async (_req, res) => {
  try {
    res.json(await buildFleetOverview(pool));
  } catch (e) {
    console.error("[admin] overview failed", e);
    res.status(500).json({ error: "failed to load overview" });
  }
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

// Customer CRUD (AIC-44): manual onboarding entry point + the operator's daily
// edit/support tool. Every write logs an admin_audit_log row (AIC-47 reads it).
adminRouter.post("/customers", async (req, res) => {
  const actor = await actorFor(req as AuthedRequest);
  try {
    const { id } = await createCustomer(pool, actor, req.body ?? {});
    res.status(201).json({ id });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "failed to create customer" });
  }
});

adminRouter.patch("/customers/:id", async (req, res) => {
  const actor = await actorFor(req as AuthedRequest);
  const r = await updateCustomer(pool, actor, req.params.id, req.body ?? {});
  if (!r.ok) { res.status(404).json({ error: r.error }); return; }
  res.json({ ok: true });
});

adminRouter.post("/customers/:id/deactivate", async (req, res) => {
  const actor = await actorFor(req as AuthedRequest);
  const r = await deactivateCustomer(pool, actor, controls, req.params.id);
  if (!r.ok) { res.status(404).json({ error: r.error }); return; }
  res.json({ ok: true });
});

adminRouter.post("/customers/:id/reactivate", async (req, res) => {
  const actor = await actorFor(req as AuthedRequest);
  const r = await reactivateCustomer(pool, actor, req.params.id);
  if (!r.ok) { res.status(404).json({ error: r.error }); return; }
  res.json({ ok: true });
});

// Hard delete: gated server-side by the same confirm-to-type the UI enforces
// (body.confirmText must equal the business name exactly). Never touches Meta.
adminRouter.delete("/customers/:id", async (req, res) => {
  const actor = await actorFor(req as AuthedRequest);
  const confirmText = String(req.body?.confirmText ?? "");
  const r = await deleteCustomer(pool, actor, req.params.id, confirmText);
  if (!r.ok) { res.status(r.error === "customer not found" ? 404 : 400).json({ error: r.error }); return; }
  res.json({ ok: true });
});

// Per-customer audit trail (full cross-entity filterable log is AIC-47).
adminRouter.get("/customers/:id/audit", async (req, res) => {
  res.json({ entries: await listAuditLog(pool, { entityId: req.params.id }) });
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

// Full Meta data explorer (AIC-45): the unrestricted internal deep view —
// live from Meta on every open/refresh (the one deliberate exception to
// "never a live Meta call at render time," see campaign-explorer.ts). Never a
// write; a missing token or an unmanaged/unlinked campaign degrades honestly
// via `unavailableReason` rather than a 500 or a fabricated tree.
adminRouter.get("/campaigns/:id/explorer", async (req, res) => {
  const result = await buildCampaignExplorer(pool, req.params.id);
  if (!result) {
    res.status(404).json({ error: "campaign not found" });
    return;
  }
  res.json(result);
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
