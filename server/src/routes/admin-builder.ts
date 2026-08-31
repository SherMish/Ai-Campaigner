import { Router } from "express";
import { BudgetCeilingMissingError, BudgetLimitError } from "../execution/budget.js";
import { CampaignConfigIncompleteError } from "../builder/campaign-create.js";
import { GraphWriteError } from "../meta/campaign-adapter.js";
import multer from "multer";
import { validateCreativeCopy, MAX_VIDEO_BYTES, SPECIAL_AD_CATEGORY, FIXED_BID_STRATEGY, FIXED_DESTINATION, type SpecialAdCategory } from "@aic/shared";
import { pool } from "../db/pool.js";
import { requireAdmin } from "../middleware/admin.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { resolveBuilderContextForCustomer, ownsLocalCampaign, buildBuilderWriter } from "../builder/session.js";
import { startBuilderCampaign, buildCampaignOnMeta, type BuildCampaignInput } from "../builder/campaign-create.js";
import { createCreativeIdempotent, uploadCreativeMedia, type CreativeSpec } from "../builder/creative-create.js";
import type { CreativeMedia } from "../builder/creative-types.js";
import { gendersOf } from "./builder.js";
import { logAdminAction, type Actor } from "../services/admin-audit.js";
import { PgUserStore } from "../auth/user-store.js";
import { adSetName, campaignName } from "../meta/naming.js";
import { pageIdentityOrNulls } from "../builder/page-identity.js";
import { searchGeoOrEmpty } from "../builder/geo-search.js";
import { listPromotableContent } from "../builder/promotable-content.js";

// AIC-105 Branch A — the guided builder's HTTP surface (routes/builder.ts),
// mirrored for an operator building a customer's FIRST campaign on their
// behalf: a customer with no self-serve login yet, or one still on the phone
// during onboarding whose ad account has zero existing Meta campaigns (the
// step-4 picker's "no campaigns found" case). Every route resolves the
// TARGET customer's context from :customerId in the URL, never a client-
// supplied adAccountId/pageId — the same "resolve fresh, trust nothing else"
// discipline as the customer-facing router, just keyed off an admin-supplied
// id instead of the caller's own JWT. Gated by requireAdmin; every write
// (creative, build) is logged to the admin audit trail — the customer-facing
// router has no such log because there the caller IS the customer.
export const adminBuilderRouter = Router();
adminBuilderRouter.use(requireAdmin);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_VIDEO_BYTES } });
const userStore = new PgUserStore(pool);

async function actorFor(req: AuthedRequest): Promise<Actor> {
  const userId = req.userId ?? null;
  if (!userId) return { userId: null, label: "break-glass token" };
  const user = await userStore.findById(userId);
  return { userId, label: user?.email ?? userId };
}

function notReady(res: import("express").Response): void {
  res.status(409).json({ error: "not ready to build — connect a Meta ad account + Page first, or a campaign already exists" });
}

function unavailable(res: import("express").Response): void {
  res.status(503).json({ error: "execution temporarily unavailable" });
}

adminBuilderRouter.get("/customers/:id/builder/context", async (req, res) => {
  try {
    const ctx = await resolveBuilderContextForCustomer(pool, req.params.id);
    if (!ctx) return notReady(res);
    // AIC-106 — businessName rides along so the client can name the customer
    // in the creation confirmation. Sourced from the customer record via
    // BuilderContext, never from anything the operator typed.
    res.json({ category: ctx.category, businessName: ctx.businessName, agreedBudgetAgorot: ctx.agreedBudgetAgorot });
  } catch (e) {
    console.error("[admin-builder] context failed", e);
    res.status(500).json({ error: "failed to load builder context" });
  }
});

adminBuilderRouter.post("/customers/:id/builder/start", async (req, res) => {
  try {
    const ctx = await resolveBuilderContextForCustomer(pool, req.params.id);
    if (!ctx) return notReady(res);
    const { id } = await startBuilderCampaign(pool, ctx.customerId, ctx.adAccountUuid);
    res.json({ localCampaignId: id });
  } catch (e) {
    console.error("[admin-builder] start failed", e);
    res.status(500).json({ error: "failed to start" });
  }
});

adminBuilderRouter.post<{ id: string }>("/customers/:id/builder/upload", upload.single("file"), async (req, res) => {
  try {
    const ctx = await resolveBuilderContextForCustomer(pool, req.params.id);
    if (!ctx) return notReady(res);
    const file = req.file;
    if (!file) { res.status(400).json({ error: "no file" }); return; }
    const writer = buildBuilderWriter();
    if (!writer) return unavailable(res);
    const media = await uploadCreativeMedia(writer, ctx.metaAdAccountId, {
      buffer: file.buffer,
      filename: file.originalname,
      mimetype: file.mimetype,
    });
    res.json({ media });
  } catch (e) {
    console.error("[admin-builder] upload failed", e);
    res.status(502).json({ error: "upload failed" });
  }
});

adminBuilderRouter.get("/customers/:id/builder/posts", async (req, res) => {
  try {
    const ctx = await resolveBuilderContextForCustomer(pool, req.params.id);
    if (!ctx) return notReady(res);
    const writer = buildBuilderWriter();
    if (!writer) return unavailable(res);
    const posts = await listPromotableContent(writer, ctx.pageId, ctx.instagramId);
    res.json({ posts });
  } catch (e) {
    console.error("[admin-builder] list posts failed", e);
    res.status(502).json({ error: "failed to load posts" });
  }
});

// AIC-155 — the admin drives the SAME Builder.tsx, so the preview was wrong
// here too.
adminBuilderRouter.get("/customers/:id/builder/page", async (req, res) => {
  try {
    const ctx = await resolveBuilderContextForCustomer(pool, req.params.id);
    const writer = ctx ? buildBuilderWriter() : null;
    res.json(await pageIdentityOrNulls(writer, ctx?.pageId));
  } catch (e) {
    console.error("[admin-builder] page identity failed", e);
    res.json({ name: null, pictureUrl: null });
  }
});

adminBuilderRouter.get("/customers/:id/builder/geo", async (req, res) => {
  try {
    res.json({ places: await searchGeoOrEmpty(buildBuilderWriter(), String(req.query.q ?? "")) });
  } catch (e) {
    console.error("[admin-builder] geo search failed", e);
    res.status(502).json({ error: "geo search failed" });
  }
});

adminBuilderRouter.get("/customers/:id/builder/pixels", async (req, res) => {
  try {
    const ctx = await resolveBuilderContextForCustomer(pool, req.params.id);
    if (!ctx) return notReady(res);
    const writer = buildBuilderWriter();
    if (!writer) return unavailable(res);
    const pixels = await writer.listPixels(ctx.metaAdAccountId);
    res.json({ pixels });
  } catch (e) {
    console.error("[admin-builder] list pixels failed", e);
    res.status(502).json({ error: "failed to load pixels" });
  }
});

interface PixelCheckBody {
  pixelId?: string;
  conversionEvent?: string;
}

adminBuilderRouter.post("/customers/:id/builder/pixel-check", async (req, res) => {
  try {
    const ctx = await resolveBuilderContextForCustomer(pool, req.params.id);
    if (!ctx) return notReady(res);
    const body = req.body as PixelCheckBody;
    if (!body.pixelId || !body.conversionEvent) {
      res.status(400).json({ error: "pixelId and conversionEvent are required" });
      return;
    }
    const writer = buildBuilderWriter();
    if (!writer) return unavailable(res);
    const result = await writer.checkPixelEventRecency(body.pixelId, body.conversionEvent);
    res.json(result);
  } catch (e) {
    console.error("[admin-builder] pixel check failed", e);
    res.status(502).json({ error: "failed to check pixel" });
  }
});

interface CreativeBody {
  localCampaignId?: string;
  clientKey?: string;
  name?: string;
  headline?: string;
  primaryText?: string;
  whatsappNumber?: string;
  destination?: string;
  destinationUrl?: string;
  media?: CreativeMedia;
  postId?: string;
  postSource?: "facebook" | "instagram"; // AIC-156
}

adminBuilderRouter.post("/customers/:id/builder/creative", async (req, res) => {
  try {
    const ctx = await resolveBuilderContextForCustomer(pool, req.params.id);
    if (!ctx) return notReady(res);
    const body = req.body as CreativeBody;
    if (!(await ownsLocalCampaign(pool, ctx.customerId, body.localCampaignId))) {
      res.status(404).json({ error: "campaign not found" });
      return;
    }
    if (!body.clientKey || !body.name) { res.status(400).json({ error: "clientKey and name are required" }); return; }

    const writer = buildBuilderWriter();
    if (!writer) return unavailable(res);

    let spec: CreativeSpec;
    if (body.postId) {
      spec = {
        kind: "existing_post", adAccountId: ctx.metaAdAccountId, pageId: ctx.pageId,
        name: body.name, postId: body.postId,
        // AIC-156 — which network this post came from selects the Meta
        // payload (object_story_id vs object_id + source_instagram_media_id),
        // and the IG identity is what makes the ad run as the customer.
        postSource: body.postSource ?? "facebook",
        instagramUserId: ctx.instagramId,
        // AIC-115 (2026-08-23): the CTA must ride along here too, or Meta
        // refuses the AD as "incompatible with the objective". Same
        // destination resolution as the upload branch below — an engagement
        // destination has no ctaType, so the adapter omits it.
        destination: body.destination ?? FIXED_DESTINATION,
        whatsappNumber: body.whatsappNumber ?? "",
        destinationUrl: body.destinationUrl,
      };
    } else {
      const validation = validateCreativeCopy({
        headline: body.headline ?? "",
        primaryText: body.primaryText ?? "",
        hasMedia: !!body.media,
      });
      if (!validation.valid) { res.status(400).json({ errors: validation.errors }); return; }
      spec = {
        kind: "upload",
        adAccountId: ctx.metaAdAccountId,
        pageId: ctx.pageId,
        instagramUserId: ctx.instagramId, // AIC-156
        name: body.name,
        headline: body.headline!,
        primaryText: body.primaryText!,
        whatsappNumber: body.whatsappNumber ?? "",
        destinationUrl: body.destinationUrl,
        media: body.media!,
        destination: body.destination ?? FIXED_DESTINATION,
      };
    }
    const creativeId = await createCreativeIdempotent(pool, writer, body.localCampaignId!, body.clientKey, spec);
    res.json({ creativeId });
  } catch (e) {
    console.error("[admin-builder] create creative failed", e);
    res.status(502).json({ error: "failed to create creative" });
  }
});

interface BuildBody {
  localCampaignId?: string;
  name?: string;
  dailyBudgetAgorot?: number;
  specialAdCategories?: string[];
  destination?: string;
  whatsappDestination?: string;
  destinationUrl?: string;
  pixelId?: string;
  conversionEvent?: string;
  targeting?: { ageMin: number; ageMax: number; genders: "all" | "male" | "female"; countries?: string[]; cities?: Array<{ key: string; name: string; type: "city" | "region" }> };
  ads?: Array<{ clientKey: string; name: string; creativeId: string }>;
}

// The consequential write: creates the customer's real Meta campaign (PAUSED,
// same as the self-serve builder). Logged to the admin audit trail — the one
// route in this file where "which operator did this, for which customer" has
// to be answerable later, same discipline as onboarding/provision.
adminBuilderRouter.post("/customers/:id/builder/build", async (req, res) => {
  try {
    const ctx = await resolveBuilderContextForCustomer(pool, req.params.id);
    if (!ctx) return notReady(res);
    const body = req.body as BuildBody;
    if (!(await ownsLocalCampaign(pool, ctx.customerId, body.localCampaignId))) {
      res.status(404).json({ error: "campaign not found" });
      return;
    }
    if (!Number.isInteger(body.dailyBudgetAgorot) || (body.dailyBudgetAgorot as number) <= 0) {
      res.status(400).json({ error: "invalid budget" });
      return;
    }
    if (!body.targeting) { res.status(400).json({ error: "targeting is required" }); return; }
    if (!Array.isArray(body.ads) || body.ads.length === 0) {
      res.status(400).json({ error: "at least one ad is required" });
      return;
    }
    const specialCategories = (body.specialAdCategories ?? []).filter(
      (c): c is SpecialAdCategory => (SPECIAL_AD_CATEGORY as readonly string[]).includes(c),
    );

    const writer = buildBuilderWriter();
    if (!writer) return unavailable(res);

    const input: BuildCampaignInput = {
      localCampaignId: body.localCampaignId!,
      adAccountId: ctx.metaAdAccountId,
      pageId: ctx.pageId,
      // AIC-154: an operator may have a reason to name a campaign something
      // specific — a takeover matching the customer's existing scheme, say —
      // so a typed name still wins. Ours is the default, not a ceiling.
      name: body.name?.trim() || campaignName({ destination: body.destination ?? FIXED_DESTINATION, createdAt: new Date() }),
      dailyBudgetAgorot: body.dailyBudgetAgorot!,
      specialAdCategories: specialCategories,
      bidStrategy: FIXED_BID_STRATEGY,
      destination: body.destination ?? FIXED_DESTINATION,
      whatsappDestination: body.whatsappDestination ?? "",
      destinationUrl: body.destinationUrl,
      pixelId: body.pixelId,
      conversionEvent: body.conversionEvent,
      adSets: [
        {
          clientKey: "adset-1",
          name: adSetName({ ...body.targeting, genders: body.targeting.genders, cities: body.targeting.cities }),
          targeting: {
            ageMin: body.targeting.ageMin,
            ageMax: body.targeting.ageMax,
            genders: gendersOf(body.targeting.genders),
            countries: body.targeting.countries?.length ? body.targeting.countries : ["IL"],
            // AIC-157 — chosen cities/regions REPLACE the country inside
            // geo_locations (see geoLocations()); an empty list keeps the
            // nationwide behaviour that was the only option until now.
            cities: body.targeting.cities ?? [],
          },
          ads: body.ads,
        },
      ],
    };
    const result = await buildCampaignOnMeta(pool, writer, input);

    const actor = await actorFor(req as AuthedRequest);
    await logAdminAction(pool, {
      actorUserId: actor.userId,
      actorLabel: actor.label,
      action: "customer.builder.build",
      entityType: "customer",
      entityId: req.params.id,
      entityLabel: `${ctx.metaAdAccountId} / ${result.metaCampaignId}`,
      detail: JSON.stringify(result),
    });

    res.json(result);
  } catch (e) {
    // AIC-106 — a budget refusal is a precondition WE enforced, not a Meta
    // failure, so it must not be reported as 502 ("Meta is broken"). That
    // wrong diagnosis lands on an operator mid-call and sends them to check
    // Meta rather than the one field they actually need to fill.
    if (e instanceof BudgetCeilingMissingError) {
      res.status(409).json({ error: "no agreed daily budget is set for this customer — set it in provisioning before building", code: "budget_ceiling_missing" });
      return;
    }
    if (e instanceof BudgetLimitError) {
      res.status(409).json({ error: e.message, code: "budget_over_ceiling" });
      return;
    }
    // AIC-103 x AIC-105 — same reasoning as the budget refusals: our
    // precondition, not Meta's failure, so never 502. Names the missing fields
    // so the operator can fix them rather than guess (AIC-98).
    if (e instanceof CampaignConfigIncompleteError) {
      res.status(409).json({
        error: e.message,
        code: "campaign_config_incomplete",
        missingFields: e.missingFields,
      });
      return;
    }
    // AIC-105's "Meta API failure" category, built against a REAL live
    // case (2026-08-19): Meta itself gave a clear, actionable reason (e.g.
    // "Your Page is not linked to a WhatsApp account") and the code was
    // discarding it into this same generic 502. When Meta provides its own
    // operator-facing message, surface it — still 502 (it genuinely is an
    // external failure we can't self-heal), but with the real reason instead
    // of a dead end. `transient` rides along so a future retry-UX pass has
    // the signal without needing to re-derive it (AIC-105's fourth error
    // category, still not built).
    if (e instanceof GraphWriteError && e.userMessage) {
      console.error("[admin-builder] build failed (Meta refused)", e.userTitle, e.userMessage);
      res.status(502).json({
        error: e.userMessage,
        code: "meta_write_refused",
        metaTitle: e.userTitle,
        transient: e.isTransient,
      });
      return;
    }
    // "i want to see the error on the ui not a useless message" — the
    // operator IS the person who has to act on this, mid-call. Surfacing
    // Meta-labelled errors alone (above) was too narrow: the WriteOutbox's
    // own "create already in progress … retry shortly" is perfectly good
    // operator copy and was still being flattened away.
    //
    // `detail` is deliberately ADMIN-ONLY — the customer-facing builder
    // route keeps the friendly generic message, since a customer can act on
    // none of this. AIC-105's "no raw codes in the operator UI" rule is
    // about not making an operator decode a number; a real sentence is
    // exactly what that rule wants them to have.
    console.error("[admin-builder] build failed", e);
    res.status(502).json({
      error: "failed to build campaign",
      detail: e instanceof Error ? e.message : String(e),
    });
  }
});
