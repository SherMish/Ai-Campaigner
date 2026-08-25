import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { resolveAdditionContext, resolveAdditionAvailability, buildAdditionWriter } from "../additions/session.js";
import { setObjectStatus, assertOwnedByCampaign } from "../controls/manual-controls.js";
import { hideAd, unhideAd, listHiddenAds } from "../controls/hidden-ads.js";
import type { ControlObjectKind, ControlWriter } from "../controls/types.js";
import type { DeliveryReader } from "../meta/delivery-health.js";
import type { AdMediaReader } from "../meta/ad-media.js";
import type { AdDetailReader } from "../meta/ad-detail.js";
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
// PAUSE/RESUME, plus AIC-128's REMOVE-FROM-VIEW. Meta's own archive/delete are
// destructive and irreversible, and still live exclusively in the admin console
// (routes/admin.ts) — there is deliberately no customer-facing write to Meta
// beyond pause/resume.
//
// /hide and /unhide never touch Meta at all. They record a presentation
// preference, so the customer gets the tidy-up they asked for without being
// handed a one-way door: Meta has no un-archive, at all, through any API.
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
//
// Uses resolveAdditionAvailability, not resolveAdditionContext (bug fix,
// 2026-08-15, found live): both this route and /media used to 409 with a
// flat "no managed campaign" for EVERY unavailable reason, including
// missing_page and connection_issue on a real, active, linked campaign. The
// frontend's own `.catch(() => {})` then swallowed that error completely —
// a customer whose Page access was missing saw no pause button and no ad
// images, with literally nothing explaining why (indistinguishable from
// "this feature doesn't exist"). The reason now reaches the response body so
// AudienceDetails can render an honest note instead of silently degrading.
controlsRouter.get("/state", requireAuth, async (req, res) => {
  try {
    const availability = await resolveAdditionAvailability(pool, (req as AuthedRequest).userId!);
    if (!availability.ctx) {
      res.status(409).json({ error: "no managed campaign", reason: availability.reason });
      return;
    }
    const writer = buildAdditionWriter() as ControlWriter | null;
    if (!writer) return unavailable(res);
    const state = await writer.getCampaignState(availability.ctx.metaCampaignId);
    res.json({ adStatuses: state.adStatuses, adSetStatuses: state.adSetStatuses, campaignStatus: state.campaignStatus });
  } catch (e) {
    console.error("[controls] state failed", e);
    res.status(502).json({ error: "failed to read current state" });
  }
});

// GET /media — per-ad creative thumbnails (AIC-73 round 2). Same
// live-on-explicit-open rule as /state above: the DB-only readout has no
// image data, and a salon owner's ads are pictures — a comma-separated name
// string is the weakest possible representation of them. Read-only; a
// failure degrades the UI to names rather than breaking the panel — but see
// the /state comment above: the REASON for that degradation now travels
// with the error rather than being swallowed silently.
controlsRouter.get("/media", requireAuth, async (req, res) => {
  try {
    const availability = await resolveAdditionAvailability(pool, (req as AuthedRequest).userId!);
    if (!availability.ctx) {
      res.status(409).json({ error: "no managed campaign", reason: availability.reason });
      return;
    }
    const reader = buildAdditionWriter() as AdMediaReader | null;
    if (!reader) return unavailable(res);
    res.json({ ads: await reader.getAdMedia(availability.ctx.metaCampaignId) });
  } catch (e) {
    console.error("[controls] media failed", e);
    res.status(502).json({ error: "failed to read creative media" });
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


// GET /ad/:metaAdId — one ad's full creative, for the details modal (AIC-135).
//
// Ownership-checked like every other route that takes a Meta id from a client:
// the ad must live under the caller's OWN campaign. Without it this would be a
// read oracle for any ad id in any account the system user can reach — the
// copy, the image and the destination phone number of another business's ads.
controlsRouter.get("/ad/:metaAdId", requireAuth, async (req, res) => {
  try {
    const ctx = await resolveAdditionContext(pool, (req as AuthedRequest).userId!);
    if (!ctx) {
      res.status(409).json({ error: "no managed campaign" });
      return;
    }
    const reader = buildAdditionWriter() as (ControlWriter & AdDetailReader) | null;
    if (!reader) return unavailable(res);

    const metaAdId = String(req.params.metaAdId);
    if (!(await assertOwnedByCampaign(reader, ctx.metaCampaignId, "ad", metaAdId))) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const detail = await reader.getAdDetail(metaAdId);
    if (!detail) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(detail);
  } catch (e) {
    console.error("[controls] ad detail failed", e);
    res.status(502).json({ error: "failed to load the ad" });
  }
});

// ── AIC-128: remove from view / restore ──────────────────────────────────────
//
// Neither route writes to Meta. Both are ownership-checked exactly like
// pause/resume — a client-supplied ad id is never trusted — and both are
// idempotent, so a double-tap on a slow connection cannot produce a wrong
// answer.

// GET /hidden — the removed-ads screen. Returns ids + when/who; the screen
// pairs them with the stats and thumbnails it already fetches elsewhere.
controlsRouter.get("/hidden", requireAuth, async (req, res) => {
  try {
    const ctx = await resolveAdditionContext(pool, (req as AuthedRequest).userId!);
    if (!ctx) {
      res.status(409).json({ error: "no managed campaign" });
      return;
    }
    const ads = await listHiddenAds(pool, ctx.localCampaignId);
    res.json({ ads: ads.map((a) => ({ metaAdId: a.metaAdId, hiddenAt: a.hiddenAt.toISOString() })) });
  } catch (e) {
    console.error("[controls] hidden failed", e);
    res.status(502).json({ error: "failed to read removed ads" });
  }
});

for (const action of ["hide", "unhide"] as const) {
  controlsRouter.post(`/${action}`, requireAuth, async (req, res) => {
    const metaObjectId = String(req.body?.metaObjectId ?? "");
    if (!metaObjectId) {
      res.status(400).json({ error: "metaObjectId is required" });
      return;
    }
    try {
      const ctx = await resolveAdditionContext(pool, (req as AuthedRequest).userId!);
      if (!ctx) {
        res.status(409).json({ error: "no managed campaign" });
        return;
      }
      const writer = buildAdditionWriter() as ControlWriter | null;
      if (!writer) return unavailable(res);

      // Ownership first, same as pause/resume. Note this also means a customer
      // cannot hide an ad belonging to somebody else's campaign, which would
      // otherwise be a way to write rows into another tenant's table.
      if (!(await assertOwnedByCampaign(writer, ctx.metaCampaignId, "ad", metaObjectId))) {
        res.status(404).json({ error: "not found" });
        return;
      }

      if (action === "unhide") {
        const outcome = await unhideAd({
          pool, campaignId: ctx.localCampaignId, metaAdId: metaObjectId, actorLabel: "customer",
        });
        res.json({ outcome });
        return;
      }

      const outcome = await hideAd({
        pool, writer, campaignId: ctx.localCampaignId, metaAdId: metaObjectId, actorLabel: "customer",
      });
      // PAUSE-FIRST, ENFORCED SERVER-SIDE. The UI only offers remove on a
      // paused row, but a disabled button is a suggestion, not a rule — and
      // the failure it prevents is the expensive one: an ad removed from view
      // while still spending on Meta is invisible AND live at the same time.
      if (outcome === "not_paused") {
        res.status(409).json({ outcome, error: "pause the ad before removing it" });
        return;
      }
      if (outcome === "not_found") {
        res.status(404).json({ outcome });
        return;
      }
      res.json({ outcome });
    } catch (e) {
      console.error(`[controls] ${action} failed`, e);
      res.status(502).json({ error: "failed to apply the change" });
    }
  });
}
