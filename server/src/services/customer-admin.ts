import type pg from "pg";
import type { ControlService } from "../execution/control-service.js";
import { logAdminAction, type Actor } from "./admin-audit.js";
import { RULE_THRESHOLDS } from "../recommendations/rules.js";

// Customer lifecycle management (AIC-44): create / edit / deactivate / delete.
// Expands the read-only AIC-16 view into the operator's actual daily tool for
// manual onboarding and support. Every write here logs an admin_audit_log row —
// deliberately in the same transaction-adjacent call, not bolted on later,
// because AIC-47's audit log is only trustworthy if nothing here is unlogged.

export interface CustomerWriteFields {
  businessName?: string;
  category?: string;
  mainService?: string;
  geoArea?: string;
  primaryCustomer?: string;
  offer?: string;
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
  isTest?: boolean;
  onboardingStatus?: string;
  /** Managed campaign's agreed ceiling, in agorot. Written straight to
   * managed_campaigns.agreed_budget_agorot, which execution/budget.ts reads
   * live on every safety check — no cache to invalidate, so this propagates
   * to the engine's spend limit immediately. */
  agreedBudgetAgorot?: number;
  /** Per-account overrides for the recommendation engine's rule thresholds
   * (AIC-77a) — sparse, only the keys being overridden. Written straight to
   * managed_campaigns.threshold_overrides, which rule-evaluator.ts/staleness.ts
   * resolve on every generation tick via resolveThresholds(). Validated against
   * RULE_THRESHOLDS's known keys before any write (see updateCustomer). */
  thresholdOverrides?: Record<string, number>;
  /** AIC-103's campaign-type required fields — the fix-it surface for a
   * campaign the health check found incomplete (missingConfigFields). Written
   * straight to managed_campaigns, same propagate-by-column pattern as budget/
   * thresholds above. Undefined = leave unchanged; '' clears a string field. */
  websiteUrl?: string;
  trackingPixelId?: string;
  whatsappDestination?: string;
  leadEventTypes?: string[];
}

// Rejects an unknown key or a non-finite value before any write happens — an
// admin edit is all-or-nothing, never a partial write with a silently-dropped
// bad entry.
function validateThresholdOverrides(overrides: Record<string, number>): string | null {
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in RULE_THRESHOLDS)) return `unknown threshold key: "${key}"`;
    if (typeof value !== "number" || !Number.isFinite(value)) return `"${key}" must be a finite number`;
  }
  return null;
}

export type WriteResult = { ok: true } | { ok: false; error: string };

export async function createCustomer(
  pool: pg.Pool,
  actor: Actor,
  fields: CustomerWriteFields,
): Promise<{ id: string }> {
  const businessName = fields.businessName?.trim();
  if (!businessName) throw new Error("businessName is required");

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO customers
       (business_name, category, main_service, geo_area, primary_customer, offer,
        contact_name, contact_phone, contact_email, is_test, onboarding_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, COALESCE($11,'call_scheduled'))
     RETURNING id`,
    [
      businessName,
      fields.category ?? "",
      fields.mainService ?? "",
      fields.geoArea ?? "",
      fields.primaryCustomer ?? "",
      fields.offer ?? "",
      fields.contactName ?? "",
      fields.contactPhone ?? "",
      fields.contactEmail ?? "",
      fields.isTest ?? false,
      fields.onboardingStatus ?? null,
    ],
  );
  const id = rows[0].id;

  await logAdminAction(pool, {
    actorUserId: actor.userId,
    actorLabel: actor.label,
    action: "customer.create",
    entityType: "customer",
    entityId: id,
    entityLabel: businessName,
    afterState: { ...fields, businessName },
    detail: `Created customer "${businessName}" (manual onboarding entry point)`,
  });
  return { id };
}

export async function updateCustomer(
  pool: pg.Pool,
  actor: Actor,
  customerId: string,
  fields: CustomerWriteFields,
): Promise<WriteResult> {
  const before = await pool.query(`SELECT * FROM customers WHERE id = $1`, [customerId]);
  const b = before.rows[0];
  if (!b) return { ok: false, error: "customer not found" };

  // Validated BEFORE any write — an admin edit is all-or-nothing, never a
  // partial write with a silently-dropped bad threshold key.
  if (fields.thresholdOverrides != null) {
    const err = validateThresholdOverrides(fields.thresholdOverrides);
    if (err) return { ok: false, error: err };
  }

  await pool.query(
    `UPDATE customers SET
       business_name     = COALESCE($2, business_name),
       category          = COALESCE($3, category),
       main_service      = COALESCE($4, main_service),
       geo_area          = COALESCE($5, geo_area),
       primary_customer  = COALESCE($6, primary_customer),
       offer             = COALESCE($7, offer),
       contact_name      = COALESCE($8, contact_name),
       contact_phone     = COALESCE($9, contact_phone),
       contact_email     = COALESCE($10, contact_email),
       is_test           = COALESCE($11, is_test),
       onboarding_status = COALESCE($12, onboarding_status)
     WHERE id = $1`,
    [
      customerId,
      fields.businessName?.trim() ?? null,
      fields.category ?? null,
      fields.mainService ?? null,
      fields.geoArea ?? null,
      fields.primaryCustomer ?? null,
      fields.offer ?? null,
      fields.contactName ?? null,
      fields.contactPhone ?? null,
      fields.contactEmail ?? null,
      fields.isTest ?? null,
      fields.onboardingStatus ?? null,
    ],
  );

  // Budget/plan edits propagate to the engine's safety limit + the customer
  // dashboard by writing the SAME column both already read — no separate
  // "propagate" step needed. No managed_campaign yet → silently no-op (the
  // customer field edits above still apply); the caller sees which happened
  // via the returned budgetPropagated flag folded into the audit detail.
  let budgetPropagated = false;
  if (fields.agreedBudgetAgorot != null) {
    const r = await pool.query(
      `UPDATE managed_campaigns SET agreed_budget_agorot = $2 WHERE customer_id = $1`,
      [customerId, fields.agreedBudgetAgorot],
    );
    budgetPropagated = (r.rowCount ?? 0) > 0;
  }

  // Same propagate-by-writing-the-column-the-engine-reads shape as the budget
  // block above (AIC-77a) — resolveThresholds() reads this on every generation
  // tick, no cache to invalidate.
  let thresholdsPropagated = false;
  if (fields.thresholdOverrides != null) {
    const r = await pool.query(
      `UPDATE managed_campaigns SET threshold_overrides = $2 WHERE customer_id = $1`,
      [customerId, JSON.stringify(fields.thresholdOverrides)],
    );
    thresholdsPropagated = (r.rowCount ?? 0) > 0;
  }

  // AIC-103's fix-it surface: an operator closing a missingConfigFields gap
  // the health check found. Each field is independent — editing just
  // websiteUrl doesn't require also re-sending the other three.
  const configPropagated = { websiteUrl: false, trackingPixelId: false, whatsappDestination: false, leadEventTypes: false };
  if (fields.websiteUrl != null) {
    const r = await pool.query(`UPDATE managed_campaigns SET website_url = $2 WHERE customer_id = $1`, [customerId, fields.websiteUrl]);
    configPropagated.websiteUrl = (r.rowCount ?? 0) > 0;
  }
  if (fields.trackingPixelId != null) {
    const r = await pool.query(`UPDATE managed_campaigns SET tracking_pixel_id = $2 WHERE customer_id = $1`, [customerId, fields.trackingPixelId]);
    configPropagated.trackingPixelId = (r.rowCount ?? 0) > 0;
  }
  if (fields.whatsappDestination != null) {
    const r = await pool.query(`UPDATE managed_campaigns SET whatsapp_destination = $2 WHERE customer_id = $1`, [customerId, fields.whatsappDestination]);
    configPropagated.whatsappDestination = (r.rowCount ?? 0) > 0;
  }
  if (fields.leadEventTypes != null) {
    const r = await pool.query(`UPDATE managed_campaigns SET lead_event_types = $2 WHERE customer_id = $1`, [customerId, fields.leadEventTypes]);
    configPropagated.leadEventTypes = (r.rowCount ?? 0) > 0;
  }

  const after = await pool.query(`SELECT * FROM customers WHERE id = $1`, [customerId]);
  const a = after.rows[0];

  const budgetNote =
    fields.agreedBudgetAgorot != null
      ? budgetPropagated
        ? ` · agreed budget → ${fields.agreedBudgetAgorot} agorot`
        : ` · agreed budget change requested but no managed campaign exists yet`
      : "";

  const thresholdNote =
    fields.thresholdOverrides != null
      ? thresholdsPropagated
        ? ` · threshold overrides → ${JSON.stringify(fields.thresholdOverrides)}`
        : ` · threshold override change requested but no managed campaign exists yet`
      : "";

  const configChanges: string[] = [];
  if (fields.websiteUrl != null) configChanges.push(configPropagated.websiteUrl ? `website_url → ${fields.websiteUrl || "(cleared)"}` : "website_url change requested but no managed campaign exists yet");
  if (fields.trackingPixelId != null) configChanges.push(configPropagated.trackingPixelId ? `tracking_pixel_id → ${fields.trackingPixelId || "(cleared)"}` : "tracking_pixel_id change requested but no managed campaign exists yet");
  if (fields.whatsappDestination != null) configChanges.push(configPropagated.whatsappDestination ? `whatsapp_destination → ${fields.whatsappDestination || "(cleared)"}` : "whatsapp_destination change requested but no managed campaign exists yet");
  if (fields.leadEventTypes != null) configChanges.push(configPropagated.leadEventTypes ? `lead_event_types → ${JSON.stringify(fields.leadEventTypes)}` : "lead_event_types change requested but no managed campaign exists yet");
  const configNote = configChanges.length > 0 ? ` · ${configChanges.join(" · ")}` : "";

  await logAdminAction(pool, {
    actorUserId: actor.userId,
    actorLabel: actor.label,
    action: "customer.edit",
    entityType: "customer",
    entityId: customerId,
    entityLabel: a.business_name,
    beforeState: b,
    afterState: a,
    detail: `Edited "${a.business_name}"${budgetNote}${thresholdNote}${configNote}`,
  });
  return { ok: true };
}

// Soft-deactivate (reversible): the default path for a churned/paused account.
// Ties into AIC-14's emergency controls — marking the campaign unmanaged is
// what actually stops both generation (excluded from listEligibleForGeneration)
// and execution (assertExecutable throws for status='unmanaged').
export async function deactivateCustomer(
  pool: pg.Pool,
  actor: Actor,
  controls: ControlService,
  customerId: string,
): Promise<WriteResult> {
  const { rows } = await pool.query<{ business_name: string; is_active: boolean }>(
    `SELECT business_name, is_active FROM customers WHERE id = $1`,
    [customerId],
  );
  const c = rows[0];
  if (!c) return { ok: false, error: "customer not found" };
  if (!c.is_active) return { ok: true }; // idempotent

  await pool.query(`UPDATE customers SET is_active = false, deactivated_at = now() WHERE id = $1`, [customerId]);

  const camp = await pool.query<{ id: string }>(`SELECT id FROM managed_campaigns WHERE customer_id = $1`, [customerId]);
  if (camp.rows[0]) await controls.markUnmanaged(camp.rows[0].id);

  await logAdminAction(pool, {
    actorUserId: actor.userId,
    actorLabel: actor.label,
    action: "customer.deactivate",
    entityType: "customer",
    entityId: customerId,
    entityLabel: c.business_name,
    detail: `Deactivated "${c.business_name}"${camp.rows[0] ? " — campaign marked unmanaged (monitoring + execution stopped)" : ""}`,
  });
  return { ok: true };
}

// Reversal of deactivateCustomer. Deliberately does NOT auto-resume the
// campaign — un-pausing ad spend is a decision the operator makes explicitly
// via the campaign's own controls, not a side-effect of flipping a customer flag.
export async function reactivateCustomer(pool: pg.Pool, actor: Actor, customerId: string): Promise<WriteResult> {
  const { rows } = await pool.query<{ business_name: string }>(`SELECT business_name FROM customers WHERE id = $1`, [customerId]);
  const c = rows[0];
  if (!c) return { ok: false, error: "customer not found" };

  await pool.query(`UPDATE customers SET is_active = true, deactivated_at = NULL WHERE id = $1`, [customerId]);

  await logAdminAction(pool, {
    actorUserId: actor.userId,
    actorLabel: actor.label,
    action: "customer.reactivate",
    entityType: "customer",
    entityId: customerId,
    entityLabel: c.business_name,
    detail: `Reactivated "${c.business_name}" — campaign management stays as-is; resume it via campaign controls if desired`,
  });
  return { ok: true };
}

// Hard delete: the rare, deliberate exception (default is deactivateCustomer).
// Gated by a server-side confirm-to-type check — the client UI enforces it too,
// but the check must hold even if a client is bypassed. Never touches Meta: we
// stop managing the customer's assets, we do not delete them (they're not ours).
export async function deleteCustomer(
  pool: pg.Pool,
  actor: Actor,
  customerId: string,
  confirmText: string,
): Promise<WriteResult> {
  const { rows } = await pool.query(`SELECT * FROM customers WHERE id = $1`, [customerId]);
  const c = rows[0];
  if (!c) return { ok: false, error: "customer not found" };
  if (confirmText.trim() !== c.business_name) {
    return { ok: false, error: "confirmation text does not match the business name" };
  }

  // Snapshot what cascades away (subscriptions/meta_connections/managed_campaigns
  // and everything under them) so the audit trail is still legible afterward —
  // this row is deliberately the ONLY thing that survives the delete.
  const [subs, conn, camp] = await Promise.all([
    pool.query(`SELECT * FROM subscriptions WHERE customer_id = $1`, [customerId]),
    pool.query(`SELECT * FROM meta_connections WHERE customer_id = $1`, [customerId]),
    pool.query(`SELECT * FROM managed_campaigns WHERE customer_id = $1`, [customerId]),
  ]);
  const snapshot = {
    customer: c,
    subscription: subs.rows[0] ?? null,
    connection: conn.rows[0] ?? null,
    campaign: camp.rows[0] ?? null,
  };

  await pool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);

  await logAdminAction(pool, {
    actorUserId: actor.userId,
    actorLabel: actor.label,
    action: "customer.delete",
    entityType: "customer",
    entityId: customerId,
    entityLabel: c.business_name,
    beforeState: snapshot,
    detail: `Hard-deleted "${c.business_name}" (confirm-to-type verified). Meta assets were not touched — only our records.`,
  });
  return { ok: true };
}
