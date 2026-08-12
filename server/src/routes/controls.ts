import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { resolveAdditionContext, buildAdditionWriter } from "../additions/session.js";
import { setObjectStatus, assertOwnedByCampaign } from "../controls/manual-controls.js";
import type { ControlObjectKind, ControlWriter } from "../controls/types.js";
import type { DeliveryReader } from "../meta/delivery-health.js";
import { refreshDeliveryNow } from "../services/delivery-monitor.js";
import { OpsQueue } from "../services/ops-queue.js";

const ops = new OpsQueue(pool);

// Customer-facing manual controls (AIC-66): "turn this ad off / back on".
//
// The authorization model is the point. An engine-proposed change needs the
// customer's approval because the ENGINE proposed it; a customer pausing their
// OWN ad is itself the authorization, so there is no second approval gate.
// That keeps the product promise intact ("nothing changes without approval")
// rather than weakening it.
//
// PAUSE/RESUME ONLY on this surface. Archive/delete are destructive and
// irreversible, and live exclusively in the admin console (routes/admin.ts) —
// there is deliberately no customer-facing delete anywhere.
export const controlsRouter = Router();

const KINDS: ControlObjectKind[] = ["ad", "ad_set"];

function unavailable(res: import("express").Response): void {
  res.status(503).json({ error: "control temporarily unavailable" });
}

// GET /state — live ACTIVE/PAUSED for every ad + ad set in the caller's
// campaign. One live Meta read, deliberately: the readout surfaces
// (customer-overview, campaign-audiences) stay DB-only by design, and a stale
// cached status would render a pause button that lies about what it does. This
// is fetched only when the customer opens the details panel, the same
// explicit-action rule that justifies the ops explorer's live reads (AIC-45).
controlsRouter.get("/state", requireAuth, async (req, res) => {
  try {
    const ctx = await resolveAdditionContext(pool, (req as AuthedRequest).userId!);
    if (!ctx) {
      res.status(409).json({ error: "no managed campaign" });
      return;
    }
    const writer = buildAdditionWriter() as ControlWriter | null;
    if (!writer) return unavailable(res);
    const state = await writer.getCampaignState(ctx.metaCampaignId);
    res.json({ adStatuses: state.adStatuses, adSetStatuses: state.adSetStatuses });
  } catch (e) {
    console.error("[controls] state failed", e);
    res.status(502).json({ error: "failed to read current state" });
  }
});

// POST /pause and /resume — one ad or ad set, self-authorized.
for (const action of ["pause", "resume"] as const) {
  controlsRouter.post(`/${action}`, requireAuth, async (req, res) => {
    const kind = String(req.body?.kind ?? "") as ControlObjectKind;
    const metaObjectId = String(req.body?.metaObjectId ?? "");
    if (!KINDS.includes(kind) || !metaObjectId) {
      res.status(400).json({ error: "kind must be 'ad' or 'ad_set', and metaObjectId is required" });
      return;
    }

    try {
      const ctx = await resolveAdditionContext(pool, (req as AuthedRequest).userId!);
      if (!ctx) {
        res.status(409).json({ error: "no managed campaign" });
        return;
      }
      const writer = buildAdditionWriter() as (ControlWriter & DeliveryReader) | null;
      if (!writer) return unavailable(res);

      // Never trust a client-supplied Meta id: prove it lives under the
      // caller's OWN campaign before writing anything (AIC-63's pattern).
      if (!(await assertOwnedByCampaign(writer, ctx.metaCampaignId, kind, metaObjectId))) {
        res.status(404).json({ error: "not found" });
        return;
      }

      const result = await setObjectStatus({
        pool,
        writer,
        campaignId: ctx.localCampaignId,
        kind,
        metaObjectId,
        status: action === "pause" ? "PAUSED" : "ACTIVE",
        actor: { kind: "customer", label: "customer" },
      });

      if (result.outcome === "failed") {
        res.status(502).json({ outcome: result.outcome });
        return;
      }

      // Update the customer-facing "מצב" headline (AIC-71) right now, rather
      // than leaving it stale until the next hourly engine tick — the whole
      // point of a self-service pause is that the customer sees it took
      // effect immediately.
      if (result.outcome === "changed") {
        await refreshDeliveryNow({
          pool, ops, deliveryReader: writer, campaignId: ctx.localCampaignId,
          customerId: ctx.customerId, metaCampaignId: ctx.metaCampaignId,
        });
      }

      res.json({ outcome: result.outcome, status: result.newStatus });
    } catch (e) {
      console.error(`[controls] ${action} failed`, e);
      res.status(502).json({ error: "failed to apply the change" });
    }
  });
}
