import { Router } from "express";
import { pool } from "../db/pool.js";
import { setObjectStatus, assertOwnedByCampaign } from "../controls/manual-controls.js";
import type { ControlObjectKind, ControlWriter } from "../controls/types.js";
import type { DeliveryReader } from "../meta/delivery-health.js";
import { buildAdditionWriter } from "../additions/session.js";
import { requireAdmin, requireFullAdmin } from "../middleware/admin.js";
import type { AuthedRequest } from "../middleware/auth.js";
import {
  buildCampaignReadout,
  listCampaignsForAdmin,
} from "../services/readout.js";
import { ControlService, PgControlStore } from "../execution/control-service.js";
import { listCampaignActionHistory, condense } from "../services/action-history.js";
import { listCustomers, getCustomerDetail } from "../services/customers.js";
import { createCustomer, updateCustomer, deactivateCustomer, reactivateCustomer, deleteCustomer } from "../services/customer-admin.js";
import { listAuditLog, logAdminAction, type Actor } from "../services/admin-audit.js";
import { listOperators, addOperator, setOperatorRole, removeOperator } from "../services/operator-accounts.js";
import { PgUserStore, type AdminRole } from "../auth/user-store.js";
import { OpsQueue } from "../services/ops-queue.js";
import { refreshDeliveryNow } from "../services/delivery-monitor.js";
import { consoleLogger } from "../services/logger.js";
import { submitReview, recordCustomerDecision, getLatestReview } from "../services/campaign-review.js";
import { updateBilling, conversionSummary, upsertLeadQuality, listLeadQuality, leadQualityResponseRate } from "../services/billing.js";
import { buildFleetOverview } from "../services/fleet-overview.js";
import { buildCampaignExplorer } from "../services/campaign-explorer.js";
import { listRecommendationsForAdmin, flagRecommendation, unflagRecommendation, getOutcomeAggregate } from "../services/recommendation-oversight.js";
import { RECOMMENDATION_STATE, RECOMMENDATION_TYPE, type RecommendationState, type RecommendationType } from "@aic/shared";

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

  // Emergency-control use is one of the console actions AIC-47's audit log is
  // explicitly meant to capture — best-effort: the control already took
  // effect, so a lookup/log failure here must never turn into a false error.
  try {
    const actor = await actorFor(req as AuthedRequest);
    const camp = await pool.query<{ name: string; business_name: string }>(
      `SELECT mc.name, c.business_name FROM managed_campaigns mc JOIN customers c ON c.id = mc.customer_id WHERE mc.id = $1`,
      [req.params.id],
    );
    await logAdminAction(pool, {
      actorUserId: actor.userId, actorLabel: actor.label,
      action: `campaign.control.${action}`, entityType: "campaign", entityId: req.params.id,
      entityLabel: camp.rows[0] ? `${camp.rows[0].business_name} — ${camp.rows[0].name}` : req.params.id,
      detail: `Emergency control: ${action}`,
    });
  } catch (e) {
    console.error("[admin] failed to log emergency-control action", e);
  }

  res.json({ ok: true, action });
});

// Manual object controls (AIC-66) — operator half. Pause/resume mirror the
// customer's own controls; archive/delete exist ONLY here.
//
// Gate: `requireAdmin` (already applied to this whole router) plus
// confirm-to-type for the destructive statuses — deliberately the same bar
// AIC-44 set for hard-deleting an entire customer, which is a strictly bigger
// action than archiving one ad. `requireFullAdmin` stays reserved for
// operator-account management, as its own comment specifies.
//
// Archive is preferred over delete: ARCHIVED keeps history and is recoverable,
// DELETED is not. The UI defaults to archive; delete is the deliberate harder
// option. Either way the object then drops out of counts/needs-attention via
// AIC-65's isManaged filtering — the write and the read-layer filter are two
// halves of one behaviour.
const DESTRUCTIVE: Record<string, "ARCHIVED" | "DELETED"> = { archive: "ARCHIVED", delete: "DELETED" };
const REVERSIBLE: Record<string, "PAUSED" | "ACTIVE"> = { pause: "PAUSED", resume: "ACTIVE" };

adminRouter.post("/campaigns/:id/objects/:action", async (req, res) => {
  const action = String(req.params.action);
  const status = REVERSIBLE[action] ?? DESTRUCTIVE[action];
  if (!status) {
    res.status(400).json({ error: "unknown action", allowed: [...Object.keys(REVERSIBLE), ...Object.keys(DESTRUCTIVE)] });
    return;
  }
  const kind = String(req.body?.kind ?? "") as ControlObjectKind;
  const metaObjectId = String(req.body?.metaObjectId ?? "");
  if ((kind !== "ad" && kind !== "ad_set") || !metaObjectId) {
    res.status(400).json({ error: "kind must be 'ad' or 'ad_set', and metaObjectId is required" });
    return;
  }

  const camp = await pool.query<{ meta_campaign_id: string | null; name: string; business_name: string; customer_id: string }>(
    `SELECT mc.meta_campaign_id, mc.name, mc.customer_id, c.business_name
     FROM managed_campaigns mc JOIN customers c ON c.id = mc.customer_id WHERE mc.id = $1`,
    [req.params.id],
  );
  const campaign = camp.rows[0];
  if (!campaign?.meta_campaign_id) {
    res.status(404).json({ error: "campaign not found or not linked to Meta" });
    return;
  }

  // Destructive actions require typing the object id back — the same
  // confirm-to-type gate as customer delete (AIC-44), enforced server-side so
  // it holds even if a client is bypassed.
  if (DESTRUCTIVE[action] && String(req.body?.confirm ?? "").trim() !== metaObjectId) {
    res.status(400).json({ error: "confirmation does not match the object id" });
    return;
  }

  const writer = buildAdditionWriter() as (ControlWriter & DeliveryReader) | null;
  if (!writer) {
    res.status(503).json({ error: "Meta not configured" });
    return;
  }
  if (!(await assertOwnedByCampaign(writer, campaign.meta_campaign_id, kind, metaObjectId))) {
    res.status(404).json({ error: "object not found under this campaign" });
    return;
  }

  const actor = await actorFor(req as AuthedRequest);
  const result = await setObjectStatus({
    pool, writer, campaignId: req.params.id, kind, metaObjectId, status,
    actor: { kind: "operator", label: actor.label },
  });

  // Both logs (see the audit-log comment below): action_history already got the
  // campaign-scoped row inside setObjectStatus; this is the console-scoped one.
  // Best-effort — the Meta change already happened, so a logging failure must
  // never be reported as an action failure.
  if (result.outcome !== "failed") {
    try {
      await logAdminAction(pool, {
        actorUserId: actor.userId, actorLabel: actor.label,
        // entity_id is a UUID column, and a Meta object id isn't one — so the
        // entity here is our own campaign, with the Meta object carried in the
        // label/detail. That's also the cross-link to the action_history row,
        // which records the same campaign_id + target_meta_id.
        action: `${kind}.${action}`, entityType: kind, entityId: req.params.id,
        entityLabel: `${campaign.business_name} — ${campaign.name} · ${metaObjectId}`,
        beforeState: { status: result.previousStatus },
        afterState: { status: result.newStatus ?? status },
        detail: `Manual ${action} of ${kind} ${metaObjectId}${result.outcome === "already" ? " (already in that state)" : ""}`,
      });
    } catch (e) {
      console.error("[admin] failed to log manual object control", e);
    }
  }

  if (result.outcome === "failed") {
    res.status(502).json({ outcome: result.outcome, detail: result.detail });
    return;
  }

  // Same catch-up as the customer surface (AIC-71 follow-up): an operator
  // pause/resume/archive/delete shouldn't leave the customer's "מצב" headline
  // stale until the next hourly tick either.
  if (result.outcome === "changed") {
    await refreshDeliveryNow({
      pool, ops: opsQueue, deliveryReader: writer, campaignId: req.params.id,
      customerId: campaign.customer_id, metaCampaignId: campaign.meta_campaign_id,
    });
  }

  res.json({ outcome: result.outcome, status: result.newStatus ?? status });
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

// Recommendations oversight (AIC-46): every rec across every customer, its
// evidence, and its lifecycle status. Read + flag only — no operator-
// initiated execute here (see recommendation-oversight.ts for why).
adminRouter.get("/recommendations", async (req, res) => {
  const { state, type, customerId } = req.query as Record<string, string | undefined>;
  const validState = RECOMMENDATION_STATE.includes(state as RecommendationState) ? (state as RecommendationState) : undefined;
  const validType = RECOMMENDATION_TYPE.includes(type as RecommendationType) ? (type as RecommendationType) : undefined;
  res.json({
    recommendations: await listRecommendationsForAdmin(pool, {
      state: validState, type: validType, customerId: customerId || undefined,
    }),
  });
});

// AIC-76: fleet-wide "did the engine's changes actually help?" summary —
// its own query (see getOutcomeAggregate), not derived from the list above.
adminRouter.get("/recommendations/outcomes-summary", async (_req, res) => {
  res.json({ byType: await getOutcomeAggregate(pool) });
});

adminRouter.post("/recommendations/:id/flag", async (req, res) => {
  const actor = await actorFor(req as AuthedRequest);
  const r = await flagRecommendation(pool, actor, req.params.id, String(req.body?.note ?? "").trim());
  if (!r.ok) { res.status(404).json({ error: r.error }); return; }
  res.json({ ok: true });
});

adminRouter.post("/recommendations/:id/unflag", async (req, res) => {
  const actor = await actorFor(req as AuthedRequest);
  const r = await unflagRecommendation(pool, actor, req.params.id);
  if (!r.ok) { res.status(404).json({ error: r.error }); return; }
  res.json({ ok: true });
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

// Operator accounts (AIC-47). Any admin can see who else has console access
// (transparency); only a full_admin can add/promote/remove — the one
// deliberate role gate in this console (requireFullAdmin, not a general RBAC
// system — see middleware/admin.ts).
adminRouter.get("/operators", async (_req, res) => {
  res.json({ operators: await listOperators(pool) });
});

adminRouter.post("/operators", requireFullAdmin, async (req, res) => {
  const actor = await actorFor(req as AuthedRequest);
  const email = String(req.body?.email ?? "").trim();
  const role: AdminRole = req.body?.role === "full_admin" ? "full_admin" : "operator";
  if (!email) { res.status(400).json({ error: "email required" }); return; }
  const r = await addOperator(pool, actor, email, role);
  if (!r.ok) { res.status(400).json({ error: r.error }); return; }
  res.status(201).json({ ok: true });
});

adminRouter.post("/operators/:id/role", requireFullAdmin, async (req, res) => {
  const actor = await actorFor(req as AuthedRequest);
  const role: AdminRole = req.body?.role === "full_admin" ? "full_admin" : "operator";
  const r = await setOperatorRole(pool, actor, String(req.params.id), role);
  if (!r.ok) { res.status(r.error === "operator not found" ? 404 : 400).json({ error: r.error }); return; }
  res.json({ ok: true });
});

adminRouter.delete("/operators/:id", requireFullAdmin, async (req, res) => {
  const actor = await actorFor(req as AuthedRequest);
  const r = await removeOperator(pool, actor, String(req.params.id));
  if (!r.ok) { res.status(r.error === "operator not found" ? 404 : 400).json({ error: r.error }); return; }
  res.json({ ok: true });
});

// Full cross-entity, filterable admin audit log (AIC-47) — every write
// AIC-44/46/47 logs, queryable by operator and by entity type/id. Distinct
// from the customer-facing/campaign action_history (Meta changes); this is
// console actions. **AIC-66's manual object controls are the first action that
// writes BOTH logs**: an operator pausing/archiving a real ad is simultaneously
// a console action (audited here, entityType `ad`/`ad_set`) and a Meta campaign
// change (action_history, so it shows in the customer's own history). Cross-
// reference by campaign id — both logs record it — with the Meta object id in
// this log's entity_label (entity_id is a UUID column; Meta ids are not UUIDs).
adminRouter.get("/audit", async (req, res) => {
  const { actorUserId, entityType, entityId } = req.query as Record<string, string | undefined>;
  res.json({ entries: await listAuditLog(pool, { actorUserId, entityType, entityId }) });
});
