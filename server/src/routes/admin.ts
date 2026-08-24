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
import { listAppUsers, ensureCustomerForUser, deleteUserRecords, type DeleteUserMode } from "../services/users-admin.js";
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
import { AccessProbe } from "../meta/access-probe.js";
import { REQUIRED_SCOPES, type CheckedAsset } from "../meta/access-layers.js";
import { OUR_BUSINESS_PORTFOLIO_ID, OUR_SYSTEM_USER_ID } from "../config/meta-identity.js";
import {
  getOrCreateOnboarding, setStep, recordCheck, markComplete,
  provisionConnection, PageNotReadableError, InstagramNotReadableError,
  IncompleteProvisioningError, CHECK_FOR_ASSET,
} from "../services/customer-onboarding.js";
import { ConnectionService } from "../meta/connection-service.js";
import { PgConnectionStore } from "../meta/connection-store.js";
import { GraphMetaClient } from "../meta/client.js";
import { buildCampaignDiscoveryReader } from "../meta/campaign-discovery.js";

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

// Users view — separate from Customers (explicit product decision, 2026-08-16):
// every signed-up login (app_users), joined out to their business/connection/
// subscription if they have one. Surfaces a real signup with no business yet,
// which the customers-only view can't show.
adminRouter.get("/users", async (_req, res) => {
  res.json({ users: await listAppUsers(pool) });
});

// The bridge into the onboarding wizard (AIC-101), which is keyed by
// customerId — a user with none yet gets a bare business row created and
// linked on first click, idempotent on repeat clicks.
adminRouter.post("/users/:id/customer", async (req, res) => {
  const actor = await actorFor(req as AuthedRequest);
  try {
    const r = await ensureCustomerForUser(pool, actor, req.params.id);
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "failed to provision customer for user" });
  }
});

// AIC-127: reset/delete a signup from the Users view, for putting an account
// back to a known state so the onboarding wizard can be walked again. Two
// modes ("business" keeps the login, "all" removes it); confirm-to-type the
// EMAIL, verified server-side because this is irreversible and the client can
// be bypassed. Never touches Meta — see deleteUserRecords.
//
// DELETE with a body: the confirmation text has to travel with the request and
// must not end up in a URL or an access log. Same shape as
// DELETE /customers/:id above.
adminRouter.delete("/users/:id", async (req, res) => {
  const actor = await actorFor(req as AuthedRequest);
  const mode = req.body?.mode === "all" ? "all" : "business";
  const confirmText = String(req.body?.confirmText ?? "");
  try {
    const r = await deleteUserRecords(pool, actor, req.params.id, mode as DeleteUserMode, confirmText);
    if (!r.ok) { res.status(r.error === "user not found" ? 404 : 400).json({ error: r.error }); return; }
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "failed to delete user records" });
  }
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

// ── Onboarding wizard (AIC-101 + AIC-68) ────────────────────────────────────
// The guided, live-verified connection call. Every step VERIFIES against the
// real Graph API rather than just rendering instructions — a wizard that only
// showed the runbook with nicer formatting would reproduce the exact failure
// it exists to prevent (docs/META_SETUP.md: "the Business Settings UI can look
// completely correct while the backend still has zero access").
//
// Internal only: mounted on adminRouter, so it inherits requireAdmin. The
// customer never sees this — they're on the phone looking at their own Meta
// settings while the operator reads the script.

function probeOrNull(): AccessProbe | null {
  const token = process.env.META_SYSTEM_USER_TOKEN;
  if (!token) return null;
  return new AccessProbe({ token, businessPortfolioId: OUR_BUSINESS_PORTFOLIO_ID, systemUserId: OUR_SYSTEM_USER_ID });
}

// Current wizard state — resumable: calls get interrupted (the customer has to
// find their password, or fetch whoever actually has admin), and losing the
// operator's place would make this worse than the markdown file it replaces.
adminRouter.get("/customers/:id/onboarding", async (req, res) => {
  const state = await getOrCreateOnboarding(pool, req.params.id);
  res.json({ state, businessPortfolioId: OUR_BUSINESS_PORTFOLIO_ID });
});

adminRouter.post("/customers/:id/onboarding/step", async (req, res) => {
  const step = Number(req.body?.step);
  if (!Number.isInteger(step) || step < 1) {
    res.status(400).json({ error: "step must be a positive integer" });
    return;
  }
  res.json({ state: await setStep(pool, req.params.id, step) });
});

// The live check. Runs all three layers against Meta for one asset and
// reports WHICH layer failed plus its specific fix — the difference between
// "connection failed" and "the customer hasn't shared the Page yet", on the
// call, while they can still act on it.
adminRouter.post("/customers/:id/onboarding/check", async (req, res) => {
  const asset = String(req.body?.asset ?? "") as CheckedAsset;
  const assetId = String(req.body?.assetId ?? "").trim();
  if (asset !== "page" && asset !== "ad_account" && asset !== "instagram") {
    res.status(400).json({ error: "asset must be 'page', 'ad_account' or 'instagram'" });
    return;
  }
  if (!assetId) {
    res.status(400).json({ error: "assetId is required" });
    return;
  }

  const probe = probeOrNull();
  if (!probe) {
    // No token configured is an OPERATOR-side problem, not a customer one —
    // never let it render as "the customer didn't share the asset".
    res.status(503).json({ error: "META_SYSTEM_USER_TOKEN is not configured" });
    return;
  }

  try {
    await getOrCreateOnboarding(pool, req.params.id);
    const result = await probe.probeAsset(asset, assetId);
    const state = await recordCheck(
      pool, req.params.id, CHECK_FOR_ASSET[asset], result.verdict, result.detail, assetId,
    );
    res.json({ result, state });
  } catch (e) {
    console.error("[admin] onboarding check failed", e);
    res.status(502).json({ error: "the access check could not be completed" });
  }
});

// Layer 3 on its own: what scopes does the token actually carry? Separate
// endpoint because this is the one failure that asset assignment can NEVER
// fix — it needs a token regeneration + Railway secret rotation, and that
// isn't inferable from the error message Meta returns.
adminRouter.post("/customers/:id/onboarding/token-check", async (req, res) => {
  const probe = probeOrNull();
  if (!probe) {
    res.status(503).json({ error: "META_SYSTEM_USER_TOKEN is not configured" });
    return;
  }
  const scopes = await probe.tokenScopes();
  const missing = scopes === null
    ? null
    : (["ad_account", "page"] as CheckedAsset[]).flatMap((a) =>
        REQUIRED_SCOPES[a].filter((s) => !scopes.includes(s)));
  const ok = scopes !== null && (missing?.length ?? 1) === 0;

  await getOrCreateOnboarding(pool, req.params.id);
  const state = await recordCheck(
    pool, req.params.id, "token",
    ok
      ? { ok: true, layer: null, diagnosis: "ok" }
      : { ok: false, layer: 3, diagnosis: scopes === null ? "unknown" : "token_missing_scopes" },
    scopes === null ? "could not read the token's scopes" : `missing: ${missing!.join(", ") || "none"}`,
    null, // no single asset id — this checks the token itself
  );
  res.json({ scopes, missing, ok, state });
});

// Step 4 — provision the records (AIC-68). This is what replaces hand-written
// SQL against production, which is how a blank page_id shipped unnoticed.
//
// The page_id is re-verified HERE, immediately before the write, rather than
// trusting an earlier passing check or anything the client sends: the whole
// failure mode is that access looks fine and isn't.
adminRouter.post("/customers/:id/onboarding/provision", async (req, res) => {
  const b = req.body ?? {};
  const pageId = b.pageId ? String(b.pageId).trim() : null;

  if (!b.metaAdAccountId) {
    res.status(400).json({ error: "metaAdAccountId is required" });
    return;
  }
  // AIC-105 Branch A: a campaign is optional — omitted entirely means
  // "connect the account only", the precondition for launching the builder
  // to create the customer's first campaign. metaCampaignId is the
  // discriminator; campaignName/budget/destinationType are only validated
  // when it's present.
  const hasCampaign = !!b.metaCampaignId;
  if (hasCampaign && !b.campaignName) {
    res.status(400).json({ error: "campaignName is required when metaCampaignId is provided" });
    return;
  }
  let budget: number | undefined;
  let destinationType: "whatsapp" | "website" | "engagement" | undefined;
  if (hasCampaign) {
    budget = Number(b.agreedBudgetAgorot);
    if (!Number.isInteger(budget) || budget <= 0) {
      res.status(400).json({ error: "agreedBudgetAgorot must be a positive integer (agorot)" });
      return;
    }
    // AIC-103: not a free-text-with-a-default anymore — the wizard must ask
    // "where does someone land after clicking your ad?" and get a real
    // answer, since that answer decides which fields below are required.
    destinationType = b.destinationType === "website" ? "website"
      : b.destinationType === "whatsapp" ? "whatsapp"
      : b.destinationType === "engagement" ? "engagement"
      : undefined;
    if (!destinationType) {
        res.status(400).json({ error: "destinationType ('whatsapp', 'website' or 'engagement') is required" });
      return;
    }
  } else if (b.agreedBudgetAgorot !== undefined && b.agreedBudgetAgorot !== null && b.agreedBudgetAgorot !== "") {
    // AIC-106 — connect-only (Branch A). Optional at this layer: an
    // omitted value is unchanged behaviour (no shell row created — see
    // provisionConnection). But a VALUE that was sent and is invalid must
    // still be rejected, the same as the hasCampaign case, rather than
    // silently passed through as undefined and discovered only much later
    // at build time on an unrelated screen — the exact live bug this fixes.
    // No destinationType here — that only applies once a real campaign is
    // being provisioned.
    budget = Number(b.agreedBudgetAgorot);
    if (!Number.isInteger(budget) || budget <= 0) {
      res.status(400).json({ error: "agreedBudgetAgorot must be a positive integer (agorot) when provided" });
      return;
    }
  }

  // AIC-108: instagram_id is re-verified here for exactly the same reason
  // page_id is — a failing read feeds the same worst-health-wins fold and
  // flips the whole connection to `revoked`. Both are checked immediately
  // before the write, never trusted from an earlier pass or the client.
  const instagramId = b.instagramId ? String(b.instagramId).trim() : null;
  let pageVerdict = null as Awaited<ReturnType<AccessProbe["probeAsset"]>>["verdict"] | null;
  let instagramVerdict = null as Awaited<ReturnType<AccessProbe["probeAsset"]>>["verdict"] | null;
  if (pageId || instagramId) {
    const probe = probeOrNull();
    if (!probe) {
      res.status(503).json({ error: "META_SYSTEM_USER_TOKEN is not configured" });
      return;
    }
    if (pageId) pageVerdict = (await probe.probeAsset("page", pageId)).verdict;
    if (instagramId) instagramVerdict = (await probe.probeAsset("instagram", instagramId)).verdict;
  }

  try {
    const result = await provisionConnection(pool, {
      customerId: req.params.id,
      systemUserId: String(b.systemUserId ?? process.env.META_SYSTEM_USER_ID ?? ""),
      businessPortfolioId: b.businessPortfolioId ? String(b.businessPortfolioId) : null,
      metaAdAccountId: String(b.metaAdAccountId),
      adAccountName: b.adAccountName ? String(b.adAccountName) : null,
      currency: b.currency ? String(b.currency) : null,
      pageId,
      instagramId,
      metaCampaignId: hasCampaign ? String(b.metaCampaignId) : undefined,
      campaignName: hasCampaign ? String(b.campaignName) : undefined,
      objective: b.objective ? String(b.objective) : undefined,
      agreedBudgetAgorot: budget,
      budgetPeriod: b.budgetPeriod === "monthly" ? "monthly" : "daily",
      leadEventTypes: Array.isArray(b.leadEventTypes) && b.leadEventTypes.length > 0
        ? b.leadEventTypes.map(String) : null,
      trackingPixelId: b.trackingPixelId ? String(b.trackingPixelId) : null,
      websiteUrl: b.websiteUrl ? String(b.websiteUrl) : null,
      destinationType,
      whatsappDestination: b.whatsappDestination ? String(b.whatsappDestination) : null,
    }, pageVerdict, instagramVerdict);

    const actor = await actorFor(req as AuthedRequest);
    await logAdminAction(pool, {
      actorUserId: actor.userId,
      actorLabel: actor.label,
      action: "customer.onboarding.provision",
      entityType: "customer",
      entityId: req.params.id,
      entityLabel: hasCampaign ? `${b.metaAdAccountId} / ${b.metaCampaignId}` : `${b.metaAdAccountId} (no campaign yet)`,
      // Records whether a page_id was saved AND the verdict that allowed it —
      // so "was the Page genuinely verified when this was provisioned" is
      // answerable later without re-deriving it.
      detail: JSON.stringify({ ...result, pageVerdict, instagramVerdict }),
    });

    res.json({ result });
  } catch (e) {
    if (e instanceof PageNotReadableError) {
      // 409, not 500: this is a refusal, and the operator can act on it.
      res.status(409).json({ error: e.message, diagnosis: e.diagnosis, pageVerdict });
      return;
    }
    // AIC-108: same refusal shape, tagged so the client can point at the
    // Instagram field rather than the Page one.
    if (e instanceof InstagramNotReadableError) {
      res.status(409).json({ error: e.message, diagnosis: e.diagnosis, asset: "instagram", instagramVerdict });
      return;
    }
    if (e instanceof IncompleteProvisioningError) {
      // 400, not 500: a validation refusal, same shape as the earlier
      // metaAdAccountId/budget checks — this is AIC-103's provisioning-time
      // enforcement point, not a server error.
      res.status(400).json({ error: e.message, missingFields: e.missingFields });
      return;
    }
    console.error("[admin] provisioning failed", e);
    res.status(500).json({ error: (e as Error).message });
  }
});

// AIC-105 Branch B — "pick, don't type". Every ad account the System User
// can currently manage (both AIC-101 access layers already passed), for
// step 4's picker. Annotates an account already provisioned to a DIFFERENT
// customer — informational only, never a block: AIC-87's migration 038
// deliberately allows one Meta ad account to back more than one customer
// (e.g. two of our own test rows share one), so this must not read as "you
// can't pick this", only "heads up, it's shared".
adminRouter.get("/customers/:id/onboarding/ad-accounts", async (req, res) => {
  const reader = buildCampaignDiscoveryReader();
  if (!reader) {
    res.status(503).json({ error: "META_SYSTEM_USER_TOKEN is not configured" });
    return;
  }
  try {
    const accounts = await reader.listAdAccounts();
    const { rows } = await pool.query<{ meta_ad_account_id: string; customer_id: string; business_name: string }>(
      `SELECT aa.meta_ad_account_id, c.id AS customer_id, c.business_name
         FROM ad_accounts aa
         JOIN meta_connections mc ON mc.id = aa.connection_id
         JOIN customers c ON c.id = mc.customer_id
        WHERE aa.meta_ad_account_id = ANY($1::text[]) AND c.id != $2`,
      [accounts.map((a) => a.id), req.params.id],
    );
    const usedBy = new Map(rows.map((r) => [r.meta_ad_account_id, { id: r.customer_id, name: r.business_name }]));
    res.json({
      accounts: accounts.map((a) => ({ ...a, usedByCustomer: usedBy.get(a.id) ?? null })),
    });
  } catch (e) {
    console.error("[admin] list ad accounts failed", e);
    res.status(502).json({ error: "failed to load ad accounts" });
  }
});

// The Page-side sibling of the ad-accounts picker, SCOPED to one ad account
// (`metaAdAccountId` required, same shape as the campaigns route below).
// The scoping is the point: an unscoped list offered one customer's Page
// while another customer's account was selected — found live. Deliberately
// NOT annotated with "already used by customer X" the way ad accounts are:
// `meta_connections.page_id` has no uniqueness constraint and one Page
// legitimately backs several customers, so there is no conflict to warn about.
adminRouter.get("/customers/:id/onboarding/pages", async (req, res) => {
  const metaAdAccountId = String(req.query.metaAdAccountId ?? "").trim();
  if (!metaAdAccountId) {
    res.status(400).json({ error: "metaAdAccountId is required" });
    return;
  }
  const reader = buildCampaignDiscoveryReader();
  if (!reader) {
    res.status(503).json({ error: "META_SYSTEM_USER_TOKEN is not configured" });
    return;
  }
  try {
    res.json({ pages: await reader.listPages(metaAdAccountId) });
  } catch (e) {
    console.error("[admin] list pages failed", e);
    res.status(502).json({ error: "failed to load pages" });
  }
});

// Every Instagram account attached to one ad account, so the operator picks
// instead of transcribing an 17-digit id. Same shape and same scoping rule as
// the Pages route above; the difference is that this edge is per-account by
// construction, so it needs no union — verified live 2026-08-19 that the two
// real ad accounts return different results on one token.
//
// Deliberately NOT filtered to "unused": instagram_id has no uniqueness
// constraint and one IG account can legitimately back several customers, so
// there is no conflict to warn about (same reasoning as Pages).
adminRouter.get("/customers/:id/onboarding/instagram-accounts", async (req, res) => {
  const metaAdAccountId = String(req.query.metaAdAccountId ?? "").trim();
  if (!metaAdAccountId) {
    res.status(400).json({ error: "metaAdAccountId is required" });
    return;
  }
  const reader = buildCampaignDiscoveryReader();
  if (!reader) {
    res.status(503).json({ error: "META_SYSTEM_USER_TOKEN is not configured" });
    return;
  }
  try {
    res.json({ instagramAccounts: await reader.listInstagramAccounts(metaAdAccountId) });
  } catch (e) {
    console.error("[admin] list instagram accounts failed", e);
    res.status(502).json({ error: "failed to load instagram accounts" });
  }
});

// Every campaign under one ad account, destination DETECTED per campaign
// (tracking-health.ts's detectDestination) rather than asked. An unsupported
// campaign (no ad sets yet, an objective that implies no lead, mixed ad
// sets) is still RETURNED, not filtered out — AIC-98's "never render a blank
// where a reason exists" applies to pickers too; the client disables it with
// its reason rather than making the list look shorter than it is.
adminRouter.get("/customers/:id/onboarding/campaigns", async (req, res) => {
  const metaAdAccountId = String(req.query.metaAdAccountId ?? "").trim();
  if (!metaAdAccountId) {
    res.status(400).json({ error: "metaAdAccountId is required" });
    return;
  }
  const reader = buildCampaignDiscoveryReader();
  if (!reader) {
    res.status(503).json({ error: "META_SYSTEM_USER_TOKEN is not configured" });
    return;
  }
  try {
    const campaigns = await reader.listCampaigns(metaAdAccountId);
    res.json({ campaigns });
  } catch (e) {
    console.error("[admin] list campaigns failed", e);
    res.status(502).json({ error: "failed to load campaigns" });
  }
});

// Step 5 — the real ConnectionService.verify(), the same check the engine
// relies on. Health ≠ ok sends the operator back to the failing layer rather
// than letting a half-connected customer look finished.
adminRouter.post("/customers/:id/onboarding/finalize", async (req, res) => {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM meta_connections WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [req.params.id],
  );
  if (rows.length === 0) {
    res.status(409).json({ error: "no connection to verify — provision first" });
    return;
  }
  const token = process.env.META_SYSTEM_USER_TOKEN;
  if (!token) {
    res.status(503).json({ error: "META_SYSTEM_USER_TOKEN is not configured" });
    return;
  }

  const service = new ConnectionService(new PgConnectionStore(pool), new GraphMetaClient(token));
  const health = await service.verify(rows[0].id);

  await getOrCreateOnboarding(pool, req.params.id);
  const state = await recordCheck(
    pool, req.params.id, "connection",
    health === "ok"
      ? { ok: true, layer: null, diagnosis: "ok" }
      : { ok: false, layer: null, diagnosis: `health_${health}` },
    null,
    null, // no single asset id — this checks the whole connection
  );
  // Only a genuinely verified connection completes the wizard — "onboarded"
  // is never inferred from rows someone created.
  if (health === "ok") await markComplete(pool, req.params.id);

  res.json({ health, state: health === "ok" ? await getOrCreateOnboarding(pool, req.params.id) : state });
});
