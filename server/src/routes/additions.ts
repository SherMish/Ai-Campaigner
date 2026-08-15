import { Router } from "express";
import multer from "multer";
import { validateCreativeCopy, MAX_VIDEO_BYTES } from "@aic/shared";
import { pool } from "../db/pool.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { resolveAdditionContext, buildAdditionWriter, acceptsWhatsappWrites, whatsappWriteBlock, type WhatsappWriteBlock } from "../additions/session.js";
import { addAdToExistingCampaign, addAdSetToExistingCampaign } from "../additions/add-content.js";
import { approveAddition, listPendingAdditions } from "../additions/approve.js";
import { createCreativeIdempotent, uploadCreativeMedia, type CreativeSpec } from "../builder/creative-create.js";
import type { CreativeMedia } from "../builder/creative-types.js";
import { gendersOf } from "./builder.js";

// Adding content to a campaign we ALREADY manage (AIC-63) — the everyday
// management action, distinct from the first-time builder (routes/builder.ts):
// the precondition here is the OPPOSITE (an existing, linked campaign
// required), and nothing here ever creates a new campaign. Every route
// resolves the caller's context fresh from their own JWT-scoped rows.
export const additionsRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_VIDEO_BYTES } });

function notReady(res: import("express").Response): void {
  res.status(409).json({ error: "no managed campaign to add to yet — connect a Meta ad account + Page and build your first campaign first" });
}

function unavailable(res: import("express").Response): void {
  res.status(503).json({ error: "execution temporarily unavailable" });
}

// The additions flow emits WhatsApp-shaped Meta objects unconditionally: a
// `WHATSAPP_MESSAGE` call-to-action, and `CONVERSATIONS`/`WHATSAPP` ad sets.
// Both are wrong for any other lead type — a Pixel campaign would get an ad
// with an empty `whatsapp_number`, or an ad set whose conversions can never
// match its lead definition (real spend, zero countable leads, and AIC-88
// would then flag the campaign as broken).
//
// So we REFUSE rather than write. Until the flow supports other destinations
// (AIC-89), attempting a malformed write is strictly worse than declining one.
// Note this is a LEAD-TYPE check, not a "was it connected from outside"
// check — a Pixel campaign our own builder created would be equally wrong.
// TWO causes, two messages — collapsing them would tell a Click-to-WhatsApp
// customer their leads don't come from WhatsApp, which is simply untrue.
// Confirmed against the real accounts: GelNails is genuinely a WhatsApp
// campaign whose number we never captured (connected from outside the
// builder), and it hits `missing_number`, not `not_whatsapp`.
function refuseWhatsappWrite(res: import("express").Response, block: WhatsappWriteBlock): void {
  res.status(409).json({
    reason: block,
    error:
      block === "not_whatsapp"
        ? "this campaign's leads don't arrive over WhatsApp, and adding content to " +
          "non-WhatsApp campaigns isn't supported yet — we'd have to create a " +
          "WhatsApp ad that could never work. Talk to us and we'll add it for you."
        : "we don't have this campaign's WhatsApp number on file, so any ad we " +
          "created would have nowhere to send people. Talk to us and we'll add it.",
  });
}

// GET /context — the existing campaign's name/category/WhatsApp destination
// (for the add-ad-set audience step's prefill), and whether additions are
// possible right now at all.
additionsRouter.get("/context", requireAuth, async (req, res) => {
  try {
    const ctx = await resolveAdditionContext(pool, (req as AuthedRequest).userId!);
    if (!ctx) return notReady(res);
    // `whatsappDestination` is "" (not null) when this campaign doesn't use
    // WhatsApp — the client prefills a number field from it, and an empty
    // prefill is correct there. `canAddContent` is the honest signal for
    // whether the write routes will accept anything at all.
    res.json({
      campaignName: ctx.campaignName,
      category: ctx.category,
      whatsappDestination: ctx.whatsappNumber ?? "",
      canAddContent: acceptsWhatsappWrites(ctx),
    });
  } catch (e) {
    console.error("[additions] context failed", e);
    res.status(500).json({ error: "failed to load context" });
  }
});

// GET /ad-sets — the campaign's current ad sets, live (not the ad_set_meta
// cache, which only refreshes on the hourly engine tick and would miss one
// just created via this same flow moments ago). Used by the add-ad picker.
additionsRouter.get("/ad-sets", requireAuth, async (req, res) => {
  try {
    const ctx = await resolveAdditionContext(pool, (req as AuthedRequest).userId!);
    if (!ctx) return notReady(res);
    const writer = buildAdditionWriter();
    if (!writer) return unavailable(res);
    // AIC-65: never offer a deleted/archived/never-published ad set as a place
    // to add an ad — an ad added there would never deliver.
    const adsets = (await writer.getAdSetMeta(ctx.metaCampaignId)).filter((a) => a.isManaged);
    res.json({ adSets: adsets.map((a) => ({ id: a.adSetId, name: a.name, status: a.status })) });
  } catch (e) {
    console.error("[additions] list ad sets failed", e);
    res.status(502).json({ error: "failed to load ad sets" });
  }
});

// POST /upload — same one-shot-not-idempotent contract as /builder/upload.
additionsRouter.post("/upload", requireAuth, upload.single("file"), async (req, res) => {
  try {
    const ctx = await resolveAdditionContext(pool, (req as AuthedRequest).userId!);
    if (!ctx) return notReady(res);
    const file = req.file;
    if (!file) { res.status(400).json({ error: "no file" }); return; }
    const writer = buildAdditionWriter();
    if (!writer) return unavailable(res);
    const media = await uploadCreativeMedia(writer, ctx.metaAdAccountId, {
      buffer: file.buffer,
      filename: file.originalname,
      mimetype: file.mimetype,
    });
    res.json({ media });
  } catch (e) {
    console.error("[additions] upload failed", e);
    res.status(502).json({ error: "upload failed" });
  }
});

// GET /posts — promotable posts on the connected Page.
additionsRouter.get("/posts", requireAuth, async (req, res) => {
  try {
    const ctx = await resolveAdditionContext(pool, (req as AuthedRequest).userId!);
    if (!ctx) return notReady(res);
    const writer = buildAdditionWriter();
    if (!writer) return unavailable(res);
    const posts = await writer.listPromotablePosts(ctx.pageId);
    res.json({ posts });
  } catch (e) {
    console.error("[additions] list posts failed", e);
    res.status(502).json({ error: "failed to load posts" });
  }
});

interface CreativeBody {
  clientKey?: string;
  name?: string;
  headline?: string;
  primaryText?: string;
  whatsappNumber?: string;
  media?: CreativeMedia;
  postId?: string;
}

// POST /creative — identical validation/idempotency contract as
// /builder/creative, anchored to the EXISTING campaign instead of a fresh shell.
additionsRouter.post("/creative", requireAuth, async (req, res) => {
  try {
    const ctx = await resolveAdditionContext(pool, (req as AuthedRequest).userId!);
    if (!ctx) return notReady(res);
    // Refused BEFORE any Meta call — the creative we'd build carries a
    // WHATSAPP_MESSAGE CTA that this campaign can't use.
    const block = whatsappWriteBlock(ctx);
    if (block) return refuseWhatsappWrite(res, block);
    const body = req.body as CreativeBody;
    if (!body.clientKey || !body.name) { res.status(400).json({ error: "clientKey and name are required" }); return; }

    const writer = buildAdditionWriter();
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
        media: body.media!,
      };
    }
    const creativeId = await createCreativeIdempotent(pool, writer, ctx.localCampaignId, body.clientKey, spec);
    res.json({ creativeId });
  } catch (e) {
    console.error("[additions] create creative failed", e);
    res.status(502).json({ error: "failed to create creative" });
  }
});

interface AddAdBody {
  metaAdSetId?: string;
  name?: string;
  creativeId?: string;
  additionKey?: string;
}

// POST /ad — add one PAUSED ad to an ad set the caller already owns.
// metaAdSetId is re-validated against a fresh live list, never trusted from
// the client — the ownership check the AC requires.
additionsRouter.post("/ad", requireAuth, async (req, res) => {
  try {
    const ctx = await resolveAdditionContext(pool, (req as AuthedRequest).userId!);
    if (!ctx) return notReady(res);
    const body = req.body as AddAdBody;
    if (!body.metaAdSetId || !body.name?.trim() || !body.creativeId || !body.additionKey) {
      res.status(400).json({ error: "metaAdSetId, name, creativeId and additionKey are required" });
      return;
    }

    const writer = buildAdditionWriter();
    if (!writer) return unavailable(res);

    // Ownership + liveness re-check: the ad set must be the caller's AND still
    // a real, managed one (AIC-65) — a client can't target a dead ad set by id
    // even though the picker no longer offers it.
    const ownAdSets = (await writer.getAdSetMeta(ctx.metaCampaignId)).filter((a) => a.isManaged);
    if (!ownAdSets.some((a) => a.adSetId === body.metaAdSetId)) {
      res.status(404).json({ error: "ad set not found" });
      return;
    }

    const result = await addAdToExistingCampaign(pool, writer, {
      localCampaignId: ctx.localCampaignId,
      metaAdAccountId: ctx.metaAdAccountId,
      metaAdSetId: body.metaAdSetId,
      name: body.name,
      creativeId: body.creativeId,
      additionKey: body.additionKey,
    });
    res.json(result);
  } catch (e) {
    console.error("[additions] add ad failed", e);
    res.status(502).json({ error: "failed to add ad" });
  }
});

interface AddAdSetBody {
  name?: string;
  targeting?: { ageMin: number; ageMax: number; genders: "all" | "male" | "female"; countries?: string[] };
  ads?: Array<{ clientKey: string; name: string; creativeId: string }>;
  additionKey?: string;
}

// POST /ad-set — add a new PAUSED ad set + its ads under the EXISTING
// campaign. Never creates a campaign — ctx.metaCampaignId is always the
// caller's already-linked one.
additionsRouter.post("/ad-set", requireAuth, async (req, res) => {
  try {
    const ctx = await resolveAdditionContext(pool, (req as AuthedRequest).userId!);
    if (!ctx) return notReady(res);
    // Refused BEFORE validation and before any Meta call: createAdSet
    // hardcodes CONVERSATIONS/WHATSAPP, which would spend real budget on an
    // ad set whose conversions this campaign can never count.
    const block = whatsappWriteBlock(ctx);
    if (block) return refuseWhatsappWrite(res, block);
    const body = req.body as AddAdSetBody;
    if (!body.name?.trim()) { res.status(400).json({ error: "name is required" }); return; }
    if (!body.targeting) { res.status(400).json({ error: "targeting is required" }); return; }
    if (!Array.isArray(body.ads) || body.ads.length === 0) { res.status(400).json({ error: "at least one ad is required" }); return; }
    if (!body.additionKey) { res.status(400).json({ error: "additionKey is required" }); return; }

    const writer = buildAdditionWriter();
    if (!writer) return unavailable(res);

    const result = await addAdSetToExistingCampaign(pool, writer, {
      localCampaignId: ctx.localCampaignId,
      metaAdAccountId: ctx.metaAdAccountId,
      metaCampaignId: ctx.metaCampaignId,
      pageId: ctx.pageId,
      name: body.name,
      targeting: {
        ageMin: body.targeting.ageMin,
        ageMax: body.targeting.ageMax,
        genders: gendersOf(body.targeting.genders),
        countries: body.targeting.countries?.length ? body.targeting.countries : ["IL"],
      },
      ads: body.ads,
      additionKey: body.additionKey,
    });
    res.json(result);
  } catch (e) {
    console.error("[additions] add ad set failed", e);
    res.status(502).json({ error: "failed to add ad set" });
  }
});

// GET /pending — additions awaiting the customer's approval.
additionsRouter.get("/pending", requireAuth, async (req, res) => {
  try {
    const ctx = await resolveAdditionContext(pool, (req as AuthedRequest).userId!);
    if (!ctx) return notReady(res);
    const pending = await listPendingAdditions(pool, ctx.localCampaignId);
    res.json({ pending });
  } catch (e) {
    console.error("[additions] list pending failed", e);
    res.status(500).json({ error: "failed to load pending additions" });
  }
});

// POST /:id/approve — activate a pending addition (the ad set if kind='ad_set',
// then its ad(s)) — ownership-checked against the caller's own campaign.
additionsRouter.post("/:id/approve", requireAuth, async (req, res) => {
  try {
    const ctx = await resolveAdditionContext(pool, (req as AuthedRequest).userId!);
    if (!ctx) return notReady(res);
    const writer = buildAdditionWriter();
    if (!writer) return unavailable(res);

    const result = await approveAddition(pool, writer, String(req.params.id), ctx.localCampaignId);
    if (result.outcome === "not_found") { res.status(404).json({ error: "addition not found" }); return; }
    res.json(result);
  } catch (e) {
    console.error("[additions] approve failed", e);
    res.status(500).json({ error: "failed to approve" });
  }
});
