import { Router } from "express";
import multer from "multer";
import { validateCreativeCopy, MAX_VIDEO_BYTES, SPECIAL_AD_CATEGORY, FIXED_BID_STRATEGY, FIXED_DESTINATION, type SpecialAdCategory } from "@aic/shared";
import { pool } from "../db/pool.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { resolveBuilderContext, ownsLocalCampaign, buildBuilderWriter } from "../builder/session.js";
import { startBuilderCampaign, buildCampaignOnMeta, type BuildCampaignInput } from "../builder/campaign-create.js";
import { createCreativeIdempotent, uploadCreativeMedia, type CreativeSpec } from "../builder/creative-create.js";
import type { CreativeMedia } from "../builder/creative-types.js";

// The guided builder's HTTP surface (AIC-52) — a thin layer over AIC-50's
// create-writes and AIC-51's creative handling. Every route resolves the
// caller's builder context fresh from their own JWT-scoped rows; nothing
// here trusts a client-supplied adAccountId/pageId/customerId.
export const builderRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_VIDEO_BYTES } });

// Exported so routes/additions.ts (AIC-63) doesn't duplicate the Meta gender-code mapping.
export function gendersOf(g: "all" | "male" | "female"): number[] {
  return g === "male" ? [1] : g === "female" ? [2] : [];
}

function notReady(res: import("express").Response): void {
  res.status(409).json({ error: "not ready to build — connect a Meta ad account + Page first, or a campaign already exists" });
}

function unavailable(res: import("express").Response): void {
  res.status(503).json({ error: "execution temporarily unavailable" });
}

// GET /context — what the builder needs to prefill (business category for
// the audience step) and whether this customer can build at all right now.
builderRouter.get("/context", requireAuth, async (req, res) => {
  try {
    const ctx = await resolveBuilderContext(pool, (req as AuthedRequest).userId!);
    if (!ctx) return notReady(res);
    res.json({ category: ctx.category });
  } catch (e) {
    console.error("[builder] context failed", e);
    res.status(500).json({ error: "failed to load builder context" });
  }
});

// POST /start — create (or resume) the local shell row every subsequent
// creative/build call anchors to.
builderRouter.post("/start", requireAuth, async (req, res) => {
  try {
    const ctx = await resolveBuilderContext(pool, (req as AuthedRequest).userId!);
    if (!ctx) return notReady(res);
    const { id } = await startBuilderCampaign(pool, ctx.customerId, ctx.adAccountUuid);
    res.json({ localCampaignId: id });
  } catch (e) {
    console.error("[builder] start failed", e);
    res.status(500).json({ error: "failed to start" });
  }
});

// POST /upload — one image or video file. Deliberately NOT idempotent (see
// creative-create.ts's uploadCreativeMedia doc comment) — a failed upload is
// just re-uploaded, same as any ordinary file-upload UX.
builderRouter.post("/upload", requireAuth, upload.single("file"), async (req, res) => {
  try {
    const ctx = await resolveBuilderContext(pool, (req as AuthedRequest).userId!);
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
    console.error("[builder] upload failed", e);
    res.status(502).json({ error: "upload failed" });
  }
});

// GET /posts — promotable posts on the connected Page, for the
// existing-post creative path.
builderRouter.get("/posts", requireAuth, async (req, res) => {
  try {
    const ctx = await resolveBuilderContext(pool, (req as AuthedRequest).userId!);
    if (!ctx) return notReady(res);
    const writer = buildBuilderWriter();
    if (!writer) return unavailable(res);
    const posts = await writer.listPromotablePosts(ctx.pageId);
    res.json({ posts });
  } catch (e) {
    console.error("[builder] list posts failed", e);
    res.status(502).json({ error: "failed to load posts" });
  }
});

// GET /pixels — Pixels/datasets visible on the connected ad account, for the
// website-destination step's picker (AIC-89).
builderRouter.get("/pixels", requireAuth, async (req, res) => {
  try {
    const ctx = await resolveBuilderContext(pool, (req as AuthedRequest).userId!);
    if (!ctx) return notReady(res);
    const writer = buildBuilderWriter();
    if (!writer) return unavailable(res);
    const pixels = await writer.listPixels(ctx.metaAdAccountId);
    res.json({ pixels });
  } catch (e) {
    console.error("[builder] list pixels failed", e);
    res.status(502).json({ error: "failed to load pixels" });
  }
});

interface PixelCheckBody {
  pixelId?: string;
  conversionEvent?: string;
}

// POST /pixel-check — the build-time guardrail: has the selected Pixel seen
// the chosen conversion event recently? `hasRecentEvents: null` means the
// check itself was inconclusive (never a confident "dead pixel" from an
// ambiguous read) — the UI treats null the same as true (no warning), since
// warning on an uncertain signal would cry wolf.
builderRouter.post("/pixel-check", requireAuth, async (req, res) => {
  try {
    const ctx = await resolveBuilderContext(pool, (req as AuthedRequest).userId!);
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
    console.error("[builder] pixel check failed", e);
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
  destination?: string; // AIC-89 — FIXED_DESTINATION or WEBSITE_DESTINATION; defaults to WhatsApp
  destinationUrl?: string; // website only
  media?: CreativeMedia;
  postId?: string;
}

// POST /creative — create one ad's Meta creative, either from an upload
// (validated first — media/copy) or an existing post (no copy to validate,
// the post's own content IS the creative). Idempotent per (localCampaignId,
// clientKey) — resubmitting the same ad slot never creates a second creative.
builderRouter.post("/creative", requireAuth, async (req, res) => {
  try {
    const ctx = await resolveBuilderContext(pool, (req as AuthedRequest).userId!);
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
      spec = { kind: "existing_post", adAccountId: ctx.metaAdAccountId, pageId: ctx.pageId, name: body.name, postId: body.postId };
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
        name: body.name,
        headline: body.headline!,
        primaryText: body.primaryText!,
        whatsappNumber: body.whatsappNumber ?? "",
        destinationUrl: body.destinationUrl,
        media: body.media!,
        // AIC-89 — a real choice now; defaults to WhatsApp for backward
        // compatibility with a client that never sends the field.
        destination: body.destination ?? FIXED_DESTINATION,
      };
    }
    const creativeId = await createCreativeIdempotent(pool, writer, body.localCampaignId!, body.clientKey, spec);
    res.json({ creativeId });
  } catch (e) {
    console.error("[builder] create creative failed", e);
    res.status(502).json({ error: "failed to create creative" });
  }
});

interface BuildBody {
  localCampaignId?: string;
  name?: string;
  dailyBudgetAgorot?: number;
  specialAdCategories?: string[];
  destination?: string; // AIC-89 — FIXED_DESTINATION or WEBSITE_DESTINATION; defaults to WhatsApp
  whatsappDestination?: string;
  destinationUrl?: string; // website only
  pixelId?: string; // website only
  conversionEvent?: string; // website only
  targeting?: { ageMin: number; ageMax: number; genders: "all" | "male" | "female"; countries?: string[] };
  ads?: Array<{ clientKey: string; name: string; creativeId: string }>;
}

// POST /build — the final step: campaign → 1 ad set (AIC-38/49's recommended
// structure — the builder never offers a multi-ad-set choice) → every ad,
// all PAUSED. Wraps campaign-create.ts's buildCampaignOnMeta; resolves
// adAccountId/pageId server-side, never trusts them from the client.
builderRouter.post("/build", requireAuth, async (req, res) => {
  try {
    const ctx = await resolveBuilderContext(pool, (req as AuthedRequest).userId!);
    if (!ctx) return notReady(res);
    const body = req.body as BuildBody;
    if (!(await ownsLocalCampaign(pool, ctx.customerId, body.localCampaignId))) {
      res.status(404).json({ error: "campaign not found" });
      return;
    }
    if (!body.name?.trim()) { res.status(400).json({ error: "name is required" }); return; }
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
      name: body.name,
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
          name: `${body.name} — קהל 1`,
          targeting: {
            ageMin: body.targeting.ageMin,
            ageMax: body.targeting.ageMax,
            genders: gendersOf(body.targeting.genders),
            countries: body.targeting.countries?.length ? body.targeting.countries : ["IL"],
          },
          ads: body.ads,
        },
      ],
    };
    const result = await buildCampaignOnMeta(pool, writer, input);
    res.json(result);
  } catch (e) {
    console.error("[builder] build failed", e);
    res.status(502).json({ error: "failed to build campaign" });
  }
});
