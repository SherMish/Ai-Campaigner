import type pg from "pg";
import { WriteOutbox, builderKey, type WriteKind, type CreatingWriter } from "../execution/write-outbox.js";
import type { CreativeWriter, CreativeMedia } from "./creative-types.js";
import { recordCreatedCreative } from "../services/creative-reaper.js";

// The creative-handling create step (AIC-51), idempotent the same way AIC-50's
// campaign/ad-set/ad creates are — a resubmitted creative step must never
// create a second ad creative on Meta.

export type UploadedMedia =
  | { kind: "image"; imageHash: string }
  | { kind: "video"; videoId: string; thumbnailUrl: string };

// Uploading the file itself is deliberately NOT wrapped in the idempotent
// outbox: the raw file buffer only exists for the lifetime of this one HTTP
// request, so there's nothing durable to resume a retry from (unlike the
// small, deterministic JSON payloads every other create-write uses). If an
// upload fails, the customer/operator just re-uploads — the same UX as any
// ordinary file upload, and Meta's own upload endpoints are naturally safe to
// retry (a failed upload never lands on Meta's side to begin with).
export async function uploadCreativeMedia(
  writer: CreativeWriter,
  adAccountId: string,
  file: { buffer: Buffer; filename: string; mimetype: string },
): Promise<UploadedMedia> {
  if (file.mimetype.startsWith("video/")) {
    const v = await writer.uploadVideo(adAccountId, file.buffer, file.filename);
    return { kind: "video", videoId: v.videoId, thumbnailUrl: v.thumbnailUrl };
  }
  const img = await writer.uploadImage(adAccountId, file.buffer, file.filename);
  return { kind: "image", imageHash: img.hash };
}

export type CreativeSpec =
  | { kind: "upload"; adAccountId: string; pageId: string; name: string; headline: string; primaryText: string; whatsappNumber: string; destinationUrl?: string; media: CreativeMedia; destination: string }
  // AIC-115 fix (2026-08-23): an existing-post creative needs the campaign's
  // CTA too, or Meta refuses the AD as "incompatible with the objective".
  // Optional so an engagement campaign (no ctaType) simply omits them.
  | { kind: "existing_post"; adAccountId: string; pageId: string; name: string; postId: string;
      destination?: string; whatsappNumber?: string; destinationUrl?: string };

function asCreatingWriter(writer: CreativeWriter, spec: CreativeSpec): CreatingWriter {
  return {
    async create(_kind: WriteKind, payload: Record<string, unknown>): Promise<{ metaId: string }> {
      const metaId = spec.kind === "upload"
        ? await writer.createCreativeFromUpload(payload as never)
        : await writer.createCreativeFromExistingPost(payload as never);
      return { metaId };
    },
  };
}

// clientKey must be stable across a resubmission of the same builder session
// (e.g. "adset-1-ad-1"), exactly like BuildCampaignInput's ad clientKeys —
// callers typically use the SAME key here as the ad it's destined for.
export async function createCreativeIdempotent(
  pool: pg.Pool,
  writer: CreativeWriter,
  localCampaignId: string,
  clientKey: string,
  spec: CreativeSpec,
): Promise<string> {
  const outbox = new WriteOutbox(pool);
  const payload: Record<string, unknown> =
    spec.kind === "upload"
      ? { adAccountId: spec.adAccountId, pageId: spec.pageId, name: spec.name, headline: spec.headline, primaryText: spec.primaryText, whatsappNumber: spec.whatsappNumber, destinationUrl: spec.destinationUrl, media: spec.media, destination: spec.destination }
      : { adAccountId: spec.adAccountId, pageId: spec.pageId, name: spec.name, postId: spec.postId,
          destination: spec.destination, whatsappNumber: spec.whatsappNumber, destinationUrl: spec.destinationUrl };

  const creativeId = await outbox.applyIdempotent(
    {
      idempotencyKey: builderKey(localCampaignId, "create_creative", clientKey),
      campaignId: localCampaignId,
      recommendationId: null,
      kind: "create_creative",
      payload,
    },
    asCreatingWriter(writer, spec),
  );

  // AIC-131: recorded HERE because this is the single funnel every creative
  // goes through — the customer builder, the add-content flow and the admin
  // builder all call it. Recording in the three routes instead would leave the
  // leak open the moment a fourth caller appears, which is exactly how the
  // isManaged filter ended up wrong at three separate call sites.
  //
  // Best-effort: a bookkeeping failure must never fail a creative the customer
  // has already successfully created on Meta. The cost of missing a row is one
  // creative the reaper won't clean up — the same state as before this existed.
  try {
    await recordCreatedCreative(pool, creativeId, spec.adAccountId, localCampaignId);
  } catch (e) {
    console.error(`[creative] failed to record ${creativeId} for reaping — ${(e as Error).message}`);
  }
  return creativeId;
}
