import type pg from "pg";
import { WriteOutbox, builderKey, type WriteKind, type CreatingWriter } from "../execution/write-outbox.js";
import type { CreativeWriter, CreativeMedia } from "./creative-types.js";

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
  | { kind: "upload"; adAccountId: string; pageId: string; name: string; headline: string; primaryText: string; whatsappNumber: string; media: CreativeMedia; destination: string }
  | { kind: "existing_post"; adAccountId: string; pageId: string; name: string; postId: string };

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
      ? { adAccountId: spec.adAccountId, pageId: spec.pageId, name: spec.name, headline: spec.headline, primaryText: spec.primaryText, whatsappNumber: spec.whatsappNumber, media: spec.media, destination: spec.destination }
      : { adAccountId: spec.adAccountId, pageId: spec.pageId, name: spec.name, postId: spec.postId };

  return outbox.applyIdempotent(
    {
      idempotencyKey: builderKey(localCampaignId, "create_creative", clientKey),
      campaignId: localCampaignId,
      recommendationId: null,
      kind: "create_creative",
      payload,
    },
    asCreatingWriter(writer, spec),
  );
}
