import { Router } from "express";
import multer from "multer";
import { validateCreativeCopy, MAX_VIDEO_BYTES, FIXED_DESTINATION, WEBSITE_DESTINATION } from "@aic/shared";
import { pool } from "../db/pool.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import {
  resolveAdditionContext, resolveAdditionAvailability, buildAdditionWriter,
  acceptsWhatsappWrites, whatsappWriteBlock, type WhatsappWriteBlock,
  resolveCreativeDestination, type CreativeBlockReason,
} from "../additions/session.js";
import { addAdToExistingCampaign, addAdSetToExistingCampaign, AdSetPageMismatchError } from "../additions/add-content.js";
import { refreshDeliveryNow } from "../services/delivery-monitor.js";
import type { DeliveryReader } from "../meta/delivery-health.js";
import { OpsQueue } from "../services/ops-queue.js";
import { approveAddition, listPendingAdditions } from "../additions/approve.js";
import { createCreativeIdempotent, uploadCreativeMedia, type CreativeSpec } from "../builder/creative-create.js";
import type { CreativeMedia } from "../builder/creative-types.js";
import { gendersOf } from "./builder.js";
import { buildCreativeContext, describeCreativeContext } from "../services/creative-context.js";
import type { AdDetailReader } from "../meta/ad-detail.js";
import { sendTelegram } from "../notify/telegram.js";
import { listPromotableContent } from "../builder/promotable-content.js";
import { respondIfMetaThrottled } from "../meta/throttle-response.js";
import { respondIfMetaRefused } from "../meta/graph-refusal.js";
import { adSetName } from "../meta/naming.js";

// Adding content to a campaign we ALREADY manage (AIC-63) — the everyday
// management action, distinct from the first-time builder (routes/builder.ts):
// the precondition here is the OPPOSITE (an existing, linked campaign
// required), and nothing here ever creates a new campaign. Every route
// resolves the caller's context fresh from their own JWT-scoped rows.
export const additionsRouter = Router();

// AIC-137: the delivery refresh below raises/clears ops items like every other
// caller of refreshDeliveryNow.
const ops = new OpsQueue(pool);

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

// AIC-102 — the /creative route's upload-path refusal. Narrower than
// refuseWhatsappWrite above: by the time this fires, resolveCreativeDestination
// has already decided the campaign COULD take a website-shaped write but is
// missing the one piece of data it needs, not that its destination is
// unsupported outright.
function refuseCreativeWrite(res: import("express").Response, reason: CreativeBlockReason): void {
  res.status(409).json({
    reason,
    error:
      reason === "missing_number"
        ? "we don't have this campaign's WhatsApp number on file, so any ad we " +
          "created would have nowhere to send people. Talk to us and we'll add it."
        : "we don't have this campaign's destination website on file, so any ad we " +
          "created would have nowhere to send people. Talk to us and we'll add it.",
  });
}

// GET /context — the existing campaign's name/category/WhatsApp destination
// (for the add-ad-set audience step's prefill), and whether additions are
// possible right now at all.
additionsRouter.get("/context", requireAuth, async (req, res) => {
  try {
    const availability = await resolveAdditionAvailability(pool, (req as AuthedRequest).userId!);
    if (!availability.ctx) {
      // Same 409 shape as before, plus WHY — resolveAdditionContext alone
      // can't tell "no campaign yet" from "campaign exists but our Meta
      // connection can't support writes right now", and collapsing both
      // into "go build your first campaign" sent a customer with an active,
      // spending campaign into a builder that itself refuses to run because
      // a campaign already exists — a dead end, not a fix.
      res.status(409).json({ error: "additions unavailable", reason: availability.reason });
      return;
    }
    const ctx = availability.ctx;
    // `whatsappDestination` is "" (not null) when this campaign doesn't use
    // WhatsApp — the client prefills a number field from it, and an empty
    // prefill is correct there. `canAddContent` is the honest signal for
    // whether the write routes will accept anything at all.
    //
    // AIC-103: `missingConfigFields` is surfaced even though the screen still
    // loads (deliberately NOT a 409 — see AdditionContext.missingConfigFields)
    // so the customer learns about it on load, before typing a headline into
    // a form that will refuse at submit. Never affects the existing-post
    // path, which needs none of these fields.
    res.json({
      campaignName: ctx.campaignName,
      category: ctx.category,
      whatsappDestination: ctx.whatsappNumber ?? "",
      canAddContent: acceptsWhatsappWrites(ctx),
      missingConfigFields: ctx.missingConfigFields,
    });
  } catch (e) {
    // AIC-168: a throttle is temporary and fixed by waiting — never
    // this route's own generic failure.
    if (respondIfMetaThrottled(res, e)) return;
    console.error("[additions] context failed", e);
    res.status(500).json({ error: "failed to load context" });
  }
});

// ── AIC-78: the creative context ─────────────────────────────────────────────
//
// Everything an ad writer needs to write copy about THIS business rather than
// generic filler: the business facts, and what has already been tried.
//
// Its own route rather than a field on /context, deliberately: assembling it
// makes live Meta reads (one per ad, for the copy), and the form must not wait
// on them. The screen loads, the panel fills in.
//
// Ad ids come from OUR ad_meta rows for the caller's OWN campaign, never from
// the request — so there is no id here for a client to tamper with.
additionsRouter.get("/creative-context", requireAuth, async (req, res) => {
  try {
    const ctx = await resolveAdditionContext(pool, (req as AuthedRequest).userId!);
    if (!ctx) {
      res.status(409).json({ error: "no managed campaign" });
      return;
    }
    const reader = buildAdditionWriter() as AdDetailReader | null;
    const context = await buildCreativeContext(pool, reader, ctx.customerId, ctx.localCampaignId);
    res.json(context);

    // After responding: the notification must never delay or fail the screen.
    void notifyContextOpened(ctx.customerId, context, (req as AuthedRequest).userId!);
  } catch (e) {
    // AIC-168: a throttle is temporary and fixed by waiting — never
    // this route's own generic failure.
    if (respondIfMetaThrottled(res, e)) return;
    console.error("[additions] creative context failed", e);
    res.status(500).json({ error: "failed to load the creative context" });
  }
});

// One message per customer per half hour. The screen is opened, abandoned and
// reopened while someone writes an ad — without this, a single sitting would
// produce a dozen identical messages and the channel would be trained to be
// ignored. In memory on purpose: a redeploy resetting it costs one extra
// message, which is not worth a table.
const CONTEXT_NOTIFY_THROTTLE_MS = 30 * 60 * 1000;
const lastContextNotify = new Map<string, number>();

async function notifyContextOpened(
  customerId: string,
  context: Awaited<ReturnType<typeof buildCreativeContext>>,
  userId: string,
): Promise<void> {
  try {
    const now = Date.now();
    const last = lastContextNotify.get(customerId) ?? 0;
    if (now - last < CONTEXT_NOTIFY_THROTTLE_MS) return;
    lastContextNotify.set(customerId, now);

    const { rows } = await pool.query<{ email: string }>(`SELECT email FROM app_users WHERE id = $1`, [userId]);
    await sendTelegram(
      describeCreativeContext(context, {
        businessName: context.business.businessName,
        email: rows[0]?.email ?? null,
      }),
      { dedupe: true },
    );
  } catch (e) {
    console.error("[additions] creative-context notification failed", (e as Error).message);
  }
}

// GET /ad-sets — the campaign's current ad sets, live (not the ad_set_meta
// cache, which only refreshes on the hourly engine tick and would miss one
// just created via this same flow moments ago). Used by the add-ad picker.
additionsRouter.get("/ad-sets", requireAuth, async (req, res) => {
  try {
    const ctx = await resolveAdditionContext(pool, (req as AuthedRequest).userId!);
    if (!ctx) return notReady(res);
    const writer = buildAdditionWriter();
    if (!writer) return unavailable(res);
    // AIC-65: never offer a DELETED or ARCHIVED ad set as a place to add an ad
    // — an ad added there would never deliver.
    //
    // AIC-130: this used to filter on `isManaged`, which ALSO excludes an ad
    // set with zero ads. Found live: a customer deleted both ads from a live
    // ACTIVE ad set, this returned an empty list, and the add-ad screen said
    // "no ad sets found in the campaign" — leaving no way to put an ad back
    // into a perfectly healthy ad set. An empty ad set is the strongest reason
    // to OFFER it here, not to hide it, so this caller asks the narrower
    // question: does the object exist on Meta?
    const adsets = (await writer.getAdSetMeta(ctx.metaCampaignId)).filter((a) => a.existsOnMeta);
    // AIC-171 — an ADOPTED campaign can hold ad sets on a Facebook Page we are
    // not connected to. Meta refuses an ad whose creative Page differs from
    // its ad set's ("Pages Don't Match"), and we cannot use the ad set's own
    // Page either: our System User has no role on it, so nothing we build can
    // ever go there.
    //
    // Reported live after the customer wrote FOUR ads and pressed submit. Sent
    // now, so the picker can disable it with a reason before any of that work
    // — AIC-98's rule, applied to a list that looked complete and wasn't.
    res.json({
      adSets: adsets.map((a) => ({
        id: a.adSetId,
        name: a.name,
        status: a.status,
        // null = Meta reported no promoted Page; treated as usable rather than
        // blocked, because "it did not say" is not "it said no".
        usable: a.promotedPageId === null || a.promotedPageId === ctx.pageId,
      })),
    });
  } catch (e) {
    // AIC-168: a throttle is temporary and fixed by waiting — never
    // this route's own generic failure.
    if (respondIfMetaThrottled(res, e)) return;
    console.error("[additions] list ad sets failed", e);
    res.status(502).json({ error: "failed to load ad sets" });
  }
});

// GET /page — the connected Page's name and profile photo, for the ad preview
// (AIC-136). Read-only and best-effort: a failure degrades the preview header
// to a neutral placeholder rather than breaking the screen, because a mock-up
// missing an avatar is still a useful mock-up.
additionsRouter.get("/page", requireAuth, async (req, res) => {
  try {
    const ctx = await resolveAdditionContext(pool, (req as AuthedRequest).userId!);
    if (!ctx?.pageId) {
      res.json({ name: null, pictureUrl: null });
      return;
    }
    const reader = buildAdditionWriter() as { getPageIdentity?: (id: string) => Promise<{ name: string | null; pictureUrl: string | null }> } | null;
    if (!reader?.getPageIdentity) {
      res.json({ name: null, pictureUrl: null });
      return;
    }
    res.json(await reader.getPageIdentity(ctx.pageId));
  } catch (e) {
    console.error("[additions] page identity failed", e);
    res.json({ name: null, pictureUrl: null });
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
    // AIC-168: a throttle is temporary and fixed by waiting — never
    // this route's own generic failure.
    if (respondIfMetaThrottled(res, e)) return;
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
    const posts = await listPromotableContent(writer, ctx.pageId, ctx.instagramId);
    res.json({ posts });
  } catch (e) {
    // AIC-168: a throttle is temporary and fixed by waiting — never
    // this route's own generic failure.
    if (respondIfMetaThrottled(res, e)) return;
    console.error("[additions] list posts failed", e);
    res.status(502).json({ error: "failed to load posts" });
  }
});

interface CreativeBody {
  clientKey?: string;
  name?: string;
  headline?: string;
  primaryText?: string;
  media?: CreativeMedia;
  postId?: string;
  postSource?: "facebook" | "instagram"; // AIC-156
}

// POST /creative — identical validation/idempotency contract as
// /builder/creative, anchored to the EXISTING campaign instead of a fresh shell.
additionsRouter.post("/creative", requireAuth, async (req, res) => {
  try {
    const ctx = await resolveAdditionContext(pool, (req as AuthedRequest).userId!);
    if (!ctx) return notReady(res);
    const body = req.body as CreativeBody;
    if (!body.clientKey || !body.name) { res.status(400).json({ error: "clientKey and name are required" }); return; }

    const writer = buildAdditionWriter();
    if (!writer) return unavailable(res);

    let spec: CreativeSpec;
    if (body.postId) {
      // AIC-102 said this path "carries NO destination fields at all" because
      // Meta reuses whatever CTA the post already has. That is what happens
      // when you send nothing — but AIC-115 (2026-08-23) showed it was
      // mistaken for a LIMIT: a plain photo post has no CTA, so a
      // click-to-WhatsApp ad built from it is refused as "incompatible with
      // the objective". Meta does accept a call_to_action alongside
      // object_story_id (probed live; it persists).
      //
      // Best-effort on purpose. If the campaign's destination is resolvable we
      // attach its CTA; if it is BLOCKED (e.g. a website campaign with no
      // website_url on file) we fall back to today's post-as-is behaviour
      // rather than refusing. That matters: free_beta_signups_leads is exactly
      // that shape, its posts are link shares carrying their own CTA, and
      // adding an ad from one works today. Requiring a destination here would
      // break a working path to fix a different one.
      const postDestination = resolveCreativeDestination(ctx);
      spec = {
        kind: "existing_post", adAccountId: ctx.metaAdAccountId, pageId: ctx.pageId,
        name: body.name, postId: body.postId,
        // AIC-156 — which network this post came from selects the Meta
        // payload (object_story_id vs object_id + source_instagram_media_id),
        // and the IG identity is what makes the ad run as the customer.
        postSource: body.postSource ?? "facebook",
        instagramUserId: ctx.instagramId,
        ...(postDestination.kind === "whatsapp"
          ? { destination: FIXED_DESTINATION, whatsappNumber: postDestination.number }
          : postDestination.kind === "website"
            ? { destination: WEBSITE_DESTINATION, destinationUrl: postDestination.url }
            : {}),
      };
    } else {
      // The new-content path DOES need a destination — refused BEFORE any
      // Meta call if this campaign has neither a WhatsApp number nor a
      // website URL on file for its lead type.
      const destination = resolveCreativeDestination(ctx);
      if (destination.kind === "blocked") return refuseCreativeWrite(res, destination.reason);

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
        whatsappNumber: destination.kind === "whatsapp" ? destination.number : "",
        destinationUrl: destination.kind === "website" ? destination.url : undefined,
        media: body.media!,
        destination: destination.kind === "whatsapp" ? FIXED_DESTINATION : WEBSITE_DESTINATION,
      };
    }
    const creativeId = await createCreativeIdempotent(pool, writer, ctx.localCampaignId, body.clientKey, spec);
    res.json({ creativeId });
  } catch (e) {
    // AIC-168: a throttle is temporary and fixed by waiting — never
    // this route's own generic failure.
    if (respondIfMetaThrottled(res, e)) return;
    // AIC-174: Meta refused with a sentence written for a person — show it,
    // never this route's own generic failure. Always AFTER the throttle,
    // which is transient and has its own status code and copy.
    if (respondIfMetaRefused(res, e)) return;
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
    // a real one (AIC-65) — a client can't target a deleted ad set by id even
    // though the picker no longer offers it.
    //
    // AIC-130: this must use the SAME predicate as the picker above. When the
    // picker moved to `existsOnMeta` and this stayed on `isManaged`, an empty
    // ad set would be offered and then refused with a bare 404 at submit —
    // trading one dead end for a worse one, since the customer would only hit
    // it after building the creatives.
    const ownAdSets = (await writer.getAdSetMeta(ctx.metaCampaignId)).filter((a) => a.existsOnMeta);
    if (!ownAdSets.some((a) => a.adSetId === body.metaAdSetId)) {
      res.status(404).json({ error: "ad set not found" });
      return;
    }

    const result = await addAdToExistingCampaign(pool, writer, {
      localCampaignId: ctx.localCampaignId,
      metaAdAccountId: ctx.metaAdAccountId,
      metaCampaignId: ctx.metaCampaignId,
      metaAdSetId: body.metaAdSetId,
      pageId: ctx.pageId,
      name: body.name,
      creativeId: body.creativeId,
      additionKey: body.additionKey,
      actor: "customer",
    });
    await refreshAfterAdd(ctx, writer);
    res.json(result);
  } catch (e) {
    // AIC-168: a throttle is temporary and fixed by waiting — never
    // this route's own generic failure.
    if (respondIfMetaThrottled(res, e)) return;
    // AIC-174: Meta refused with a sentence written for a person — show it,
    // never this route's own generic failure. Always AFTER the throttle,
    // which is transient and has its own status code and copy.
    if (respondIfMetaRefused(res, e)) return;
    // AIC-171: our precondition, not Meta breaking — 409 with a reason the
    // customer can act on, never a raw "Pages Don't Match" inside a 502.
    if (e instanceof AdSetPageMismatchError) {
      res.status(409).json({ error: e.message, code: "adset_page_mismatch" });
      return;
    }
    console.error("[additions] add ad failed", e);
    res.status(502).json({ error: "failed to add ad" });
  }
});

interface AddAdSetBody {
  name?: string;
  targeting?: { ageMin: number; ageMax: number; genders: "all" | "male" | "female"; countries?: string[]; cities?: Array<{ key: string; name: string; type: "city" | "region" }> };
  ads?: Array<{ clientKey: string; name: string; creativeId: string }>;
  additionKey?: string;
}

// AIC-137, found live: after adding two ads the dashboard headline still read
// "אין כרגע מודעות שמוצגות ללקוחות · כל קבוצות הפרסום מושהות" while the
// campaign, its ad set and both new ads were all ACTIVE on Meta. The
// delivery/homeState cache is only recomputed on the hourly tick and by the
// write paths that explicitly ask for it — pause/resume (AIC-71) and launch
// approval. Adding content was the remaining one that skipped it.
//
// delivery-monitor's own doc comment predicts this symptom for exactly that
// omission; this is the third write path to need the same line, which is a
// hint the refresh belongs closer to the writes than to each route.
//
// Isolated: a refresh failure must not turn a successful addition into an
// error response. The ads exist either way, and the headline self-corrects on
// the next tick.
async function refreshAfterAdd(
  ctx: { localCampaignId: string; customerId: string | null; metaCampaignId: string },
  writer: unknown,
): Promise<void> {
  try {
    await refreshDeliveryNow({
      pool, ops,
      deliveryReader: writer as DeliveryReader,
      campaignId: ctx.localCampaignId,
      customerId: ctx.customerId,
      metaCampaignId: ctx.metaCampaignId,
    });
  } catch (e) {
    console.error("[additions] delivery refresh after add failed", e);
  }
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
    // AIC-172: the name is OPTIONAL now. Blank derives the same convention
    // every ad set we create already uses (naming.ts) — see below.
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
      // AIC-172 — typed name wins; blank derives the audience label, which is
      // the SAME convention adSetName gives every ad set we build (AIC-154),
      // and the same string the dashboard shows for that audience. Asking a
      // customer to invent an internal label for something we can already name
      // correctly is a required field that earns nothing.
      name: body.name?.trim() || adSetName({
        ageMin: body.targeting.ageMin,
        ageMax: body.targeting.ageMax,
        genders: body.targeting.genders,
        countries: body.targeting.countries?.length ? body.targeting.countries : ["IL"],
        cities: body.targeting.cities,
      }),
      targeting: {
        ageMin: body.targeting.ageMin,
        ageMax: body.targeting.ageMax,
        genders: gendersOf(body.targeting.genders),
        countries: body.targeting.countries?.length ? body.targeting.countries : ["IL"],
        // AIC-157 — the same control the builder has. Two screens creating ad
        // sets with different targeting powers is exactly the divergence
        // AIC-155 was.
        cities: body.targeting.cities ?? [],
      },
      ads: body.ads,
      additionKey: body.additionKey,
      actor: "customer",
    });
    res.json(result);
  } catch (e) {
    // AIC-168: a throttle is temporary and fixed by waiting — never
    // this route's own generic failure.
    if (respondIfMetaThrottled(res, e)) return;
    // AIC-174: Meta refused with a sentence written for a person — show it,
    // never this route's own generic failure. Always AFTER the throttle,
    // which is transient and has its own status code and copy.
    if (respondIfMetaRefused(res, e)) return;
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
    // AIC-168: a throttle is temporary and fixed by waiting — never
    // this route's own generic failure.
    if (respondIfMetaThrottled(res, e)) return;
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
    // AIC-168: a throttle is temporary and fixed by waiting — never
    // this route's own generic failure.
    if (respondIfMetaThrottled(res, e)) return;
    // AIC-174: Meta refused with a sentence written for a person — show it,
    // never this route's own generic failure. Always AFTER the throttle,
    // which is transient and has its own status code and copy.
    if (respondIfMetaRefused(res, e)) return;
    console.error("[additions] approve failed", e);
    res.status(500).json({ error: "failed to approve" });
  }
});
